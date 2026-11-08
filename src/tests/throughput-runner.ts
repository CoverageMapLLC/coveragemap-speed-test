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
   * Threads to spread the sockets across. Values above 1 use worker threads in Node.js and
   * fall back to the calling thread everywhere else. Defaults to 1.
   */
  threads?: number;
  cancellationToken: CancellationToken;
  onSnapshot?: (snapshot: SpeedSnapshot) => void;
}

/** The speed is measured from this long after the stage's first counted bytes, leaving out the ramp-up. */
export const RAMP_UP_EXCLUSION_MS = 250;
/** Loaded latency pings start this long after the stage's first counted bytes, once the link is loaded. */
export const LOADED_LATENCY_DELAY_MS = 1000;

/**
 * Runs a download or upload throughput stage: opens the lanes, starts them together once
 * every socket is connected, emits snapshots, and resolves after `durationMs`.
 *
 * The speed is measured from `RAMP_UP_EXCLUSION_MS` (250 ms) after the first bytes of the stage
 * are counted (acknowledged, for upload) to its end, so the start of the ramp-up does not count.
 * Before that point, or when the stage ends before it, the speed is the whole stage's less the
 * latency bias. The stage still lasts
 * `durationMs` from when the sockets opened. The loaded latency monitor connects at the start but
 * pings from `LOADED_LATENCY_DELAY_MS` (1 s) after the first bytes, once the link carries the
 * stage's traffic.
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
    let rampUpTimer: ReturnType<typeof setTimeout> | null = null;
    let loadedLatencyTimer: ReturnType<typeof setTimeout> | null = null;
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

    const clearStageTimers = () => {
      if (rampUpTimer) clearTimeout(rampUpTimer);
      rampUpTimer = null;
      if (loadedLatencyTimer) clearTimeout(loadedLatencyTimer);
      loadedLatencyTimer = null;
    };

    /**
     * The first bytes of the stage were counted: the link is loading. Schedules the measurement
     * start and, independently, the first loaded latency ping.
     */
    const firstBytes = () => {
      if (sawFirstBytes || settled || finishing || testStartTime === null) return;
      sawFirstBytes = true;
      rampUpTimer = setTimeout(() => {
        rampUpTimer = null;
        if (settled || finishing || testStartTime === null) return;
        measuredFromMs = performance.now() - testStartTime;
        measuredFromBytes = totalBytes();
      }, RAMP_UP_EXCLUSION_MS);
      loadedLatencyTimer = setTimeout(() => {
        loadedLatencyTimer = null;
        if (settled || finishing) return;
        loadedLatencyMonitor.linkLoaded();
      }, LOADED_LATENCY_DELAY_MS);
    };

    const cleanup = () => {
      if (snapshotTimer) clearInterval(snapshotTimer);
      if (finishTimer) clearTimeout(finishTimer);
      clearStageTimers();
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
      clearStageTimers();
      if (snapshotTimer) clearInterval(snapshotTimer);
      snapshotTimer = null;
      const elapsed = performance.now() - testStartTime;
      const bytes = totalBytes();
      const speedMbps = speed(bytes, elapsed);
      // The stage is over: ask for no more data (no refill goes out after the stage), but keep
      // the sockets open, so the loaded latency monitor's last ping still measures a loaded link
      // while it waits for the PONG. cleanup() closes them once the monitor is done.
      for (const lane of lanes ?? []) lane.stopRequests();

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
