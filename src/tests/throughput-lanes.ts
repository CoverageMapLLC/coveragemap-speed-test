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
const UPLOAD_BURST_INTERVAL_MS = 5;

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
 * Upload lane. Every 5 ms each socket below its buffer threshold is sent one message, split
 * into chunks of at most 1 MB. Bytes count once the server acknowledges the chunk.
 */
export function openUploadLane(
  options: ThroughputLaneOptions,
  callbacks: ThroughputLaneCallbacks
): ThroughputLane {
  let bytes = 0;
  let closed = false;
  let uploadTimer: ReturnType<typeof setInterval> | null = null;
  const bufferSizeKb = Math.max(options.messageSizeKb * 32, 1024);
  const messageBytes = options.messageSizeKb * 1024;
  const pendingBytesBySocket = new Map<WebSocket, number[]>();

  const createChunks = (): Uint8Array[] => {
    const chunks: Uint8Array[] = [];
    const fullChunks = Math.floor(messageBytes / MAX_UPLOAD_CHUNK_SIZE);
    const remainder = messageBytes % MAX_UPLOAD_CHUNK_SIZE;
    for (let i = 0; i < fullChunks; i++) {
      chunks.push(new Uint8Array(MAX_UPLOAD_CHUNK_SIZE));
    }
    if (remainder > 0) {
      chunks.push(new Uint8Array(remainder));
    }
    return chunks;
  };

  const sockets = connectLane('upload', options, callbacks, () => closed, (socket) => {
    pendingBytesBySocket.set(socket, []);
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string' || event.data !== 'ACK') return;
      const acknowledgedChunkSize = pendingBytesBySocket.get(socket)?.shift();
      if (acknowledgedChunkSize === undefined) return;
      bytes += acknowledgedChunkSize;
      callbacks.onBytes?.(bytes);
    };
  });

  const sendBurst = () => {
    if (closed) return;
    const chunks = createChunks();
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.bufferedAmount > bufferSizeKb * 1024) continue;
      const pendingBytes = pendingBytesBySocket.get(socket);
      for (const chunk of chunks) {
        try {
          socket.send(chunk);
          pendingBytes?.push(chunk.byteLength);
        } catch {
          // ignore send errors during burst
        }
      }
    }
  };

  return {
    start() {
      uploadTimer = setInterval(sendBurst, UPLOAD_BURST_INTERVAL_MS);
      sendBurst();
    },
    close() {
      closed = true;
      if (uploadTimer) clearInterval(uploadTimer);
      uploadTimer = null;
      closeSockets(sockets);
    },
    get bytes() {
      return bytes;
    },
  };
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
