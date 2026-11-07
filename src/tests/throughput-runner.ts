import type { LatencyTestData, SpeedTestData, SpeedSnapshot } from '../types/speed-test.js';
import { CancellationToken, CancellationError } from '../utils/cancellation.js';
import { calculateSpeedSinceMbps, calculateStageSpeedMbps } from '../utils/speed.js';
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
   * The speed is measured from this long after the first bytes of the stage are counted, so the
   * ramp-up at the start does not count. `0` measures the whole stage. Defaults to 250 ms.
   */
  rampUpExclusionMs?: number;
  /**
   * Threads to spread the sockets across. Values above 1 use worker threads in Node.js and
   * fall back to the calling thread everywhere else. Defaults to 1.
   */
  threads?: number;
  cancellationToken: CancellationToken;
  onSnapshot?: (snapshot: SpeedSnapshot) => void;
}

export const DEFAULT_RAMP_UP_EXCLUSION_MS = 250;

/**
 * Runs a download or upload throughput stage: opens the lanes, starts them together once
 * every socket is connected, emits snapshots, and resolves after `durationMs`.
 *
 * The speed is measured from `rampUpExclusionMs` after the first bytes of the stage are counted
 * (acknowledged, for upload) to its end, so the start of the ramp-up does not count. Before that
 * point, when the stage ends before it, or with `rampUpExclusionMs = 0`, the speed is the whole
 * stage's less the latency bias, which the result also reports as `overallSpeedMbps`. The stage
 * still lasts `durationMs` from when the sockets opened. The loaded latency monitor connects at
 * the start but pings from that same point (the first bytes with an exclusion of 0), once the
 * link carries the stage's traffic.
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
    rampUpExclusionMs = DEFAULT_RAMP_UP_EXCLUSION_MS,
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
    let rampUpTimer: ReturnType<typeof setTimeout> | null = null;
    let finishing = false;
    let sawFirstBytes = false;
    /** Where the measurement starts, in ms into the stage; null until then. */
    let measuredFromMs: number | null = null;
    let measuredFromBytes = 0;
    const snapshots: SpeedSnapshot[] = [];
    const loadedLatencyMonitor = createLoadedLatencyMonitor({
      serverUrl,
      cancellationToken,
    });

    const totalBytes = () => {
      let bytes = 0;
      for (const lane of lanes ?? []) bytes += lane.bytes;
      return bytes;
    };

    /** The speed after `elapsed` ms and `bytes`: measured from the measurement start once there is one. */
    const speed = (bytes: number, elapsed: number) =>
      measuredFromMs !== null && elapsed > measuredFromMs
        ? calculateSpeedSinceMbps(bytes, elapsed, measuredFromBytes, measuredFromMs)
        : calculateStageSpeedMbps(bytes, elapsed, latencyMs, jitterMs);

    /** The first bytes of the stage were counted: the link is loading. */
    const firstBytes = () => {
      if (sawFirstBytes || settled || finishing || testStartTime === null) return;
      sawFirstBytes = true;
      if (rampUpExclusionMs <= 0) {
        loadedLatencyMonitor.linkLoaded();
        return;
      }
      rampUpTimer = setTimeout(() => {
        rampUpTimer = null;
        if (settled || finishing || testStartTime === null) return;
        measuredFromMs = performance.now() - testStartTime;
        measuredFromBytes = totalBytes();
        loadedLatencyMonitor.linkLoaded();
      }, rampUpExclusionMs);
    };

    const cleanup = () => {
      if (snapshotTimer) clearInterval(snapshotTimer);
      if (finishTimer) clearTimeout(finishTimer);
      if (rampUpTimer) clearTimeout(rampUpTimer);
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
      finishing = true;
      if (rampUpTimer) clearTimeout(rampUpTimer);
      rampUpTimer = null;
      const elapsed = performance.now() - testStartTime;
      const bytes = totalBytes();
      const speedMbps = speed(bytes, elapsed);
      const overallSpeedMbps = calculateStageSpeedMbps(bytes, elapsed, latencyMs, jitterMs);

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
        overallSpeedMbps,
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
        const snapshot: SpeedSnapshot = {
          timeOffsetMs: elapsed,
          speedMbps: speed(bytes, elapsed),
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
      onBytes: () => {
        if (!sawFirstBytes) firstBytes();
      },
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
