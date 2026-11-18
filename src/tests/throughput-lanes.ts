/**
 * A lane is a group of throughput sockets that generate traffic and count bytes. Lanes only
 * use the WebSocket API (raw TCP sockets from `openSocket` share it), so the same code runs
 * on the calling thread or inside a worker thread. The throughput runners own timing, snapshots, and results; lanes only move
 * bytes.
 */

import { SpeedTestError, getFailureReasonOr } from '../utils/failure.js';
import {
  DOWNLOAD_BATCH_MESSAGES,
  MAX_UPLOAD_CHUNK_SIZE_KB,
  RATE_WINDOW_MS,
  RateMeter,
  UPLOAD_CHUNK_SIZES_KB,
  getDownloadRefillMessages,
  getNextDownloadMessageSizeKb,
  getUploadChunkSizeForSpeedKb,
  nearestSizeKb,
} from '../utils/adaptive.js';
import { supportsPayloadProgress } from './payload-progress.js';
import { SOCKET_CLOSED, SOCKET_OPEN, openSocket, sendZeroFilled } from './sockets.js';

export interface ThroughputLaneOptions {
  serverUrl: string;
  connectionCount: number;
  /**
   * The first message size, in KiB: download sockets' first batch, upload sockets' first chunk.
   * Each socket then sizes its messages from its own speed (`docs/protocol.md`, "Message sizes").
   */
  messageSizeKb: number;
  /** The minimum latency, in ms: sockets keep two round trips of data requested or in flight. */
  latencyMs?: number;
  /** Index of this lane's first socket across all lanes, used in error messages. */
  firstSocketIndex?: number;
  /** `false` opens WebSockets with `globalThis.WebSocket`, not the Node.js client. See `SpeedTestConfig.nodeWebSocket`. */
  nodeWebSocket?: boolean;
}

export interface ThroughputLaneCallbacks {
  /** Every socket the lane opened with is open. */
  onOpen: () => void;
  /** A socket failed before the lane opened. */
  onError: (error: Error) => void;
  /**
   * Bytes were counted; `bytes` is the lane's total. Lanes on the calling thread report every
   * change, lanes on worker threads only their first bytes.
   */
  onBytes?: (bytes: number) => void;
  /**
   * The sockets of `addConnections(…, scaleUpId)` settled: each counted its first bytes or
   * failed, or `SCALE_UP_SETTLE_MS` passed. `opened` is how many of them opened.
   */
  onScaleUpSettled?: (scaleUpId: number, opened: number) => void;
  /** A socket added during the stage opened, whenever it did (also after its scale-up settled). */
  onConnectionAdded?: () => void;
}

export interface ThroughputLane {
  /** Starts traffic on every socket. */
  start(): void;
  /**
   * The stage ended: ask the server for nothing more (no download refill), but keep the sockets
   * open and the traffic already requested flowing, so the link stays loaded until `close()`.
   */
  stopRequests(): void;
  /** Stops traffic and closes every socket. */
  close(): void;
  /**
   * Opens `count` more sockets during the stage (the scale-up). Each starts traffic as soon as it
   * opens, its first message `messageSizeKb`. One that fails is dropped without failing the
   * stage. Reported through `onScaleUpSettled`.
   */
  addConnections(count: number, messageSizeKb: number, scaleUpId: number): void;
  /** Bytes received (download) or acknowledged by the server (upload) so far. */
  readonly bytes: number;
  /** Sockets the lane asked for, including the ones it added. */
  readonly connectionCount: number;
  /** Sockets that opened: the lane's first ones and the added ones that opened so far. */
  readonly openedConnectionCount: number;
}

export type ThroughputDirection = 'download' | 'upload';

/** Added sockets settle at most this long after they were asked for, opened or not. */
export const SCALE_UP_SETTLE_MS = 1000;
const UPLOAD_REFILL_INTERVAL_MS = 5;
/** Longest a timer refill may spend sending before yielding to other work. */
const UPLOAD_REFILL_BUDGET_MS = 4;
/**
 * Unacknowledged upload data a socket may have: 64 of its chunks, or `UPLOAD_IN_FLIGHT_ROUND_TRIPS`
 * round trips of its acknowledged speed, whichever is more (see `getUploadInFlightLimitBytes`).
 */
