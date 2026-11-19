import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDownloadSpeedTest } from '../src/tests/download-speed-test.js';
import {
  LOADED_LATENCY_DELAY_MS,
  RAMP_UP_EXCLUSION_MS,
  type ThroughputTestOptions,
} from '../src/tests/throughput-runner.js';
import { runUploadSpeedTest } from '../src/tests/upload-speed-test.js';
import type { SpeedTestData } from '../src/types/speed-test.js';
import { CancellationToken } from '../src/utils/cancellation.js';

const round3 = (value: number) => Math.round(value * 1000) / 1000;
/** The whole stage's speed, less the latency bias. */
const stageSpeed = (bytes: number, elapsedMs: number, biasMs: number) =>
  round3(bytes / (Math.max(elapsedMs - biasMs, 1) * 125));
/** The speed measured from `fromMs` into the stage, with `fromBytes` counted then. */
const speedSince = (bytes: number, elapsedMs: number, fromBytes: number, fromMs: number) =>
  round3((bytes - fromBytes) / ((elapsedMs - fromMs) * 125));
/** The live speed `onSnapshot` reports: from the stage's speed to the measured one over 1 s. */
const liveSpeed = (bytes: number, elapsedMs: number, fromBytes: number, fromMs: number, biasMs: number) => {
  const stage = stageSpeed(bytes, elapsedMs, biasMs);
  if (elapsedMs <= fromMs) return stage;
  const measured = speedSince(bytes, elapsedMs, fromBytes, fromMs);
  const since = elapsedMs - fromMs;
  return since >= 1000 ? measured : round3(stage + (measured - stage) * (since / 1000));
};

const UPLOAD_CHUNK_BYTES = 8 * 1024;

/**
 * Traffic on a fixed schedule from when the stage starts its traffic: the first delivery
 * `firstMs` later, then one every `everyMs`. `units(at)` is the delivery `at` ms into the
 * stage: download bytes, or upload ACKs.
 */
interface Feed {
  firstMs: number;
  everyMs: number;
  units: (at: number) => number;
}

/**
 * The first socket carries the stage's traffic on the `feed` schedule, the second is the
 * loaded latency socket. Every socket opens `openDelayMs[index]` after it is created.
 */
class RampSocketMock {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: RampSocketMock[] = [];
  static feed: Feed;
  static openDelayMs: number[] = [];
  /** `performance.now()` when the stage started its traffic. */
  static trafficStartedAt: number | null = null;

  readyState = RampSocketMock.CONNECTING;
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  /** ms into the stage of each PING. */
  pings: number[] = [];
  private feeding = false;
  private feedTimer: ReturnType<typeof setInterval> | null = null;

  constructor(_url: string) {
    const index = RampSocketMock.instances.push(this) - 1;
    setTimeout(() => {
      this.readyState = RampSocketMock.OPEN;
      this.onopen?.(new Event('open'));
    }, RampSocketMock.openDelayMs[index] ?? 0);
  }

  send(payload: string | Uint8Array): void {
    if (payload === 'PING') {
      this.pings.push(performance.now() - (RampSocketMock.trafficStartedAt ?? 0));
      setTimeout(() => this.onmessage?.({ data: 'PONG' } as MessageEvent), 5);
      return;
    }
    if (typeof payload === 'string' && payload.startsWith('START')) {
      this.startFeed((count) => this.onmessage?.({ data: new ArrayBuffer(count) } as MessageEvent));
      return;
    }
    if (payload instanceof Uint8Array) {
      this.startFeed((count) => {
        for (let i = 0; i < count; i++) this.onmessage?.({ data: 'ACK' } as MessageEvent);
      });
    }
  }

  close(): void {
    if (this.feedTimer) clearInterval(this.feedTimer);
    this.readyState = RampSocketMock.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }

  private startFeed(deliver: (count: number) => void): void {
    if (this.feeding) return;
    this.feeding = true;
    const startedAt = performance.now();
    RampSocketMock.trafficStartedAt = startedAt;
    const { firstMs, everyMs, units } = RampSocketMock.feed;
    const tick = () => {
      if (this.readyState !== RampSocketMock.OPEN) return;
      deliver(units(performance.now() - startedAt));
    };
    setTimeout(() => {
      tick();
      this.feedTimer = setInterval(tick, everyMs);
    }, firstMs);
  }
}

