/**
 * A lane is a group of throughput sockets that generate traffic and count bytes. Lanes only
 * use the standard WebSocket API, so the same code runs on the calling thread or inside a
 * worker thread. The throughput runners own timing, snapshots, and results; lanes only move
 * bytes.
 */

export interface ThroughputLaneOptions {
  serverUrl: string;
  connectionCount: number;
  messageSizeKb: number;
  /** Index of this lane's first socket across all lanes, used in error messages. */
  firstSocketIndex?: number;
}

export interface ThroughputLaneCallbacks {
  /** Every socket in the lane is open. */
  onOpen: () => void;
  /** A socket failed before the lane opened. */
  onError: (error: Error) => void;
  /** The byte count changed. */
  onBytes?: (bytes: number) => void;
}

export interface ThroughputLane {
  /** Starts traffic on every socket. */
  start(): void;
  /** Stops traffic and closes every socket. */
  close(): void;
  /** Bytes received (download) or acknowledged by the server (upload) so far. */
  readonly bytes: number;
}

export type ThroughputDirection = 'download' | 'upload';

const DOWNLOAD_ITERATION_COUNT = 500;
const MAX_DOWNLOAD_MESSAGE_SIZE_KB = 5 * 1024;
const MAX_UPLOAD_CHUNK_SIZE = 1024 * 1024;
const UPLOAD_REFILL_INTERVAL_MS = 5;
/** Longest a timer refill may spend sending before yielding to other work. */
const UPLOAD_REFILL_BUDGET_MS = 4;
/** 64 MB with 1 MB chunks: 1.7 Gbps per socket at 300 ms round trip time. */
const MAX_UNACKED_UPLOAD_CHUNKS = 64;

function closeSockets(sockets: WebSocket[]): void {
  for (const socket of sockets) {
    try {
      if (socket.readyState !== WebSocket.CLOSED) socket.close();
    } catch {
      // ignore
    }
  }
}

/** Opens the lane's sockets and reports `onOpen` once all of them are connected. */
function connectLane(
  direction: ThroughputDirection,
  options: ThroughputLaneOptions,
  callbacks: ThroughputLaneCallbacks,
  isClosed: () => boolean,
  setup: (socket: WebSocket) => void
): WebSocket[] {
  const sockets: WebSocket[] = [];
  const firstIndex = options.firstSocketIndex ?? 0;
  const label = direction === 'download' ? 'Download' : 'Upload';
  let connectedCount = 0;
  let opened = false;

  for (let i = 0; i < options.connectionCount; i++) {
    const index = firstIndex + i;
    let socket: WebSocket;
    try {
      socket = new WebSocket(options.serverUrl);
    } catch (error) {
      closeSockets(sockets);
      throw new Error(`Failed to create ${direction} WebSocket ${index}: ${error}`);
    }
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
      connectedCount++;
      if (connectedCount === options.connectionCount && !opened && !isClosed()) {
        opened = true;
        callbacks.onOpen();
      }
    };

    socket.onerror = () => {
      if (!opened && !isClosed()) {
        callbacks.onError(new Error(`${label} WebSocket connection ${index} failed`));
      }
    };

    socket.onclose = () => {
      // handled by the runner's timer
    };

    setup(socket);
    sockets.push(socket);
  }

  return sockets;
}

/**
 * Download lane. Each socket requests `START <kb> 500` and, once all 500 frames of a batch
 * arrive, requests the next batch with twice the frame size up to 5 MB.
 */
