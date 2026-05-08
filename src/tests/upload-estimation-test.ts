import type { SpeedEstimationResult } from '../types/speed-test.js';
import { CancellationToken, CancellationError } from '../utils/cancellation.js';
import { calculateSpeedMbps } from '../utils/speed.js';

export interface UploadEstimationTestOptions {
  serverUrl: string;
  latencyMs: number;
  jitterMs: number;
  timeoutMs?: number;
  cancellationToken: CancellationToken;
}

const TARGET_DURATION_MS = 100;
const MAX_MESSAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_CHUNK_SIZE = 1024 * 1024;
const MAX_RETRIES = 3;

export async function runUploadEstimationTest(
  options: UploadEstimationTestOptions
): Promise<SpeedEstimationResult> {
  const { serverUrl, latencyMs, jitterMs, timeoutMs = 15000, cancellationToken } = options;

  return new Promise<SpeedEstimationResult>((resolve, reject) => {
    let socket: WebSocket;
    let bytes = 5 * 1024;
    let startTime: number | null = null;
    let retries = 0;
    let didConnect = false;
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let targetAcks = 0;
    let receivedAcks = 0;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      try {
        if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
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

      try {
        for (let i = 0; i < megabyteChunks; i++) {
          socket.send(new Uint8Array(MAX_CHUNK_SIZE));
        }
        if (lastChunkSize > 0) {
          socket.send(new Uint8Array(lastChunkSize));
        }
      } catch (error) {
        if (retries < MAX_RETRIES) {
          retries++;
          setTimeout(() => sendChunks(), 1000);
        } else {
          settle(reject, new Error(`Failed to send upload data: ${error}`));
        }
      }
    };

    try {
      socket = new WebSocket(serverUrl);
      socket.binaryType = 'arraybuffer';
    } catch (error) {
      reject(new Error(`Failed to create WebSocket: ${error}`));
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

      const rawDurationMs = now - startTime;
      const adjustedMs = rawDurationMs - (latencyMs + jitterMs);

      if (adjustedMs < TARGET_DURATION_MS && bytes < MAX_MESSAGE_SIZE_BYTES) {
        bytes *= 2;
        sendChunks();
        return;
      }

      const durationMs = Math.max(adjustedMs, 1);
      const speedMbps = calculateSpeedMbps(bytes, durationMs);

      settle(resolve, { durationMs, bytes, speedMbps });
    };

    socket.onerror = () => {
      settle(reject, new Error('WebSocket error during upload estimation'));
    };

    socket.onclose = () => {
      if (!settled) {
        settle(reject, new Error('WebSocket closed before upload estimation completed'));
      }
    };
  });
}