export const MAX_UNACKED_UPLOAD_CHUNKS = 64;
export const UPLOAD_IN_FLIGHT_ROUND_TRIPS = 8;
/**
 * The most unacknowledged upload data a socket may have, however fast: 64 chunks of 1 MiB, the
 * bound this library always had (1.7 Gbps per socket at a 300 ms round trip). It also bounds
 * memory with WebSocket implementations that do not report `bufferedAmount`.
 */
export const MAX_UPLOAD_IN_FLIGHT_BYTES = 64 * 1024 * 1024;
/** The shortest round trip the in-flight limit assumes. */
const MIN_IN_FLIGHT_ROUND_TRIP_MS = 50;

/**
 * Closes every socket. With `abortServerStream`, each open socket first sends `CLOSE`, which
 * makes the server terminate the connection at once. Otherwise a graceful close waits behind
 * every frame the server has already queued, and on a slow link those frames keep using the
 * downlink long after the stage ended, starving the stages that follow.
 */
function closeSockets(sockets: Iterable<WebSocket>, abortServerStream = false): void {
  for (const socket of sockets) {
    try {
      if (abortServerStream && socket.readyState === SOCKET_OPEN) socket.send('CLOSE');
      if (socket.readyState !== SOCKET_CLOSED) socket.close();
    } catch {
      // ignore
    }
  }
}

interface LaneSockets {
  readonly all: WebSocket[];
  /** The first sockets and the added ones that opened. */
  readonly opened: number;
  /**
   * Opens `count` sockets added during the stage, set up like the others, and reports them
   * through `onScaleUpSettled`. `onOpen` runs as each one opens.
   */
  add(count: number, scaleUpId: number, onOpen: (socket: WebSocket) => void): WebSocket[];
  /** The socket counted its first bytes: an added socket settles. */
  counted(socket: WebSocket): void;
  closeAll(abortServerStream: boolean): void;
}

/**
 * Opens the lane's sockets and reports `onOpen` once all of them are connected. Sockets added
 * later never fail the lane: one that can't open is dropped.
 */
