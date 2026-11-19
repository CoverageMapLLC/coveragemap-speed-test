import {
  MAX_CONNECTION_COUNT,
  getDownloadConnectionCount,
  getUploadConnectionCount,
  type LatencyTestData,
  type SpeedTestData,
  type SpeedSnapshot,
} from '../types/speed-test.js';
import {
  RateMeter,
  getFirstDownloadMessageSizeKb,
  getFirstUploadChunkSizeKb,
} from '../utils/adaptive.js';
import { CancellationToken, CancellationError } from '../utils/cancellation.js';
import { SpeedTestError } from '../utils/failure.js';
import {
  calculateLiveSpeedMbps,
  calculateSpeedSinceMbps,
  calculateStageSpeedMbps,
} from '../utils/speed.js';
import { createLoadedLatencyMonitor } from './loaded-latency-test.js';
import {
  SCALE_UP_SETTLE_MS,
  openThroughputLane,
  type ThroughputDirection,
  type ThroughputLane,
  type ThroughputLaneCallbacks,
} from './throughput-lanes.js';
import { openWorkerLanes } from './worker-lanes.js';

export interface ThroughputTestOptions {
  serverUrl: string;
  /** The first message size, in KiB (see `ThroughputLaneOptions.messageSizeKb`). */
  messageSizeKb: number;
  /** Connections the stage starts with. The scale-up may add more (see `SCALE_UP_CHECKS_MS`). */
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
  /**
   * Called with each snapshot, with its live `speedMbps`: like the stored snapshot's, but moving
   * from the whole-stage speed to the measured speed over the `LIVE_SPEED_BLEND_MS` after the
   * measurement start (see `calculateLiveSpeedMbps`), so a progress display does not jump there.
   */
  onSnapshot?: (snapshot: SpeedSnapshot) => void;
  /** `false` opens WebSockets with `globalThis.WebSocket`, not the Node.js client. See `SpeedTestConfig.nodeWebSocket`. */
  nodeWebSocket?: boolean;
}

/** The speed is measured from this long after the stage's first counted bytes, leaving out the ramp-up. */
export const RAMP_UP_EXCLUSION_MS = 250;
/** Loaded latency pings start this long after the stage's first counted bytes, once the link is loaded. */
export const LOADED_LATENCY_DELAY_MS = 1000;
/**
 * A throughput stage that has counted no bytes this long after its sockets opened fails with
 * `transferTimeout`, as in the native engines (their `transferTimeoutMs` default). A stage
 * shorter than this that moves nothing fails the same way when it ends: a stage that moved no
 * data did not measure the link.
 */
export const TRANSFER_TIMEOUT_MS = 10_000;
/**
 * The scale-up checks, in ms after the stage's first counted bytes. At each one, a stage whose
 * speed over the last 500 ms calls for more connections than it has (the same table as the
 * estimate) opens the difference at once, up to 12. It never closes any. A bad estimate had
 * left links with 1% loss on 2 to 4 connections, measuring 417 to 790 Mbps of 940.
 */
export const SCALE_UP_CHECKS_MS: readonly number[] = [1000, 2000, 3000];
/**
 * A stage scales up only for a speed this many times the next tier's threshold. The scale-up is
 * for estimates far too low, not for links near a threshold: right after the ramp-up, data the
 * client hadn't read yet arrives in a burst, and a 940 Mbps link read over 1 Gbps for a moment.
 */
