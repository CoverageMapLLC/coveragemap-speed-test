import type { SpeedEstimationResult } from '../types/speed-test.js';
import { CancellationToken, CancellationError } from '../utils/cancellation.js';
import {
  DOWNLOAD_ESTIMATION_START_BYTES,
  ESTIMATION_TARGET_MS,
  estimationReference,
  measureEstimationRound,
  nextEstimationBytes,
  nextEstimationStep,
  type EstimationRound,
} from '../utils/adaptive.js';
import { createStallMonitor } from '../utils/stall-monitor.js';
import { SpeedTestError, getFailureReasonOr } from '../utils/failure.js';
import { SOCKET_CLOSED, openSocket } from './sockets.js';

export interface DownloadEstimationTestOptions {
  serverUrl: string;
  latencyMs: number;
  jitterMs: number;
  timeoutMs?: number;
  cancellationToken: CancellationToken;
  /** `false` opens WebSockets with `globalThis.WebSocket`, not the Node.js client. See `SpeedTestConfig.nodeWebSocket`. */
  nodeWebSocket?: boolean;
}

const WARMUP_SIZE = 512;
const MAX_RETRIES = 3;
/** Times a round that ran while the thread was blocked is repeated before it is used. */
export const MAX_STALLED_ROUND_REPEATS = 3;

export async function runDownloadEstimationTest(
  options: DownloadEstimationTestOptions
): Promise<SpeedEstimationResult> {
  const { serverUrl, latencyMs, jitterMs, timeoutMs = 15000, cancellationToken, nodeWebSocket } = options;

  return new Promise<SpeedEstimationResult>((resolve, reject) => {
    let socket: WebSocket;
    let messageSizeBytes = DOWNLOAD_ESTIMATION_START_BYTES;
    let startTime: number | null = null;
    /** When the first round started: estimation settles `ESTIMATION_TIME_CAP_MS` after it. */
    let firstRoundAt: number | null = null;
    const rounds: EstimationRound[] = [];
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
        new SpeedTestError(
          didConnect ? 'timeout' : 'connectionTimeout',
          `Download estimation timed out after ${timeoutMs}ms. Connected: ${didConnect}, Retries: ${retries}`
        )
      );
    }, timeoutMs);

    const runTest = () => {
      const messageSizeKb = Math.floor(messageSizeBytes / 1024);
      socket.send(`START ${messageSizeKb} 1`);
      startTime = performance.now();
      firstRoundAt ??= startTime;
      stallMonitor.reset();
    };

    try {
      socket = openSocket(serverUrl, { nodeWebSocket });
      socket.binaryType = 'arraybuffer';
    } catch (error) {
      reject(new SpeedTestError(getFailureReasonOr(error, 'connectionFailed'), `Failed to create WebSocket: ${error}`));
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
      const round = measureEstimationRound(
        event.data.byteLength,
        now - (startTime ?? now),
        latencyMs,
        jitterMs
      );

      // A slow round counts only if the network made it slow. If the thread was blocked (an
      // application rendering between stages, for example), the message was handled late:
      // repeat the same size rather than read the delay as the link's speed.
      if (
        round.durationMs >= ESTIMATION_TARGET_MS &&
        stallMonitor.stalled() &&
        stalledRepeats < MAX_STALLED_ROUND_REPEATS
      ) {
        stalledRepeats++;
        runTest();
        return;
      }

      rounds.push(round);
      const step = nextEstimationStep(rounds, now - (firstRoundAt ?? now));
      if (step === 'grow') messageSizeBytes = nextEstimationBytes(messageSizeBytes);
      if (step !== 'stop') {
        runTest();
        return;
      }

      // The fastest of the last rounds: see estimationReference
      const { durationMs, bytes, speedMbps } = estimationReference(rounds)!;
      settle(resolve, { durationMs, bytes, speedMbps });
    };

    const handleError = () => {
      // The socket closed by cleanup() can still report an unclean close: nothing to retry.
      if (settled) return;
      if (retries < MAX_RETRIES) {
        retries++;
        // The time cap measures rounds, not reconnects: it starts again with the next round
        firstRoundAt = null;
        setTimeout(() => {
          if (settled) return;
          try {
            socket = openSocket(serverUrl, { nodeWebSocket });
            socket.binaryType = 'arraybuffer';
            socket.onopen = handleOpen;
            socket.onmessage = handleMessage;
            socket.onerror = handleError;
            socket.onclose = handleClose;
          } catch (error) {
            settle(reject, new SpeedTestError(getFailureReasonOr(error, 'connectionFailed'), `Failed to reconnect: ${error}`));
          }
        }, 1000);
      } else {
        settle(reject, new SpeedTestError('connectionFailed', 'Download estimation failed after retries'));
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
