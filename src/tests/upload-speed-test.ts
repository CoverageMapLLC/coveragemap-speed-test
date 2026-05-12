import type { SpeedTestData, SpeedSnapshot } from '../types/speed-test.js';
import { CancellationToken, CancellationError } from '../utils/cancellation.js';
import { calculateSpeedMbps } from '../utils/speed.js';

export interface UploadSpeedTestOptions {
  serverUrl: string;
  messageSizeKb: number;
  connectionCount: number;
  durationMs: number;
  latencyMs: number;
  jitterMs: number;
  snapshotIntervalMs?: number;
  cancellationToken: CancellationToken;
  onSnapshot?: (snapshot: SpeedSnapshot) => void;
}

const MAX_CHUNK_SIZE = 1024 * 1024;
const MIN_SNAPSHOT_WINDOW_MS = 300;

export async function runUploadSpeedTest(options: UploadSpeedTestOptions): Promise<SpeedTestData> {
  const {
    serverUrl,
    messageSizeKb,
    connectionCount,
    durationMs,
    latencyMs,
    jitterMs,
    snapshotIntervalMs = 100,
    cancellationToken,
    onSnapshot,
  } = options;

  return new Promise<SpeedTestData>((resolve, reject) => {
    const sockets: WebSocket[] = [];
    let acknowledgedBytes = 0;
    let testStartTime: number | null = null;
    let settled = false;
    let connectedCount = 0;
    let snapshotTimer: ReturnType<typeof setInterval> | null = null;
    let uploadTimer: ReturnType<typeof setInterval> | null = null;
    const snapshots: SpeedSnapshot[] = [];
    const adjustmentMs = latencyMs + jitterMs;
    const bufferSizeKb = Math.max(messageSizeKb * 8, 1024);
    const messageBytes = messageSizeKb * 1024;
    const pendingBytesBySocket = new Map<WebSocket, number[]>();
    const ackEvents: Array<{ timeMs: number; bytes: number }> = [];
    let ackBytesInWindow = 0;

    const cleanup = () => {
      if (snapshotTimer) clearInterval(snapshotTimer);
      if (uploadTimer) clearInterval(uploadTimer);
      for (const s of sockets) {
        try {
          if (s.readyState !== WebSocket.CLOSED) s.close();
        } catch {
          // ignore
        }
      }
    };

    const settle = (
      fn: typeof resolve | typeof reject,
      val: SpeedTestData | Error | CancellationError
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      (fn as (v: unknown) => void)(val);
    };

    const finishTest = () => {
      if (!testStartTime) {
        settle(reject, new Error('Test never started'));
        return;
      }
      const elapsed = performance.now() - testStartTime;
      const effectiveDurationMs = Math.max(elapsed - adjustmentMs, 1);
      const speedMbps = calculateSpeedMbps(acknowledgedBytes, effectiveDurationMs);

      settle(resolve, {
        durationMs: elapsed,
        speedMbps,
        bytes: acknowledgedBytes,
        snapshots,
      });
    };

    cancellationToken.onCancel(() => settle(reject, new CancellationError()));

    const createChunks = (): Uint8Array[] => {
      const chunks: Uint8Array[] = [];
      const fullChunks = Math.floor(messageBytes / MAX_CHUNK_SIZE);
      const remainder = messageBytes % MAX_CHUNK_SIZE;

      for (let i = 0; i < fullChunks; i++) {
        chunks.push(new Uint8Array(MAX_CHUNK_SIZE));
      }
      if (remainder > 0) {
        chunks.push(new Uint8Array(remainder));
      }
      return chunks;
    };

    const sendBurst = () => {
      if (settled) return;
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

    const startTest = () => {
      testStartTime = performance.now();

      snapshotTimer = setInterval(() => {
        if (!testStartTime || settled) return;
        const now = performance.now();
        const elapsed = now - testStartTime;
        const snapshotWindowMs = Math.max(snapshotIntervalMs * 3, MIN_SNAPSHOT_WINDOW_MS);
        const cutoffTime = now - snapshotWindowMs;
        while (ackEvents.length > 0 && ackEvents[0].timeMs < cutoffTime) {
          const expired = ackEvents.shift();
          if (expired) ackBytesInWindow -= expired.bytes;
        }

        const effectiveWindowMs = Math.max(Math.min(elapsed, snapshotWindowMs), 1);
        const speedMbps = calculateSpeedMbps(Math.max(ackBytesInWindow, 0), effectiveWindowMs);

        const snapshot: SpeedSnapshot = {
          timeOffsetMs: elapsed,
          speedMbps,
          bytes: acknowledgedBytes,
        };
        snapshots.push(snapshot);
        onSnapshot?.(snapshot);
      }, snapshotIntervalMs);

      uploadTimer = setInterval(sendBurst, 10);
      sendBurst();

      setTimeout(() => {
        finishTest();
      }, durationMs);
    };

    for (let i = 0; i < connectionCount; i++) {
      try {
        const socket = new WebSocket(serverUrl);
        socket.binaryType = 'arraybuffer';
        pendingBytesBySocket.set(socket, []);

        socket.onopen = () => {
          connectedCount++;
          if (connectedCount === connectionCount) {
            startTest();
          }
        };

        socket.onmessage = (event) => {
          if (typeof event.data !== 'string' || event.data !== 'ACK') return;
          const pendingBytes = pendingBytesBySocket.get(socket);
          const acknowledgedChunkSize = pendingBytes?.shift();
          if (acknowledgedChunkSize === undefined) return;
          acknowledgedBytes += acknowledgedChunkSize;
          const ackTime = performance.now();
          ackEvents.push({ timeMs: ackTime, bytes: acknowledgedChunkSize });
          ackBytesInWindow += acknowledgedChunkSize;
        };

        socket.onerror = () => {
          if (!settled && connectedCount === 0) {
            settle(reject, new Error(`Upload WebSocket connection ${i} failed`));
          }
        };

        socket.onclose = () => {
          // handled by timer
        };

        sockets.push(socket);
      } catch (error) {
        cleanup();
        reject(new Error(`Failed to create upload WebSocket ${i}: ${error}`));
        return;
      }
    }
  });
}
