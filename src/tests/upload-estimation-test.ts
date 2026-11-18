import type { SpeedEstimationResult } from '../types/speed-test.js';
import { CancellationToken, CancellationError } from '../utils/cancellation.js';
import { SpeedTestError, getFailureReasonOr } from '../utils/failure.js';
import {
  ESTIMATION_TARGET_MS,
  UPLOAD_ESTIMATION_START_BYTES,
  estimationReference,
  measureEstimationRound,
  nextEstimationBytes,
  nextEstimationStep,
  type EstimationRound,
} from '../utils/adaptive.js';
import { createStallMonitor } from '../utils/stall-monitor.js';
import { SOCKET_CLOSED, openSocket, sendZeroFilled } from './sockets.js';

export interface UploadEstimationTestOptions {
  serverUrl: string;
  latencyMs: number;
  jitterMs: number;
  timeoutMs?: number;
  cancellationToken: CancellationToken;
  /** `false` opens WebSockets with `globalThis.WebSocket`, not the Node.js client. See `SpeedTestConfig.nodeWebSocket`. */
  nodeWebSocket?: boolean;
}

const MAX_CHUNK_SIZE = 1024 * 1024;
const MAX_RETRIES = 3;
/** Times a round that ran while the thread was blocked is repeated before it is used. */
export const MAX_STALLED_ROUND_REPEATS = 3;

export async function runUploadEstimationTest(
  options: UploadEstimationTestOptions
): Promise<SpeedEstimationResult> {
  const { serverUrl, latencyMs, jitterMs, timeoutMs = 15000, cancellationToken, nodeWebSocket } = options;

  return new Promise<SpeedEstimationResult>((resolve, reject) => {
    let socket: WebSocket;
    let bytes = UPLOAD_ESTIMATION_START_BYTES;
    let startTime: number | null = null;
    /** When the first round started: estimation settles `ESTIMATION_TIME_CAP_MS` after it. */
    let firstRoundAt: number | null = null;
    const rounds: EstimationRound[] = [];
    let retries = 0;
    let didConnect = false;
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let targetAcks = 0;
    let receivedAcks = 0;

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
          `Upload estimation timed out after ${timeoutMs}ms. Connected: ${didConnect}, Retries: ${retries}`
        )
      );
    }, timeoutMs);

    const sendChunks = () => {
      const megabyteChunks = Math.floor(bytes / MAX_CHUNK_SIZE);
      const lastChunkSize = bytes % MAX_CHUNK_SIZE;
      receivedAcks = 0;
      targetAcks = megabyteChunks + (lastChunkSize > 0 ? 1 : 0);
      startTime = performance.now();
      firstRoundAt ??= startTime;
      stallMonitor.reset();

      try {
        for (let i = 0; i < megabyteChunks; i++) {
          sendZeroFilled(socket, new Uint8Array(MAX_CHUNK_SIZE));
        }
        if (lastChunkSize > 0) {
          sendZeroFilled(socket, new Uint8Array(lastChunkSize));
        }
      } catch (error) {
        if (retries < MAX_RETRIES) {
          retries++;
          setTimeout(() => sendChunks(), 1000);
        } else {
          settle(reject, new SpeedTestError('connectionFailed', `Failed to send upload data: ${error}`));
        }
      }
    };

    try {
      socket = openSocket(serverUrl, { nodeWebSocket });
      socket.binaryType = 'arraybuffer';
    } catch (error) {
      reject(new SpeedTestError(getFailureReasonOr(error, 'connectionFailed'), `Failed to create WebSocket: ${error}`));
      return;
    }

    socket.onopen = () => {
      didConnect = true;
      sendChunks();
    };

    socket.onmessage = (event) => {
      const now = performance.now();
      if (typeof event.data !== 'string' || event.data !== 'ACK' || startTime === null) return;

      receivedAcks++;
      if (receivedAcks < targetAcks) return;

      const round = measureEstimationRound(bytes, now - startTime, latencyMs, jitterMs);

      // A slow round counts only if the network made it slow. If the thread was blocked (an
      // application rendering between stages, for example), the ACKs were handled late: repeat
      // the same size rather than read the delay as the link's speed.
      if (
        round.durationMs >= ESTIMATION_TARGET_MS &&
        stallMonitor.stalled() &&
        stalledRepeats < MAX_STALLED_ROUND_REPEATS
      ) {
        stalledRepeats++;
        sendChunks();
        return;
      }

      rounds.push(round);
      const step = nextEstimationStep(rounds, now - (firstRoundAt ?? now));
      if (step === 'grow') bytes = nextEstimationBytes(bytes);
      if (step !== 'stop') {
        sendChunks();
        return;
      }

      // The fastest of the last rounds: see estimationReference
      const best = estimationReference(rounds)!;
      settle(resolve, { durationMs: best.durationMs, bytes: best.bytes, speedMbps: best.speedMbps });
    };

    socket.onerror = () => {
      settle(reject, new SpeedTestError('connectionFailed', 'WebSocket error during upload estimation'));
    };

    socket.onclose = () => {
      if (!settled) {
        settle(reject, new SpeedTestError('connectionFailed', 'WebSocket closed before upload estimation completed'));
      }
    };
  });
}
