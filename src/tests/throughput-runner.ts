import type { LatencyTestData, SpeedTestData, SpeedSnapshot } from '../types/speed-test.js';
import { CancellationToken, CancellationError } from '../utils/cancellation.js';
import { calculateSpeedMbps } from '../utils/speed.js';
import { createLoadedLatencyMonitor } from './loaded-latency-test.js';
import {
  openThroughputLane,
  type ThroughputDirection,
  type ThroughputLane,
  type ThroughputLaneCallbacks,
} from './throughput-lanes.js';
import { openWorkerLanes } from './worker-lanes.js';

export interface ThroughputTestOptions {
  serverUrl: string;
  messageSizeKb: number;
  connectionCount: number;
  durationMs: number;
  latencyMs: number;
  jitterMs: number;
  snapshotIntervalMs?: number;
  /**
   * Threads to spread the sockets across. Values above 1 use worker threads in Node.js and
   * fall back to the calling thread everywhere else. Defaults to 1.
   */
  threads?: number;
  cancellationToken: CancellationToken;
  onSnapshot?: (snapshot: SpeedSnapshot) => void;
}

/**
 * Runs a download or upload throughput stage: opens the lanes, starts them together once
 * every socket is connected, emits snapshots, and resolves after `durationMs`.
 */
export function runThroughputTest(
  direction: ThroughputDirection,
  options: ThroughputTestOptions
): Promise<SpeedTestData> {
  const {
    serverUrl,
    messageSizeKb,
    connectionCount,
    durationMs,
    latencyMs,
    jitterMs,
    snapshotIntervalMs = 100,
    threads = 1,
    cancellationToken,
    onSnapshot,
  } = options;

  return new Promise<SpeedTestData>((resolve, reject) => {
    let lanes: ThroughputLane[] | null = null;
    let openedLanes = 0;
    let testStartTime: number | null = null;
    let settled = false;
    let snapshotTimer: ReturnType<typeof setInterval> | null = null;
    let finishTimer: ReturnType<typeof setTimeout> | null = null;
    const snapshots: SpeedSnapshot[] = [];
    const adjustmentMs = latencyMs + jitterMs;
    const loadedLatencyMonitor = createLoadedLatencyMonitor({
      serverUrl,
      cancellationToken,
    });

    const totalBytes = () => {
      let bytes = 0;
      for (const lane of lanes ?? []) bytes += lane.bytes;
      return bytes;
    };

    const cleanup = () => {
      if (snapshotTimer) clearInterval(snapshotTimer);
      if (finishTimer) clearTimeout(finishTimer);
      for (const lane of lanes ?? []) lane.close();
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
      const bytes = totalBytes();
      const effectiveDurationMs = Math.max(elapsed - adjustmentMs, 1);
      const speedMbps = calculateSpeedMbps(bytes, effectiveDurationMs);

      let loadedLatency: LatencyTestData | null = null;
      try {
        loadedLatency = await loadedLatencyMonitor.stop();
      } catch (error) {
        if (error instanceof CancellationError) {
          settle(reject, error);
          return;
        }
      }

      settle(resolve, {
        durationMs: elapsed,
        speedMbps,
        bytes,
        snapshots,
        loadedLatency,
      });
    };

    cancellationToken.onCancel(() => settle(reject, new CancellationError()));

    const startTest = () => {
      testStartTime = performance.now();

      snapshotTimer = setInterval(() => {
        if (testStartTime === null || settled) return;
        const elapsed = performance.now() - testStartTime;
        const bytes = totalBytes();
        const effectiveDurationMs = Math.max(elapsed - adjustmentMs, 1);
        const snapshot: SpeedSnapshot = {
          timeOffsetMs: elapsed,
          speedMbps: calculateSpeedMbps(bytes, effectiveDurationMs),
          bytes,
        };
        snapshots.push(snapshot);
        onSnapshot?.(snapshot);
      }, snapshotIntervalMs);

      finishTimer = setTimeout(() => {
        void finishTest();
      }, durationMs);

      try {
        loadedLatencyMonitor.start();
      } catch (error) {
        settle(reject, error instanceof Error ? error : new Error(String(error)));
        return;
      }

      for (const lane of lanes ?? []) lane.start();
    };

    const maybeStart = () => {
      if (!settled && lanes && testStartTime === null && openedLanes === lanes.length) {
        startTest();
      }
    };

    const callbacks: ThroughputLaneCallbacks = {
      onOpen: () => {
        openedLanes++;
        maybeStart();
      },
      onError: (error) => settle(reject, error),
    };

    const laneOptions = { serverUrl, connectionCount, messageSizeKb };
    const openLocalLane = () => openThroughputLane(direction, laneOptions, callbacks);

    const attach = (opened: ThroughputLane[]) => {
      if (settled) {
        for (const lane of opened) lane.close();
        return;
      }
      lanes = opened;
      maybeStart();
    };

    if (threads > 1 && connectionCount > 1) {
      openWorkerLanes(direction, { ...laneOptions, threads }, callbacks)
        .then((workerLanes) => attach(workerLanes ?? [openLocalLane()]))
        .catch((error: unknown) =>
          settle(reject, error instanceof Error ? error : new Error(String(error)))
        );
      return;
    }

    try {
      attach([openLocalLane()]);
    } catch (error) {
      settle(reject, error instanceof Error ? error : new Error(String(error)));
    }
  });
}