function connectLane(
  direction: ThroughputDirection,
  options: ThroughputLaneOptions,
  callbacks: ThroughputLaneCallbacks,
  isClosed: () => boolean,
  setup: (socket: WebSocket) => void
): LaneSockets {
  const sockets: WebSocket[] = [];
  const firstIndex = options.firstSocketIndex ?? 0;
  const label = direction === 'download' ? 'Download' : 'Upload';
  let connectedCount = 0;
  let opened = false;

  const create = (index: number): WebSocket => {
    let socket: WebSocket;
    try {
      socket = openSocket(options.serverUrl, { nodeWebSocket: options.nodeWebSocket });
    } catch (error) {
      throw new SpeedTestError(
        getFailureReasonOr(error, 'connectionFailed'),
        `Failed to create ${direction} WebSocket ${index}: ${error}`
      );
    }
    socket.binaryType = 'arraybuffer';
    return socket;
  };

  for (let i = 0; i < options.connectionCount; i++) {
    const index = firstIndex + i;
    let socket: WebSocket;
    try {
      socket = create(index);
    } catch (error) {
      closeSockets(sockets);
      throw error;
    }

    socket.onopen = () => {
      connectedCount++;
      if (connectedCount === options.connectionCount && !opened && !isClosed()) {
        opened = true;
        callbacks.onOpen();
      }
    };

    socket.onerror = () => {
      if (!opened && !isClosed()) {
        callbacks.onError(new SpeedTestError('connectionFailed', `${label} WebSocket connection ${index} failed`));
      }
    };

    socket.onclose = () => {
      // handled by the runner's timer
    };

    setup(socket);
    sockets.push(socket);
  }

  /** Added sockets still to settle, by scale-up. */
  let addedOpened = 0;
  const settling = new Map<
    number,
    { waiting: Set<WebSocket>; opened: number; timer: ReturnType<typeof setTimeout> }
  >();
  const scaleUpOf = new Map<WebSocket, number>();

  const settleIfDone = (scaleUpId: number, force = false) => {
    const entry = settling.get(scaleUpId);
    if (!entry || (!force && entry.waiting.size > 0)) return;
    clearTimeout(entry.timer);
    settling.delete(scaleUpId);
    for (const socket of entry.waiting) scaleUpOf.delete(socket);
    if (!isClosed()) callbacks.onScaleUpSettled?.(scaleUpId, entry.opened);
  };

  const leave = (socket: WebSocket) => {
    const scaleUpId = scaleUpOf.get(socket);
    if (scaleUpId === undefined) return;
    scaleUpOf.delete(socket);
    settling.get(scaleUpId)?.waiting.delete(socket);
    settleIfDone(scaleUpId);
  };

  return {
    all: sockets,
    get opened() {
      return options.connectionCount + addedOpened;
    },
    add(count, scaleUpId, onOpen) {
      const entry = {
        waiting: new Set<WebSocket>(),
        opened: 0,
        timer: setTimeout(() => settleIfDone(scaleUpId, true), SCALE_UP_SETTLE_MS),
      };
      settling.set(scaleUpId, entry);
      const added: WebSocket[] = [];
      for (let i = 0; i < count; i++) {
        let socket: WebSocket;
        try {
          socket = create(firstIndex + sockets.length);
        } catch {
          continue;
        }
        setup(socket);
        socket.onopen = () => {
          if (isClosed()) return;
          if (settling.get(scaleUpId) === entry) entry.opened++;
          addedOpened++;
          callbacks.onConnectionAdded?.();
          onOpen(socket);
        };
        // An added socket that fails is dropped; the stage goes on with the others.
        socket.onerror = () => leave(socket);
        socket.onclose = () => leave(socket);
        sockets.push(socket);
        added.push(socket);
        entry.waiting.add(socket);
        scaleUpOf.set(socket, scaleUpId);
      }
      settleIfDone(scaleUpId);
      return added;
    },
    counted(socket) {
      if (scaleUpOf.size > 0) leave(socket);
    },
    closeAll(abortServerStream) {
      for (const entry of settling.values()) clearTimeout(entry.timer);
      settling.clear();
      scaleUpOf.clear();
      closeSockets(sockets, abortServerStream);
    },
  };
}

interface DownloadSocketState {
  /** Messages requested and not yet received. */
  outstanding: number;
  /** The message size of the next or last request, in KiB. */
  sizeKb: number;
  bytes: number;
  messages: number;
  byteRate: RateMeter;
  messageRate: RateMeter;
  counted: boolean;
}

/**
 * Download lane. Each socket requests batches of `START <kb> 200` and keeps a running total of
 * the messages it has requested but not yet received. It asks for the next batch while enough
 * is still due to cover two round trips (at least 300 ms) at its message rate, so the server
 * always has data queued, and never has more than two batches outstanding. Each batch's messages
 * hold about 10 ms of the socket's speed over the last 500 ms (`getNextDownloadMessageSizeKb`),
 * so they grow on a fast link and shrink on a slow one. The server sends overlapping batches at
 * once, so their messages interleave and differ in size; only the running total matters.
 * Messages beyond everything requested, and messages after the lane closed, are not counted.
 *
 * Sockets that report payload bytes as they arrive (`onpayloadprogress`: raw TCP and the
 * Node.js WebSocket client) are counted that way, so snapshots and the end of the stage include
 * the messages still arriving, as in the native libraries. Other sockets (browsers) are counted
 * per whole message.
 */