export const SCALE_UP_MARGIN = 1.25;
/** A scale-up check runs only while at least this much of the stage is left to measure. */
export const MIN_SCALE_UP_REMAINING_MS = 3000;
/** The runner's own wait for added sockets to settle, should a lane never report. */
const SCALE_UP_SETTLE_FALLBACK_MS = SCALE_UP_SETTLE_MS + 250;
const RATE_SAMPLE_INTERVAL_MS = 50;

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
 *
 * `onSnapshot` gets the live speed, which moves from the whole-stage speed to the measured speed
 * over the second after the measurement start; the snapshots stored in the result keep the
 * measured speed.
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
    nodeWebSocket,
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
    /**
     * After a scale-up restarted the measurement, the live speed blends from the value shown at
     * that moment, not from the whole stage's (see `liveSpeed`).
     */
    let liveFromMbps: number | null = null;
    let lastLiveMbps = 0;
    const snapshots: SpeedSnapshot[] = [];
    const connectionCountFor = direction === 'download' ? getDownloadConnectionCount : getUploadConnectionCount;
    /** Connections asked for, the added ones included. */
    let requestedConnections = connectionCount;
    const rate = new RateMeter();
    let rateTimer: ReturnType<typeof setInterval> | null = null;
    const scaleUpTimers: Array<ReturnType<typeof setTimeout>> = [];
    let restartTimer: ReturnType<typeof setTimeout> | null = null;
    let nextScaleUpId = 0;
    /** Scale-ups still waiting for their lanes, by id. */
    const scaleUps = new Map<number, { lanes: number; opened: number; fallback: ReturnType<typeof setTimeout> }>();
    const loadedLatencyMonitor = createLoadedLatencyMonitor({
      serverUrl,
      cancellationToken,
      nodeWebSocket,
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

    /**
     * The live speed for `onSnapshot`: the whole-stage speed until the measurement start, then
     * moving to `speed` over `LIVE_SPEED_BLEND_MS`. Right after the start the measured window is
     * a few ms long, and holds no message or `ACK` at all, or a whole one: the live speed would
     * drop to about 0 or spike.
     */
    const liveSpeed = (bytes: number, elapsed: number) => {
      const stageSpeed = calculateStageSpeedMbps(bytes, elapsed, latencyMs, jitterMs);
      if (measuredFromMs === null || elapsed <= measuredFromMs) return stageSpeed;
      const measured = calculateSpeedSinceMbps(bytes, elapsed, measuredFromBytes, measuredFromMs);
      return calculateLiveSpeedMbps(liveFromMbps ?? stageSpeed, measured, elapsed - measuredFromMs);
    };

    let transferTimer: ReturnType<typeof setTimeout> | null = null;
    const noDataError = (afterMs: number, at: 'after' | 'in') =>
      new SpeedTestError('transferTimeout', `No ${direction} data ${at} ${Math.round(afterMs)} ms`);

    const clearStageTimers = () => {
      if (transferTimer) clearTimeout(transferTimer);
      transferTimer = null;
      if (rampUpTimer) clearTimeout(rampUpTimer);
      rampUpTimer = null;
      if (loadedLatencyTimer) clearTimeout(loadedLatencyTimer);
      loadedLatencyTimer = null;
      if (rateTimer) clearInterval(rateTimer);
      rateTimer = null;
      for (const timer of scaleUpTimers) clearTimeout(timer);
      scaleUpTimers.length = 0;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      for (const scaleUp of scaleUps.values()) clearTimeout(scaleUp.fallback);
      scaleUps.clear();
    };

    /** Measures from now on, leaving out the connections a scale-up added while they ramped up. */
    const restartMeasurement = () => {
      restartTimer = null;
      if (settled || finishing || testStartTime === null) return;
      measuredFromMs = performance.now() - testStartTime;
      measuredFromBytes = totalBytes();
      liveFromMbps = lastLiveMbps;
    };

    /** Every lane reported a scale-up's sockets, or the runner stopped waiting: measure again 250 ms later. */
    const scaleUpSettled = (scaleUpId: number) => {
      const scaleUp = scaleUps.get(scaleUpId);
      if (!scaleUp) return;
      clearTimeout(scaleUp.fallback);
      scaleUps.delete(scaleUpId);
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = setTimeout(restartMeasurement, RAMP_UP_EXCLUSION_MS);
    };

    /** A scale-up check (see `SCALE_UP_CHECKS_MS`). */
    const checkScaleUp = () => {
      if (settled || finishing || testStartTime === null || !lanes) return;
      const now = performance.now();
      const elapsed = now - testStartTime;
      if (durationMs - elapsed < MIN_SCALE_UP_REMAINING_MS) return;
      const mbps = rate.mbps(elapsed, totalBytes());
      if (mbps === null) return;
      const target = Math.min(connectionCountFor(mbps / SCALE_UP_MARGIN), MAX_CONNECTION_COUNT);
      if (target <= requestedConnections) return;
      const added = target - requestedConnections;
      requestedConnections = target;

      // New connections start at the stage's speed per connection, as its first ones did
      const perConnectionMbps = mbps / target;
      const messageSizeKb =
        direction === 'download'
          ? getFirstDownloadMessageSizeKb(perConnectionMbps)
          : getFirstUploadChunkSizeKb(perConnectionMbps);
      // Spread over the lanes (threads) with the fewest connections
      const shares = new Map<ThroughputLane, number>();
      const countOf = (lane: ThroughputLane) => lane.connectionCount + (shares.get(lane) ?? 0);
      for (let i = 0; i < added; i++) {
        let lane = lanes[0];
        for (const candidate of lanes) if (countOf(candidate) < countOf(lane)) lane = candidate;
        shares.set(lane, (shares.get(lane) ?? 0) + 1);
      }

      const scaleUpId = ++nextScaleUpId;
      scaleUps.set(scaleUpId, {
        lanes: shares.size,
        opened: 0,
        fallback: setTimeout(() => scaleUpSettled(scaleUpId), SCALE_UP_SETTLE_FALLBACK_MS),
      });
      for (const [lane, count] of shares) lane.addConnections(count, messageSizeKb, scaleUpId);
    };

    /**
     * The first bytes of the stage were counted: the link is loading. Schedules the measurement
     * start and, independently, the first loaded latency ping.
     */
    const firstBytes = () => {
      if (sawFirstBytes || settled || finishing || testStartTime === null) return;
      sawFirstBytes = true;
      const stageLeftMs = durationMs - (performance.now() - testStartTime);
      for (const atMs of SCALE_UP_CHECKS_MS) {
        if (atMs < stageLeftMs) scaleUpTimers.push(setTimeout(checkScaleUp, atMs));
      }
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
      // Also when the stage failed: close the loaded latency socket. stop() is idempotent, so a
      // stage that finished normally (and already awaited it) is unaffected.
      void loadedLatencyMonitor.stop().catch(() => {});
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
        settle(reject, new SpeedTestError('transferTimeout', 'Test never started'));
        return;
      }
      finishing = true;
      clearStageTimers();
      if (snapshotTimer) clearInterval(snapshotTimer);
      snapshotTimer = null;
      const elapsed = performance.now() - testStartTime;
      const bytes = totalBytes();
      if (bytes === 0) {
        settle(reject, noDataError(durationMs, 'in'));
        return;
      }
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
        initialConnectionCount: connectionCount,
        requestedConnectionCount: requestedConnections,
        // Added connections count once they opened, also after their scale-up settled
        connectionCount: (lanes ?? []).reduce((sum, lane) => sum + lane.openedConnectionCount, 0),
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
        const live = liveSpeed(bytes, elapsed);
        lastLiveMbps = live;
        onSnapshot?.(live === snapshot.speedMbps ? snapshot : { ...snapshot, speedMbps: live });
      }, snapshotIntervalMs);

      // The speed over the last 500 ms, for the scale-up checks
      rate.record(0, 0);
      rateTimer = setInterval(() => {
        if (testStartTime === null) return;
        rate.record(performance.now() - testStartTime, totalBytes());
      }, RATE_SAMPLE_INTERVAL_MS);

      finishTimer = setTimeout(() => {
        void finishTest();
      }, durationMs);

      if (TRANSFER_TIMEOUT_MS < durationMs) {
        transferTimer = setTimeout(() => {
          transferTimer = null;
          if (!settled && !finishing && totalBytes() === 0) settle(reject, noDataError(TRANSFER_TIMEOUT_MS, 'after'));
        }, TRANSFER_TIMEOUT_MS);
      }

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
      onScaleUpSettled: (scaleUpId, opened) => {
        const scaleUp = scaleUps.get(scaleUpId);
        if (!scaleUp) return;
        scaleUp.opened += opened;
        if (--scaleUp.lanes <= 0) scaleUpSettled(scaleUpId);
      },
    };

    const laneOptions = { serverUrl, connectionCount, messageSizeKb, latencyMs, nodeWebSocket };
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