/** Every delivery that the feed made at or before `untilMs` into the stage, summed. */
function delivered(feed: Feed, untilMs: number, unitBytes = 1): number {
  let total = 0;
  for (let at = feed.firstMs; at <= untilMs; at += feed.everyMs) total += feed.units(at) * unitBytes;
  return total;
}

const BASE_OPTIONS = {
  serverUrl: 'wss://speed.example.com/v1/ws',
  connectionCount: 1,
  latencyMs: 10,
  jitterMs: 2,
  snapshotIntervalMs: 100,
};
const BIAS_MS = 12;

async function run(
  direction: 'download' | 'upload',
  options: Partial<ThroughputTestOptions> & { durationMs: number }
): Promise<{ result: SpeedTestData; snapshots: SpeedTestData['snapshots']; live: SpeedTestData['snapshots'] }> {
  const live: SpeedTestData['snapshots'] = [];
  const runStage = direction === 'download' ? runDownloadSpeedTest : runUploadSpeedTest;
  const promise = runStage({
    ...BASE_OPTIONS,
    messageSizeKb: direction === 'download' ? 64 : UPLOAD_CHUNK_BYTES / 1024,
    cancellationToken: new CancellationToken(),
    onSnapshot: (snapshot) => live.push({ ...snapshot }),
    ...options,
  });
  await vi.advanceTimersByTimeAsync(options.durationMs + 500);
  const result = await promise;
  // `snapshots`: stored in the result, at the measured speed. `live`: what onSnapshot got.
  return { result, snapshots: result.snapshots, live };
}

