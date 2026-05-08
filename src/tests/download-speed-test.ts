import type { SpeedTestData, SpeedSnapshot } from '../types/speed-test.js';
import { CancellationToken, CancellationError } from '../utils/cancellation.js';
import { calculateSpeedMbps } from '../utils/speed.js';

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

    const finishTest = () => {
      if (!testStartTime) {
        settle(reject, new Error('Test never started'));
        return;
      }
      const elapsed = performance.now() - testStartTime;
      const effectiveDurationMs = Math.max(elapsed - adjustmentMs, 1);
      const speedMbps = calculateSpeedMbps(totalBytes, effectiveDurationMs);

      settle(resolve, {
        durationMs: elapsed,
        speedMbps,
        bytes: totalBytes,
        snapshots,
      });
    };

    cancellationToken.onCancel(() => settle(reject, new CancellationError()));

    const startTest = () => {
      testStartTime = performance.now();

      snapshotTimer = setInterval(() => {
        if (!testStartTime || settled) return;
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
        finishTest();
      }, durationMs);

      for (const socket of sockets) {
        socket.send(`START ${messageSizeKb} ${ITERATION_COUNT}`);
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