export function openDownloadLane(
  options: ThroughputLaneOptions,
  callbacks: ThroughputLaneCallbacks
): ThroughputLane {
  let bytes = 0;
  let closed = false;
  let started = false;
  let requestsStopped = false;
  const latencyMs = options.latencyMs ?? 0;
  const states = new Map<WebSocket, DownloadSocketState>();

  const newState = (sizeKb: number): DownloadSocketState => ({
    outstanding: 0,
    sizeKb,
    bytes: 0,
    messages: 0,
    byteRate: new RateMeter(),
    messageRate: new RateMeter(),
    counted: false,
  });

  const sendDownloadRequest = (socket: WebSocket, state: DownloadSocketState, sizeKb: number) => {
    if (closed || requestsStopped || socket.readyState !== SOCKET_OPEN) return;
    // Counted before sending, so a message handled during send() already sees the request.
    state.outstanding += DOWNLOAD_BATCH_MESSAGES;
    state.sizeKb = sizeKb;
    socket.send(`START ${sizeKb} ${DOWNLOAD_BATCH_MESSAGES}`);
  };

  const count = (socket: WebSocket, state: DownloadSocketState, received: number) => {
    bytes += received;
    state.bytes += received;
    state.byteRate.record(performance.now(), state.bytes);
    if (!state.counted) {
      state.counted = true;
      laneSockets.counted(socket);
    }
    callbacks.onBytes?.(bytes);
  };

  let nextSizeKb = options.messageSizeKb;
  const laneSockets = connectLane('download', options, callbacks, () => closed, (socket) => {
    const state = newState(nextSizeKb);
    states.set(socket, state);
    // Every byte of a message is reported before its message event, while it is still due.
    const countsAsBytesArrive = supportsPayloadProgress(socket);
    if (countsAsBytesArrive) {
      socket.onpayloadprogress = (received) => {
        if (closed || state.outstanding <= 0) return;
        count(socket, state, received);
      };
    }

    socket.onmessage = (event) => {
      if (closed || !(event.data instanceof ArrayBuffer)) return;
      if (state.outstanding <= 0) return;

      if (!countsAsBytesArrive) count(socket, state, event.data.byteLength);
      state.outstanding--;
      state.messages++;
      const now = performance.now();
      state.messageRate.record(now, state.messages);

      const messagesPerSecond = state.messageRate.ratePerSecond(now, state.messages);
      if (state.outstanding <= getDownloadRefillMessages(messagesPerSecond, latencyMs)) {
        const mbps = state.byteRate.mbps(now, state.bytes);
        sendDownloadRequest(socket, state, getNextDownloadMessageSizeKb(state.sizeKb, mbps));
      }
    };
  });

  return {
    start() {
      started = true;
      for (const socket of laneSockets.all) {
        const state = states.get(socket)!;
        sendDownloadRequest(socket, state, state.sizeKb);
      }
    },
    stopRequests() {
      requestsStopped = true;
    },
    close() {
      closed = true;
      laneSockets.closeAll(true);
    },
    addConnections(count, messageSizeKb, scaleUpId) {
      if (closed || requestsStopped) return;
      nextSizeKb = messageSizeKb;
      laneSockets.add(count, scaleUpId, (socket) => {
        const state = states.get(socket)!;
        if (started) sendDownloadRequest(socket, state, state.sizeKb);
      });
    },
    get bytes() {
      return bytes;
    },
    get connectionCount() {
      return laneSockets.all.length;
    },
    get openedConnectionCount() {
      return laneSockets.opened;
    },
  };
}

interface UploadSocketState {
  /** The chunk size this socket sends, in KiB. */
  sizeKb: number;
  /** Sizes of the chunks sent and not yet acknowledged, oldest first from `unackedHead`. */
  unacked: number[];
  unackedHead: number;
  unackedBytes: number;
  acked: number;
  rate: RateMeter;
  resizedAt: number;
  counted: boolean;
}

/**
 * The next upload chunk size for a socket that acknowledged `mbps` over the last 500 ms (null:
 * not known yet, keep `sizeKb`): about 10 ms of it.
 */
export function getNextUploadChunkSizeKb(sizeKb: number, mbps: number | null): number {
  return mbps === null ? sizeKb : getUploadChunkSizeForSpeedKb(mbps);
}

