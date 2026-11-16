import type { LatencyTestData } from '../types/speed-test.js';
import { CancellationToken, CancellationError } from '../utils/cancellation.js';
import { roundTo3Decimals } from '../utils/speed.js';
import { SpeedTestError, getFailureReasonOr } from '../utils/failure.js';
import { SOCKET_CLOSED, SocketConnectError, openSocket } from './sockets.js';

export interface LatencyTestOptions {
  serverUrl: string;
  pingCount: number;
  timeoutMs?: number;
  /** How long the socket may take to open before the stage fails with a SocketConnectError. */
  connectTimeoutMs?: number;
  cancellationToken: CancellationToken;
  onPing?: (latencyMs: number, index: number) => void;
  /** `false` opens WebSockets with `globalThis.WebSocket`, not the Node.js client. See `SpeedTestConfig.nodeWebSocket`. */
  nodeWebSocket?: boolean;
}

/** How long after this stage's own deadlines the socket's connect timeout fires, as a backstop. */
const SOCKET_CONNECT_BACKSTOP_MS = 1000;

export async function runLatencyTest(options: LatencyTestOptions): Promise<LatencyTestData> {
  const { serverUrl, pingCount, timeoutMs = 10000, connectTimeoutMs, cancellationToken, onPing, nodeWebSocket } = options;

  return new Promise<LatencyTestData>((resolve, reject) => {
    let socket: WebSocket;
    const pingTimes: number[] = [];
    let sentPings = 0;
    let pingStartTime: number | null = null;
    let didConnect = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    /*
     * The first outcome wins. Node.js sockets (raw TCP and the library's WebSocket client) fire
     * `error` synchronously when they are closed while still connecting, so without this the
     * `cleanup()` of a timeout would report a refused connection instead of the timeout.
     */
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      outcome();
    };
    const fail = (error: Error) => settle(() => reject(error));

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (connectTimer) clearTimeout(connectTimer);
      try {
        if (socket && socket.readyState !== SOCKET_CLOSED) {
          socket.close();
        }
      } catch {
        // ignore close errors
      }
    };

    const complete = () => {
      if (pingTimes.length === 0) {
        fail(new SpeedTestError('timeout', 'No ping responses received'));
        return;
      }
      settle(() => resolve(computeLatencyData(pingTimes)));
    };

    const sendPing = () => {
      if (cancellationToken.isCancelled) {
        fail(new CancellationError());
        return;
      }
      try {
        socket.send('PING');
        pingStartTime = performance.now();
        sentPings++;
      } catch (error) {
        fail(new SpeedTestError('connectionFailed', `Failed to send ping: ${error}`));
      }
    };

    cancellationToken.onCancel(() => fail(new CancellationError()));

    timeoutId = setTimeout(() => {
      if (pingTimes.length >= 3) {
        complete();
      } else {
        const message = `Latency test timed out after ${timeoutMs}ms. Connected: ${didConnect}, Pings sent: ${sentPings}`;
        fail(didConnect ? new SpeedTestError('timeout', message) : new SocketConnectError(message, 'connectionTimeout'));
      }
    }, timeoutMs);

    try {
      // This stage times the connection itself (connectTimeoutMs, then timeoutMs). The socket's
      // own connect timeout is only a backstop after both, so it never decides the outcome.
      const socketConnectTimeoutMs = Math.max(connectTimeoutMs ?? 0, timeoutMs) + SOCKET_CONNECT_BACKSTOP_MS;
      socket = openSocket(serverUrl, { connectTimeoutMs: socketConnectTimeoutMs, nodeWebSocket });
      socket.binaryType = 'arraybuffer';
    } catch (error) {
      fail(new SpeedTestError(getFailureReasonOr(error, 'connectionFailed'), `Failed to create WebSocket: ${error}`));
      return;
    }

    if (connectTimeoutMs) {
      // A WebSocket has no connect timeout of its own: a network that drops the connection
      // would otherwise hold the run until the latency timeout.
      connectTimer = setTimeout(() => {
        if (didConnect) return;
        fail(new SocketConnectError(`Connection not open after ${connectTimeoutMs}ms`, 'connectionTimeout'));
      }, connectTimeoutMs);
    }

    socket.onopen = () => {
      didConnect = true;
      if (connectTimer) clearTimeout(connectTimer);
      sendPing();
    };

    socket.onmessage = (event) => {
      const now = performance.now();
      if (typeof event.data !== 'string' || event.data !== 'PONG' || pingStartTime === null) {
        return;
      }

      const pingTimeMs = roundTo3Decimals(now - pingStartTime);
      pingTimes.push(pingTimeMs);
      onPing?.(pingTimeMs, pingTimes.length - 1);

      if (sentPings >= pingCount) {
        complete();
        return;
      }

      sendPing();
    };

    socket.onerror = () => {
      // Failing before the socket opened means the server could not be reached this way.
      fail(
        didConnect
          ? new SpeedTestError('connectionFailed', 'WebSocket error during latency test')
          : new SocketConnectError('WebSocket connection failed during latency test')
      );
    };

    socket.onclose = () => {
      if (pingTimes.length >= 3) {
        complete();
      }
    };
  });
}

export function computeLatencyData(latencies: number[]): LatencyTestData {
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
    minLatency: roundTo3Decimals(minLatency),
    averageLatency: roundTo3Decimals(averageLatency),
    medianLatency: roundTo3Decimals(medianLatency),
    maxLatency: roundTo3Decimals(maxLatency),
    minJitter: roundTo3Decimals(minJitter),
    averageJitter: roundTo3Decimals(averageJitter),
    medianJitter: roundTo3Decimals(medianJitter),
    maxJitter: roundTo3Decimals(maxJitter),
  };
}