export function openDownloadLane(
  options: ThroughputLaneOptions,
  callbacks: ThroughputLaneCallbacks
): ThroughputLane {
  let bytes = 0;
  let closed = false;
  const packetsRemainingBySocket = new Map<WebSocket, number>();
  const messageSizeKbBySocket = new Map<WebSocket, number>();

  const sendDownloadRequest = (socket: WebSocket, requestMessageSizeKb: number) => {
    if (closed || socket.readyState !== WebSocket.OPEN) return;
    socket.send(`START ${requestMessageSizeKb} ${DOWNLOAD_ITERATION_COUNT}`);
    packetsRemainingBySocket.set(socket, DOWNLOAD_ITERATION_COUNT);
    messageSizeKbBySocket.set(socket, requestMessageSizeKb);
  };

  const sockets = connectLane('download', options, callbacks, () => closed, (socket) => {
    socket.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const currentPacketsRemaining = packetsRemainingBySocket.get(socket) ?? 0;
      if (currentPacketsRemaining <= 0) return;

      bytes += event.data.byteLength;
      callbacks.onBytes?.(bytes);
      const packetsRemaining = currentPacketsRemaining - 1;
      packetsRemainingBySocket.set(socket, packetsRemaining);

      if (packetsRemaining === 0) {
        const currentMessageSizeKb = messageSizeKbBySocket.get(socket) ?? options.messageSizeKb;
        sendDownloadRequest(socket, Math.min(currentMessageSizeKb * 2, MAX_DOWNLOAD_MESSAGE_SIZE_KB));
      }
    };
  });

  return {
    start() {
      for (const socket of sockets) {
        sendDownloadRequest(socket, options.messageSizeKb);
      }
    },
    close() {
      closed = true;
      closeSockets(sockets);
    },
    get bytes() {
      return bytes;
    },
  };
}

/**
 * Upload lane. Each socket's send buffer is kept topped up to a target size, after
 * acknowledgements arrive and on a short timer as a fallback since the WebSocket API has no
 * drain event. Every socket reuses one preallocated chunk of at most 1 MB. Bytes count once
 * the server acknowledges the chunk.
 *
 * Unacknowledged chunks per socket are capped as well, so memory stays bounded with
 * WebSocket implementations that do not report `bufferedAmount`. The cap is large enough
 * to cover the bandwidth-delay product of multi-gigabit links with 300 ms of latency.
 * A refill stops after a few milliseconds of work, and acknowledgements that arrive
 * together share one refill, so a CPU bound client still services snapshots and latency
 * probes on time.
 */
export function openUploadLane(
  options: ThroughputLaneOptions,
  callbacks: ThroughputLaneCallbacks
): ThroughputLane {
  let bytes = 0;
  let closed = false;
  let started = false;
  let refillTimer: ReturnType<typeof setInterval> | null = null;
  const chunkBytes = Math.min(options.messageSizeKb * 1024, MAX_UPLOAD_CHUNK_SIZE);
  const chunk = new Uint8Array(chunkBytes);
  const bufferTargetBytes = getUploadBufferTargetBytes(chunkBytes);
  const chunksPerFill = Math.ceil(bufferTargetBytes / chunkBytes);
  const unackedChunksBySocket = new Map<WebSocket, number>();

  /** Sends up to `maxChunks` chunks. Returns false once `deadline` has passed. */
  const fill = (socket: WebSocket, maxChunks: number, deadline = Infinity): boolean => {
    if (closed || !started || socket.readyState !== WebSocket.OPEN) return true;
    let unacked = unackedChunksBySocket.get(socket) ?? 0;
    let withinBudget = true;
    try {
      for (
        let sent = 0;
        sent < maxChunks &&
        unacked < MAX_UNACKED_UPLOAD_CHUNKS &&
        socket.bufferedAmount < bufferTargetBytes;
        sent++
      ) {
        socket.send(chunk);
        unacked++;
        if (performance.now() > deadline) {
          withinBudget = false;
          break;
        }
      }
    } catch {
      // ignore send errors; the socket is closing
    }
    unackedChunksBySocket.set(socket, unacked);
    return withinBudget;
  };

  const sockets = connectLane('upload', options, callbacks, () => closed, (socket) => {
    unackedChunksBySocket.set(socket, 0);
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string' || event.data !== 'ACK') return;
      const unacked = unackedChunksBySocket.get(socket) ?? 0;
      if (unacked === 0) return;
      unackedChunksBySocket.set(socket, unacked - 1);
      bytes += chunkBytes;
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
    const deadline = performance.now() + UPLOAD_REFILL_BUDGET_MS;
    for (let i = 0; i < sockets.length; i++) {
      const socket = sockets[(nextSocket + i) % sockets.length];
      if (!fill(socket, chunksPerFill, deadline)) {
        // Resume with the next socket on the following tick.
        nextSocket = (nextSocket + i + 1) % sockets.length;
        return;
      }
    }
  };

  return {
    start() {
      started = true;
      refillTimer = setInterval(fillAll, UPLOAD_REFILL_INTERVAL_MS);
      fillAll();
    },
    close() {
      closed = true;
      if (refillTimer) clearInterval(refillTimer);
      refillTimer = null;
      closeSockets(sockets);
    },
    get bytes() {
      return bytes;
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