/**
 * The unacknowledged bytes a socket may have: 64 of its current chunks, or 8 round trips (at the
 * minimum latency, at least 50 ms) of the speed it acknowledged over the last 500 ms, whichever
 * is more, at most 64 MiB. The chunks stay small, so the gauge moves smoothly on a slow link, while the data in
 * flight follows the link: a socket held back by the limit acknowledges about 8 round trips' worth
 * per round trip, so the limit grows about 8 times per round trip until the link is the limit. On
 * a slow link whose buffers hold whatever is sent, it stays near 8 round trips, so the queue
 * left when the stage ends stays small. With 64 chunks alone, a connection that started on 1 KiB
 * chunks had 64 KiB in flight, 1.7 Mbps at a 300 ms round trip.
 */
export function getUploadInFlightLimitBytes(chunkBytes: number, mbps: number | null, latencyMs: number): number {
  const byChunks = MAX_UNACKED_UPLOAD_CHUNKS * chunkBytes;
  if (mbps === null) return byChunks;
  const roundTripMs = Math.max(latencyMs, MIN_IN_FLIGHT_ROUND_TRIP_MS);
  const bySpeed = Math.min(Math.ceil(mbps * 125 * UPLOAD_IN_FLIGHT_ROUND_TRIPS * roundTripMs), MAX_UPLOAD_IN_FLIGHT_BYTES);
  return Math.max(byChunks, bySpeed);
}

/** `kb` as an upload chunk size: a power of two from 1 KiB to 1 MiB. */
function toUploadChunkSizeKb(kb: number): number {
  return nearestSizeKb(Math.min(kb, MAX_UPLOAD_CHUNK_SIZE_KB), UPLOAD_CHUNK_SIZES_KB);
}

/**
 * Upload lane. Each socket's send buffer is kept topped up to a target size, after
 * acknowledgements arrive and on a short timer as a fallback since the WebSocket API has no
 * drain event. Each socket's chunks hold about 10 ms of its acknowledged speed, resized every
 * 500 ms (`getNextUploadChunkSizeKb`), at most 1 MiB; one preallocated chunk per size is shared
 * by the sockets. Bytes count once the server acknowledges a chunk; each `ACK` credits the oldest
 * unacknowledged chunk, since their sizes differ.
 *
 * Unacknowledged data per socket is capped as well (`getUploadInFlightLimitBytes`), so memory
 * stays bounded with WebSocket implementations that do not report `bufferedAmount`, and so a slow
 * link doesn't queue more than it needs. A refill stops after a few
 * milliseconds of work, and acknowledgements that arrive together share one refill, so a CPU
 * bound client still services snapshots and latency probes on time.
 */