describe('throughput ramp-up exclusion', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    });
    vi.stubGlobal('WebSocket', RampSocketMock as unknown as typeof WebSocket);
  });

  afterEach(() => {
    RampSocketMock.instances = [];
    RampSocketMock.openDelayMs = [];
    RampSocketMock.trafficStartedAt = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('measures the download from 250 ms after a slow first byte', async () => {
    // The first byte arrives 405 ms into the stage; 10 kB per 20 ms, then 100 Mbps.
    const feed: Feed = { firstMs: 405, everyMs: 20, units: (at) => (at < 655 ? 10_000 : 250_000) };
    RampSocketMock.feed = feed;
    const { result, snapshots, live } = await run('download', { durationMs: 3000 });

    const fromMs = 405 + 250;
    const fromBytes = delivered(feed, fromMs);
    expect(result.durationMs).toBe(3000);
    expect(result.bytes).toBe(delivered(feed, 3000));
    expect(result.speedMbps).toBe(speedSince(result.bytes, 3000, fromBytes, fromMs));
    expect(result.speedMbps).toBeCloseTo(99.79, 2);
    // Leaving out the ramp-up raises the speed above the whole stage's.
    expect(result.speedMbps).toBeGreaterThan(stageSpeed(result.bytes, 3000, BIAS_MS));

    // Snapshots use the stage's speed until the measurement starts, then the measured speed.
    const before = snapshots.filter((snapshot) => snapshot.timeOffsetMs < fromMs);
    const after = snapshots.filter((snapshot) => snapshot.timeOffsetMs > fromMs && snapshot.timeOffsetMs <= 3000);
    expect(before.map((s) => s.timeOffsetMs)).toEqual([100, 200, 300, 400, 500, 600]);
    expect(after.length).toBeGreaterThan(20);
    for (const snapshot of before) {
      expect(snapshot.speedMbps).toBe(stageSpeed(snapshot.bytes, snapshot.timeOffsetMs, BIAS_MS));
    }
    for (const snapshot of after) {
      expect(snapshot.speedMbps).toBe(speedSince(snapshot.bytes, snapshot.timeOffsetMs, fromBytes, fromMs));
    }
    // The live speed is the same until the measurement start, then moves to the measured speed
    // over the next second, and is the measured speed from then on.
    expect(live.map((s) => s.timeOffsetMs)).toEqual(snapshots.map((s) => s.timeOffsetMs));
    live.forEach((snapshot, index) => {
      expect(snapshot.bytes).toBe(snapshots[index].bytes);
      expect(snapshot.speedMbps).toBe(liveSpeed(snapshot.bytes, snapshot.timeOffsetMs, fromBytes, fromMs, BIAS_MS));
      if (snapshot.timeOffsetMs < fromMs || snapshot.timeOffsetMs >= fromMs + 1000) {
        expect(snapshot.speedMbps).toBe(snapshots[index].speedMbps);
      }
    });
    const blending = live.filter((s) => s.timeOffsetMs > fromMs && s.timeOffsetMs < fromMs + 1000);
    expect(blending.map((s) => s.timeOffsetMs)).toEqual([700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600]);
    for (let i = 1; i < blending.length; i++) {
      expect(blending[i].speedMbps).toBeGreaterThanOrEqual(blending[i - 1].speedMbps);
    }
    // The final speed continues the last live values.
    expect(after.at(-1)!.speedMbps).toBeCloseTo(result.speedMbps, 0);
    expect(live.at(-1)!.speedMbps).toBe(after.at(-1)!.speedMbps);

    // Loaded latency pings start 1 s after the first byte, then 500 ms after each PONG.
    const latencySocket = RampSocketMock.instances[1];
    expect(latencySocket.pings[0]).toBe(405 + 1000);
    expect(latencySocket.pings[1]).toBe(405 + 1000 + 5 + 500);
    expect(result.loadedLatency!.latencies.length).toBe(latencySocket.pings.length);
  });

  it('keeps the live speed from dropping when the first window after the start holds no data', async () => {
    // 500 kB lumps every 80 ms from 105 ms: the measurement starts at 355 ms, and the snapshot
    // 45 ms later falls before the next lump at 425 ms.
    const feed: Feed = { firstMs: 105, everyMs: 80, units: () => 500_000 };
    RampSocketMock.feed = feed;
    const { snapshots, live } = await run('download', { durationMs: 2000 });

    const at = (list: SpeedTestData['snapshots'], ms: number) => list.find((s) => s.timeOffsetMs === ms)!;
    // The measured speed of that 45 ms window is 0; the live speed stays near the stage's.
    expect(at(snapshots, 400).speedMbps).toBe(0);
    expect(at(live, 400).speedMbps).toBeGreaterThan(at(live, 300).speedMbps * 0.9);
    expect(at(live, 400).speedMbps).toBe(round3(stageSpeed(at(live, 400).bytes, 400, BIAS_MS) * (1 - 45 / 1000)));
  });

  it('still counts a ramp-up that lasts longer than the exclusion', async () => {
    // Slow until 1.4 s into the stage, well past the 250 ms exclusion after the first byte.
    const feed: Feed = { firstMs: 405, everyMs: 20, units: (at) => (at < 1405 ? 50_000 : 250_000) };
    RampSocketMock.feed = feed;
    const { result } = await run('download', { durationMs: 3000 });

    const fromMs = 655;
    expect(result.speedMbps).toBe(speedSince(result.bytes, 3000, delivered(feed, fromMs), fromMs));
    expect(result.speedMbps).toBeLessThan(80);
    expect(result.speedMbps).toBeGreaterThan(stageSpeed(result.bytes, 3000, BIAS_MS));
  });

  it('uses the whole stage when the stage ends before the measurement starts', async () => {
    const feed: Feed = { firstMs: 405, everyMs: 20, units: () => 250_000 };
    RampSocketMock.feed = feed;
    const { result, snapshots } = await run('download', { durationMs: 600 });

    expect(result.bytes).toBe(delivered(feed, 600));
    expect(result.speedMbps).toBe(stageSpeed(result.bytes, 600, BIAS_MS));
    for (const snapshot of snapshots) {
      expect(snapshot.speedMbps).toBe(stageSpeed(snapshot.bytes, snapshot.timeOffsetMs, BIAS_MS));
    }
    // The link was never loaded: no pings, no loaded latency.
    expect(RampSocketMock.instances[1].pings).toEqual([]);
    expect(result.loadedLatency).toBeNull();
  });

  it('uses the whole stage for a stage that ends within 250 ms of its first byte', async () => {
    const feed: Feed = { firstMs: 5, everyMs: 20, units: (at) => (at < 100 ? 10_000 : 250_000) };
    RampSocketMock.feed = feed;
    const { result, snapshots } = await run('download', { durationMs: 200, snapshotIntervalMs: 50 });

    expect(result.speedMbps).toBe(stageSpeed(delivered(feed, 200), 200, BIAS_MS));
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
    for (const snapshot of snapshots) {
      expect(snapshot.speedMbps).toBe(stageSpeed(snapshot.bytes, snapshot.timeOffsetMs, BIAS_MS));
    }
  });

  it('starts loaded latency 1 s after the first byte, apart from the measurement start', async () => {
    const feed: Feed = { firstMs: 105, everyMs: 20, units: () => 250_000 };
    RampSocketMock.feed = feed;
    const { result } = await run('download', { durationMs: 2000 });

    // The measurement starts 250 ms after the first byte; the pings 1 s after it.
    const fromMs = 105 + RAMP_UP_EXCLUSION_MS;
    expect(result.speedMbps).toBe(speedSince(result.bytes, 2000, delivered(feed, fromMs), fromMs));
    expect(RampSocketMock.instances[1].pings[0]).toBe(105 + LOADED_LATENCY_DELAY_MS);
    expect(result.loadedLatency).not.toBeNull();
  });

  it('reports no loaded latency when the stage ends before the delay', async () => {
    const feed: Feed = { firstMs: 105, everyMs: 20, units: () => 250_000 };
    RampSocketMock.feed = feed;
    const { result } = await run('download', { durationMs: 1000 });

    // The measurement started 250 ms after the first byte, but the pings never did.
    const fromMs = 355;
    expect(result.speedMbps).toBe(speedSince(result.bytes, 1000, delivered(feed, fromMs), fromMs));
    expect(RampSocketMock.instances[1].pings).toEqual([]);
    expect(result.loadedLatency).toBeNull();
  });

  it('pings when the loaded latency socket opens if the link was loaded first', async () => {
    RampSocketMock.feed = { firstMs: 105, everyMs: 20, units: () => 250_000 };
    RampSocketMock.openDelayMs = [0, 1300];
    const { result } = await run('download', { durationMs: 2000 });

    expect(RampSocketMock.instances[1].pings[0]).toBe(1300);
    expect(result.loadedLatency).not.toBeNull();
  });

  it('uses fixed values that applications cannot configure', async () => {
    expect(RAMP_UP_EXCLUSION_MS).toBe(250);
    expect(LOADED_LATENCY_DELAY_MS).toBe(1000);
    const { DEFAULT_CONFIG } = await import('../src/types/speed-test.js');
    expect(Object.keys(DEFAULT_CONFIG)).not.toContain('rampUpExclusionMs');
    expect(Object.keys(DEFAULT_CONFIG)).not.toContain('loadedLatencyDelayMs');
  });

  it('measures the upload from 250 ms after the first ACK', async () => {
    // Two 8 KiB chunks acknowledged every 20 ms from 105 ms into the stage: 6.6 Mbps, whose
    // 10 ms is the 8 KiB chunk, so the lane keeps that size and every ACK credits 8 KiB.
    const feed: Feed = { firstMs: 105, everyMs: 20, units: () => 2 };
    RampSocketMock.feed = feed;
    const { result, snapshots, live } = await run('upload', { durationMs: 1500 });

    const fromMs = 105 + 250;
    const fromBytes = delivered(feed, fromMs, UPLOAD_CHUNK_BYTES);
    expect(result.bytes).toBe(delivered(feed, 1500, UPLOAD_CHUNK_BYTES));
    expect(result.speedMbps).toBe(speedSince(result.bytes, 1500, fromBytes, fromMs));
    for (const snapshot of snapshots.filter((s) => s.timeOffsetMs < fromMs)) {
      expect(snapshot.speedMbps).toBe(stageSpeed(snapshot.bytes, snapshot.timeOffsetMs, BIAS_MS));
    }
    for (const snapshot of snapshots.filter((s) => s.timeOffsetMs > fromMs && s.timeOffsetMs <= 1500)) {
      expect(snapshot.speedMbps).toBe(speedSince(snapshot.bytes, snapshot.timeOffsetMs, fromBytes, fromMs));
    }
    for (const snapshot of live) {
      expect(snapshot.speedMbps).toBe(liveSpeed(snapshot.bytes, snapshot.timeOffsetMs, fromBytes, fromMs, BIAS_MS));
    }
    // Loaded latency pings start 1 s after the first ACK.
    expect(RampSocketMock.instances[1].pings[0]).toBe(105 + 1000);
  });
});
