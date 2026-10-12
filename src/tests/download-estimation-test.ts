import type { SpeedEstimationResult } from '../types/speed-test.js';
import { CancellationToken, CancellationError } from '../utils/cancellation.js';
import { calculateSpeedMbps } from '../utils/speed.js';
import { createStallMonitor } from '../utils/stall-monitor.js';
import { SOCKET_CLOSED, openSocket } from './sockets.js';

export interface DownloadEstimationTestOptions {
  serverUrl: string;
  latencyMs: number;
  jitterMs: number;
  timeoutMs?: number;
  cancellationToken: CancellationToken;
}

const TARGET_DURATION_MS = 100;
const MAX_MESSAGE_SIZE_BYTES = 5 * 1024 * 1024;
const WARMUP_SIZE = 512;
const MAX_RETRIES = 3;
/** Times a round that ran while the thread was blocked is repeated before it is used. */
export const MAX_STALLED_ROUND_REPEATS = 3;

export async function runDownloadEstimationTest(
  options: DownloadEstimationTestOptions
): Promise<SpeedEstimationResult> {
  const { serverUrl, latencyMs, jitterMs, timeoutMs = 15000, cancellationToken } = options;

  return new Promise<SpeedEstimationResult>((resolve, reject) => {
    let socket: WebSocket;
    let messageSizeBytes = 10 * 1024;
    let startTime: number | null = null;
    let retries = 0;
    let didConnect = false;
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    let stalledRepeats = 0;
    const stallMonitor = createStallMonitor();

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      stallMonitor.stop();
      try {
        if (socket && socket.readyState !== SOCKET_CLOSED) socket.close();
      } catch {
        // ignore
      }
    };

    const settle = (
      fn: typeof resolve | typeof reject,
      val: SpeedEstimationResult | Error | CancellationError
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      (fn as (v: unknown) => void)(val);
    };

    cancellationToken.onCancel(() => settle(reject, new CancellationError()));

    timeoutId = setTimeout(() => {
      settle(
        reject,
        new Error(
          `Download estimation timed out after ${timeoutMs}ms. Connected: ${didConnect}, Retries: ${retries}`
        )
      );
    }, timeoutMs);

    const runTest = () => {
      const messageSizeKb = Math.floor(messageSizeBytes / 1024);
      socket.send(`START ${messageSizeKb} 1`);
      startTime = performance.now();
      stallMonitor.reset();
    };

    try {
      socket = openSocket(serverUrl);
      socket.binaryType = 'arraybuffer';
    } catch (error) {
      reject(new Error(`Failed to create WebSocket: ${error}`));
      return;
    }

    const handleOpen = () => {
      didConnect = true;
      try {
        socket.send(new Uint8Array(WARMUP_SIZE));
      } catch {
        // warmup is not critical
      }
      setTimeout(() => runTest(), 10);
    };

    const handleMessage = (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;

      const now = performance.now();
      const bytes = event.data.byteLength;
      const rawDurationMs = now - (startTime ?? now);
      const adjustedMs = rawDurationMs - (latencyMs + jitterMs);

      if (adjustedMs < TARGET_DURATION_MS && messageSizeBytes < MAX_MESSAGE_SIZE_BYTES) {
        messageSizeBytes *= 2;
        runTest();
        return;
      }

      // A slow round ends the estimation, so check that the network was what made it slow.
      // If the thread was blocked (an application rendering between stages, for example),
      // the message was handled late: repeat the same size rather than settle on a far too
      // small estimate.
      if (stallMonitor.stalled() && stalledRepeats < MAX_STALLED_ROUND_REPEATS) {
        stalledRepeats++;
        runTest();
        return;
      }

      const durationMs = Math.max(adjustedMs, 1);
      const speedMbps = calculateSpeedMbps(bytes, durationMs);

      settle(resolve, { durationMs, bytes, speedMbps });
    };

    const handleError = () => {
      if (retries < MAX_RETRIES) {
        retries++;
        setTimeout(() => {
          try {
            socket = openSocket(serverUrl);
            socket.binaryType = 'arraybuffer';
            socket.onopen = handleOpen;
            socket.onmessage = handleMessage;
            socket.onerror = handleError;
            socket.onclose = handleClose;
          } catch (error) {
            settle(reject, new Error(`Failed to reconnect: ${error}`));
          }
        }, 1000);
      } else {
        settle(reject, new Error('Download estimation failed after retries'));
      }
    };

    const handleClose = () => {
      // handled by onmessage or onerror
    };

    socket.onopen = handleOpen;
    socket.onmessage = handleMessage;
    socket.onerror = handleError;
    socket.onclose = handleClose;
  });
}