export function openUploadLane(
  options: ThroughputLaneOptions,
  callbacks: ThroughputLaneCallbacks
): ThroughputLane {
  let bytes = 0;
  let closed = false;
  let started = false;
  let refillTimer: ReturnType<typeof setInterval> | null = null;
  const latencyMs = options.latencyMs ?? 0;
  const chunks = new Map<number, Uint8Array>();
  const states = new Map<WebSocket, UploadSocketState>();

  const chunkOf = (sizeKb: number): Uint8Array => {
    let chunk = chunks.get(sizeKb);
    if (!chunk) chunks.set(sizeKb, (chunk = new Uint8Array(sizeKb * 1024)));
    return chunk;
  };

  const unackedCount = (state: UploadSocketState) => state.unacked.length - state.unackedHead;

  /** Sends up to the socket's buffer target. Returns false once `deadline` has passed. */
  const fill = (socket: WebSocket, deadline = Infinity): boolean => {
    const state = states.get(socket);
    if (!state || closed || !started || socket.readyState !== SOCKET_OPEN) return true;
    const now = performance.now();
    const mbps = state.rate.mbps(now, state.acked);
    if (now - state.resizedAt >= RATE_WINDOW_MS) {
      state.sizeKb = getNextUploadChunkSizeKb(state.sizeKb, mbps);
      state.resizedAt = now;
    }
    const chunk = chunkOf(state.sizeKb);
    const bufferTargetBytes = getUploadBufferTargetBytes(chunk.byteLength);
    const maxChunks = Math.ceil(bufferTargetBytes / chunk.byteLength);
    let withinBudget = true;
    try {
      // Counted in bytes, so a socket that shrank its chunks adds no more behind the larger ones
      // still in flight
      const maxUnackedBytes = getUploadInFlightLimitBytes(chunk.byteLength, mbps, latencyMs);
      for (
        let sent = 0;
        sent < maxChunks &&
        state.unackedBytes + chunk.byteLength <= maxUnackedBytes &&
        socket.bufferedAmount < bufferTargetBytes;
        sent++
      ) {
        sendZeroFilled(socket, chunk);
        state.unacked.push(chunk.byteLength);
        state.unackedBytes += chunk.byteLength;
        if (performance.now() > deadline) {
          withinBudget = false;
          break;
        }
      }
    } catch {
      // ignore send errors; the socket is closing
    }
    return withinBudget;
  };

  let nextSizeKb = toUploadChunkSizeKb(options.messageSizeKb);
  const laneSockets = connectLane('upload', options, callbacks, () => closed, (socket) => {
    const state: UploadSocketState = {
      sizeKb: nextSizeKb,
      unacked: [],
      unackedHead: 0,
      unackedBytes: 0,
      acked: 0,
      rate: new RateMeter(),
      resizedAt: performance.now(),
      counted: false,
    };
    states.set(socket, state);
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string' || event.data !== 'ACK') return;
      if (unackedCount(state) === 0) return;
      const chunkBytes = state.unacked[state.unackedHead++];
      if (state.unackedHead >= 1024) {
        state.unacked = state.unacked.slice(state.unackedHead);
        state.unackedHead = 0;
      }
      state.unackedBytes -= chunkBytes;
      bytes += chunkBytes;
      state.acked += chunkBytes;
      state.rate.record(performance.now(), state.acked);
      if (!state.counted) {
        state.counted = true;
        laneSockets.counted(socket);
      }
      callbacks.onBytes?.(bytes);
      scheduleRefill();
    };
  });

  let refillScheduled = false;
  const scheduleRefill = () => {
    if (refillScheduled) return;
    refillScheduled = true;
    queueMicrotask(() => {
      refillScheduled = false;
      fillAll();
    });
  };

  let nextSocket = 0;
  const fillAll = () => {
    const sockets = laneSockets.all;
    const deadline = performance.now() + UPLOAD_REFILL_BUDGET_MS;
    for (let i = 0; i < sockets.length; i++) {
      const socket = sockets[(nextSocket + i) % sockets.length];
      if (!fill(socket, deadline)) {
        // Resume with the next socket on the following tick.
        nextSocket = (nextSocket + i + 1) % sockets.length;
        return;
      }
    }
  };

  return {
    start() {
      started = true;
      const now = performance.now();
      for (const state of states.values()) state.resizedAt = now;
      refillTimer = setInterval(fillAll, UPLOAD_REFILL_INTERVAL_MS);
      fillAll();
    },
    // Upload sends no requests to stop; it keeps the link loaded until close().
    stopRequests() {},
    close() {
      closed = true;
      if (refillTimer) clearInterval(refillTimer);
      refillTimer = null;
      laneSockets.closeAll(false);
    },
    addConnections(count, messageSizeKb, scaleUpId) {
      if (closed) return;
      nextSizeKb = toUploadChunkSizeKb(messageSizeKb);
      laneSockets.add(count, scaleUpId, (socket) => {
        const state = states.get(socket);
        if (state) state.resizedAt = performance.now();
        fill(socket);
      });
    },
    get bytes() {
      return bytes;
    },
    get connectionCount() {
      return laneSockets.all.length;
    },
    get openedConnectionCount() {
      return laneSockets.opened;
    },
  };
}

/**
 * Bytes to keep queued per upload socket: two chunks, at least 16 KB. The kernel's socket
 * buffer holds more, so a shallow queue keeps the link busy while limiting memory and the
 * work a single threaded client does per refill.
 */
export function getUploadBufferTargetBytes(chunkBytes: number): number {
  return Math.max(chunkBytes * 2, 16 * 1024);
}

export function openThroughputLane(
  direction: ThroughputDirection,
  options: ThroughputLaneOptions,
  callbacks: ThroughputLaneCallbacks
): ThroughputLane {
  return direction === 'download'
    ? openDownloadLane(options, callbacks)
    : openUploadLane(options, callbacks);
}
