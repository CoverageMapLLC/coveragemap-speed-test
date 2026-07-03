import type { LatencyTestData } from '../types/speed-test.js';
import { CancellationToken, CancellationError } from '../utils/cancellation.js';
import { roundTo3Decimals } from '../utils/speed.js';
import { computeLatencyData } from './latency-test.js';

const DEFAULT_PING_INTERVAL_MS = 1000;
const STOP_GRACE_MS = 100;

export interface LoadedLatencyTestOptions {
  serverUrl: string;
  pingIntervalMs?: number;
  cancellationToken: CancellationToken;
  onPing?: (latencyMs: number, index: number) => void;
}

export interface LoadedLatencyMonitor {
  start: () => void;
  stop: () => Promise<LatencyTestData | null>;
}

export function createLoadedLatencyMonitor(options: LoadedLatencyTestOptions): LoadedLatencyMonitor {
  const { serverUrl, pingIntervalMs = DEFAULT_PING_INTERVAL_MS, cancellationToken, onPing } = options;

  let socket: WebSocket | null = null;
  const pingTimes: number[] = [];
  let pingStartTime: number | null = null;
  let pingTimer: ReturnType<typeof setTimeout> | null = null;
  let isRunning = false;
  let isStopped = false;
  let stopPromise: Promise<LatencyTestData | null> | null = null;
  let stopResolve: ((data: LatencyTestData | null) => void) | null = null;
  let stopReject: ((error: Error) => void) | null = null;
  let stopGraceTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (pingTimer) clearTimeout(pingTimer);
    pingTimer = null;
    if (stopGraceTimer) clearTimeout(stopGraceTimer);
    stopGraceTimer = null;
    try {
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.close();
      }
    } catch {
      // ignore close errors
    }
    socket = null;
  };

  const failStop = (error: Error) => {
    if (stopReject) {
      stopReject(error);
      stopResolve = null;
      stopReject = null;
    }
  };

  const completeStop = () => {
    cleanup();
    if (pingTimes.length === 0) {
      stopResolve?.(null);
      stopResolve = null;
      stopReject = null;
      return;
    }
    stopResolve?.(computeLatencyData(pingTimes));
    stopResolve = null;
    stopReject = null;
  };

  const scheduleNextPing = () => {
    if (isStopped || !isRunning) return;
    pingTimer = setTimeout(() => {
      sendPing();
    }, pingIntervalMs);
  };

  const sendPing = () => {
    if (isStopped || !isRunning || cancellationToken.isCancelled) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    try {
      socket.send('PING');
      pingStartTime = performance.now();
    } catch (error) {
      isStopped = true;
      isRunning = false;
      failStop(new Error(`Failed to send loaded latency ping: ${error}`));
    }
  };

  cancellationToken.onCancel(() => {
    if (isStopped) return;
    isStopped = true;
    isRunning = false;
    cleanup();
    failStop(new CancellationError());
  });

  return {
    start() {
      if (isRunning || isStopped) return;
      isRunning = true;

      try {
        socket = new WebSocket(serverUrl);
        socket.binaryType = 'arraybuffer';
      } catch (error) {
        isStopped = true;
        isRunning = false;
        throw new Error(`Failed to create loaded latency WebSocket: ${error}`);
      }

      socket.onopen = () => {
        sendPing();
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== 'string' || event.data !== 'PONG' || pingStartTime === null) {
          return;
        }

        const pingTimeMs = roundTo3Decimals(performance.now() - pingStartTime);
        pingTimes.push(pingTimeMs);
        onPing?.(pingTimeMs, pingTimes.length - 1);
        pingStartTime = null;

        if (isStopped) {
          completeStop();
          return;
        }

        scheduleNextPing();
      };

      socket.onerror = () => {
        if (isStopped) return;
        isStopped = true;
        isRunning = false;
        failStop(new Error('WebSocket error during loaded latency test'));
        cleanup();
      };

      socket.onclose = () => {
        if (isStopped && stopResolve) {
          completeStop();
        }
      };
    },

    stop(): Promise<LatencyTestData | null> {
      if (stopPromise) return stopPromise;

      stopPromise = new Promise<LatencyTestData | null>((resolve, reject) => {
        stopResolve = resolve;
        stopReject = reject;

        isStopped = true;
        isRunning = false;
        if (pingTimer) clearTimeout(pingTimer);
        pingTimer = null;

        if (pingStartTime === null) {
          completeStop();
          return;
        }

        stopGraceTimer = setTimeout(() => {
          try {
            if (socket && socket.readyState !== WebSocket.CLOSED) {
              socket.close();
            } else {
              completeStop();
            }
          } catch {
            completeStop();
          }
        }, STOP_GRACE_MS);
      });

      return stopPromise;
    },
  };
}
