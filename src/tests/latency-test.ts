import type { LatencyTestData } from '../types/speed-test.js';
import { CancellationToken, CancellationError } from '../utils/cancellation.js';

export interface LatencyTestOptions {
  serverUrl: string;
  pingCount: number;
  timeoutMs?: number;
  cancellationToken: CancellationToken;
  onPing?: (latencyMs: number, index: number) => void;
}

export async function runLatencyTest(options: LatencyTestOptions): Promise<LatencyTestData> {
  const { serverUrl, pingCount, timeoutMs = 10000, cancellationToken, onPing } = options;

  return new Promise<LatencyTestData>((resolve, reject) => {
    let socket: WebSocket;
    const pingTimes: number[] = [];
    let sentPings = 0;
    let pingStartTime: number | null = null;
    let didConnect = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      try {
        if (socket && socket.readyState !== WebSocket.CLOSED) {
          socket.close();
        }
      } catch {
        // ignore close errors
      }
    };

    const complete = () => {
      cleanup();
      if (pingTimes.length === 0) {
        reject(new Error('No ping responses received'));
        return;
      }
      resolve(computeLatencyData(pingTimes));
    };

    const sendPing = () => {
      if (cancellationToken.isCancelled) {
        cleanup();
        reject(new CancellationError());
        return;
      }
      try {
        socket.send('PING');
        pingStartTime = performance.now();
        sentPings++;
      } catch (error) {
        cleanup();
        reject(new Error(`Failed to send ping: ${error}`));
      }
    };

    cancellationToken.onCancel(() => {
      cleanup();
      reject(new CancellationError());
    });

    timeoutId = setTimeout(() => {
      if (pingTimes.length >= 3) {
        complete();
      } else {
        cleanup();
        reject(
          new Error(
            `Latency test timed out after ${timeoutMs}ms. Connected: ${didConnect}, Pings sent: ${sentPings}`
          )
        );
      }
    }, timeoutMs);

    try {
      socket = new WebSocket(serverUrl);
      socket.binaryType = 'arraybuffer';
    } catch (error) {
      cleanup();
      reject(new Error(`Failed to create WebSocket: ${error}`));
      return;
    }

    socket.onopen = () => {
      didConnect = true;
      sendPing();
    };

    socket.onmessage = (event) => {
      const now = performance.now();
      if (typeof event.data !== 'string' || event.data !== 'PONG' || pingStartTime === null) {
        return;
      }

      const pingTimeMs = now - pingStartTime;
      pingTimes.push(pingTimeMs);
      onPing?.(pingTimeMs, pingTimes.length - 1);

      if (sentPings >= pingCount) {
        complete();
        return;
      }

      sendPing();
    };

    socket.onerror = () => {
      cleanup();
      reject(new Error('WebSocket error during latency test'));
    };

    socket.onclose = () => {
      if (pingTimes.length >= 3) {
        complete();
      }
    };
  });
}

function computeLatencyData(latencies: number[]): LatencyTestData {
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const averageLatency = sum / sorted.length;
  const medianLatency = sorted[Math.floor(sorted.length / 2)];
  const minLatency = sorted[0];
  const maxLatency = sorted[sorted.length - 1];

  const jitters: number[] = [];
  for (let i = 1; i < latencies.length; i++) {
    jitters.push(Math.abs(latencies[i] - latencies[i - 1]));
  }

  const sortedJitters = [...jitters].sort((a, b) => a - b);
  const minJitter = sortedJitters.length > 0 ? sortedJitters[0] : 0;
  const averageJitter =
    sortedJitters.length > 0 ? sortedJitters.reduce((a, b) => a + b, 0) / sortedJitters.length : 0;
  const medianJitter =
    sortedJitters.length > 0 ? sortedJitters[Math.floor(sortedJitters.length / 2)] : 0;
  const maxJitter = sortedJitters.length > 0 ? sortedJitters[sortedJitters.length - 1] : 0;

  return {
    latencies,
    minLatency,
    averageLatency,
    medianLatency,
    maxLatency,
    minJitter,
    averageJitter,
    medianJitter,
    maxJitter,
  };
}
