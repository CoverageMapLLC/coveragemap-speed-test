import type { SpeedTestData, SpeedSnapshot } from '../types/speed-test.js';
import { CancellationToken, CancellationError } from '../utils/cancellation.js';
import { calculateSpeedMbps } from '../utils/speed.js';
import { createLoadedLatencyMonitor } from './loaded-latency-test.js';

export interface DownloadSpeedTestOptions {
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

const ITERATION_COUNT = 500;
const MAX_MESSAGE_SIZE_KB = 5 * 1024;

export async function runDownloadSpeedTest(
  options: DownloadSpeedTestOptions
): Promise<SpeedTestData> {
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
    let totalBytes = 0;
    let testStartTime: number | null = null;
    let settled = false;
    let connectedCount = 0;
    let snapshotTimer: ReturnType<typeof setInterval> | null = null;
    const snapshots: SpeedSnapshot[] = [];
    const adjustmentMs = latencyMs + jitterMs;
    const packetsRemainingBySocket = new Map<WebSocket, number>();
    const messageSizeKbBySocket = new Map<WebSocket, number>();
    const loadedLatencyMonitor = createLoadedLatencyMonitor({
      serverUrl,
      cancellationToken,
    });

    const cleanup = () => {
      if (snapshotTimer) clearInterval(snapshotTimer);
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

    const finishTest = async () => {
      if (testStartTime === null) {
        settle(reject, new Error('Test never started'));
        return;
      }
      const elapsed = performance.now() - testStartTime;
      const effectiveDurationMs = Math.max(elapsed - adjustmentMs, 1);
      const speedMbps = calculateSpeedMbps(totalBytes, effectiveDurationMs);

      let loadedLatency;
      try {
        loadedLatency = await loadedLatencyMonitor.stop();
      } catch (error) {
        if (error instanceof CancellationError) {
          settle(reject, error);
        } else {
          settle(reject, error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }

      settle(resolve, {
        durationMs: elapsed,
        speedMbps,
        bytes: totalBytes,
        snapshots,
        loadedLatency,
      });
    };

    cancellationToken.onCancel(() => settle(reject, new CancellationError()));

    const sendDownloadRequest = (socket: WebSocket, requestMessageSizeKb: number) => {
      if (settled || socket.readyState !== WebSocket.OPEN) return;

      socket.send(`START ${requestMessageSizeKb} ${ITERATION_COUNT}`);
      packetsRemainingBySocket.set(socket, ITERATION_COUNT);
      messageSizeKbBySocket.set(socket, requestMessageSizeKb);
    };

    const refillDownloadRequest = (socket: WebSocket) => {
      const currentMessageSizeKb = messageSizeKbBySocket.get(socket) ?? messageSizeKb;
      const nextMessageSizeKb = Math.min(currentMessageSizeKb * 2, MAX_MESSAGE_SIZE_KB);
      sendDownloadRequest(socket, nextMessageSizeKb);
    };

    const startTest = () => {
      testStartTime = performance.now();
      loadedLatencyMonitor.start();

      snapshotTimer = setInterval(() => {
        if (testStartTime === null || settled) return;
        const elapsed = performance.now() - testStartTime;
        const effectiveDurationMs = Math.max(elapsed - adjustmentMs, 1);
        const speedMbps = calculateSpeedMbps(totalBytes, effectiveDurationMs);
        const snapshot: SpeedSnapshot = {
          timeOffsetMs: elapsed,
          speedMbps,
          bytes: totalBytes,
        };
        snapshots.push(snapshot);
        onSnapshot?.(snapshot);
      }, snapshotIntervalMs);

      setTimeout(() => {
        void finishTest();
      }, durationMs);

      for (const socket of sockets) {
        sendDownloadRequest(socket, messageSizeKb);
      }
    };

    for (let i = 0; i < connectionCount; i++) {
      try {
        const socket = new WebSocket(serverUrl);
        socket.binaryType = 'arraybuffer';

        socket.onopen = () => {
          connectedCount++;
          if (connectedCount === connectionCount) {
            startTest();
          }
        };

        socket.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            totalBytes += event.data.byteLength;
            const packetsRemaining = (packetsRemainingBySocket.get(socket) ?? 0) - 1;
            packetsRemainingBySocket.set(socket, packetsRemaining);

            if (packetsRemaining <= 0) {
              refillDownloadRequest(socket);
            }
          }
        };

        socket.onerror = () => {
          if (!settled && connectedCount === 0) {
            settle(reject, new Error(`Download WebSocket connection ${i} failed`));
          }
        };

        socket.onclose = () => {
          // handled by timer
        };

        sockets.push(socket);
      } catch (error) {
        cleanup();
        reject(new Error(`Failed to create download WebSocket ${i}: ${error}`));
        return;
      }
    }
  });
}
