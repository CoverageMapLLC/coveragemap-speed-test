import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDownloadSpeedTest } from '../src/tests/download-speed-test.js';
import type { ThroughputTestOptions } from '../src/tests/throughput-runner.js';
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
): Promise<{ result: SpeedTestData; snapshots: SpeedTestData['snapshots'] }> {
  const snapshots: SpeedTestData['snapshots'] = [];
  const runStage = direction === 'download' ? runDownloadSpeedTest : runUploadSpeedTest;
  const promise = runStage({
    ...BASE_OPTIONS,
    messageSizeKb: direction === 'download' ? 64 : UPLOAD_CHUNK_BYTES / 1024,
    cancellationToken: new CancellationToken(),
    onSnapshot: (snapshot) => snapshots.push({ ...snapshot }),
    ...options,
  });
  await vi.advanceTimersByTimeAsync(options.durationMs + 500);
  return { result: await promise, snapshots };
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
    const { result, snapshots } = await run('download', { durationMs: 3000 });

    const fromMs = 405 + 250;
    const fromBytes = delivered(feed, fromMs);
    expect(result.durationMs).toBe(3000);
    expect(result.bytes).toBe(delivered(feed, 3000));
    expect(result.speedMbps).toBe(speedSince(result.bytes, 3000, fromBytes, fromMs));
    expect(result.speedMbps).toBeCloseTo(99.79, 2);
    expect(result.overallSpeedMbps).toBe(stageSpeed(result.bytes, 3000, BIAS_MS));
    expect(result.overallSpeedMbps).toBeLessThan(result.speedMbps);

    // Progress uses the stage's speed until the measurement starts, then the measured speed.
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
    // The final speed continues the last live values.
    expect(after.at(-1)!.speedMbps).toBeCloseTo(result.speedMbps, 0);

    // Loaded latency pings start 1 s after the first byte, then 500 ms after each PONG.
    const latencySocket = RampSocketMock.instances[1];
    expect(latencySocket.pings[0]).toBe(405 + 1000);
    expect(latencySocket.pings[1]).toBe(405 + 1000 + 5 + 500);
    expect(result.loadedLatency!.latencies.length).toBe(latencySocket.pings.length);
  });

  it('still counts a ramp-up that lasts longer than the exclusion', async () => {
    // Slow until 1.4 s into the stage, well past the 250 ms exclusion after the first byte.
    const feed: Feed = { firstMs: 405, everyMs: 20, units: (at) => (at < 1405 ? 50_000 : 250_000) };
    RampSocketMock.feed = feed;
    const { result } = await run('download', { durationMs: 3000 });

    const fromMs = 655;
    expect(result.speedMbps).toBe(speedSince(result.bytes, 3000, delivered(feed, fromMs), fromMs));
    expect(result.speedMbps).toBeLessThan(80);
    expect(result.speedMbps).toBeGreaterThan(result.overallSpeedMbps);
  });

  it('uses the whole stage when the stage ends before the measurement starts', async () => {
    const feed: Feed = { firstMs: 405, everyMs: 20, units: () => 250_000 };
    RampSocketMock.feed = feed;
    const { result, snapshots } = await run('download', { durationMs: 600 });

    expect(result.bytes).toBe(delivered(feed, 600));
    expect(result.speedMbps).toBe(stageSpeed(result.bytes, 600, BIAS_MS));
    expect(result.overallSpeedMbps).toBe(result.speedMbps);
    for (const snapshot of snapshots) {
      expect(snapshot.speedMbps).toBe(stageSpeed(snapshot.bytes, snapshot.timeOffsetMs, BIAS_MS));
    }
    // The link was never loaded: no pings, no loaded latency.
    expect(RampSocketMock.instances[1].pings).toEqual([]);
    expect(result.loadedLatency).toBeNull();
  });

  it('measures the whole stage, as before, with an exclusion of 0', async () => {
    const feed: Feed = { firstMs: 105, everyMs: 20, units: (at) => (at < 500 ? 10_000 : 250_000) };
    RampSocketMock.feed = feed;
    const { result, snapshots } = await run('download', { durationMs: 1000, rampUpExclusionMs: 0 });

    expect(result.speedMbps).toBe(stageSpeed(delivered(feed, 1000), 1000, BIAS_MS));
    expect(result.overallSpeedMbps).toBe(result.speedMbps);
    expect(snapshots.length).toBeGreaterThan(5);
    for (const snapshot of snapshots) {
      expect(snapshot.speedMbps).toBe(stageSpeed(snapshot.bytes, snapshot.timeOffsetMs, BIAS_MS));
    }
  });

  it('pings 1 s after the first byte even with an exclusion of 0', async () => {
    RampSocketMock.feed = { firstMs: 105, everyMs: 20, units: () => 250_000 };
    const { result } = await run('download', { durationMs: 2000, rampUpExclusionMs: 0 });

    expect(RampSocketMock.instances[1].pings[0]).toBe(105 + 1000);
    expect(result.loadedLatency).not.toBeNull();
  });

  it('pings at the first byte with a loaded latency delay of 0', async () => {
    RampSocketMock.feed = { firstMs: 105, everyMs: 20, units: () => 250_000 };
    const { result } = await run('download', { durationMs: 1000, loadedLatencyDelayMs: 0 });

    expect(RampSocketMock.instances[1].pings[0]).toBe(105);
    expect(result.loadedLatency).not.toBeNull();
  });

  it('times the loaded latency delay apart from the ramp-up exclusion', async () => {
    const feed: Feed = { firstMs: 105, everyMs: 20, units: (at) => (at < 400 ? 10_000 : 250_000) };
    RampSocketMock.feed = feed;
    // Pings start 300 ms after the first byte, well before the measurement starts.
    const { result } = await run('download', {
      durationMs: 2000,
      rampUpExclusionMs: 990,
      loadedLatencyDelayMs: 300,
    });

    expect(RampSocketMock.instances[1].pings[0]).toBe(405);
    const fromMs = 105 + 990;
    expect(result.speedMbps).toBe(speedSince(result.bytes, 2000, delivered(feed, fromMs), fromMs));
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
    RampSocketMock.openDelayMs = [0, 300];
    const { result } = await run('download', { durationMs: 1000, loadedLatencyDelayMs: 0 });

    expect(RampSocketMock.instances[1].pings[0]).toBe(300);
    expect(result.loadedLatency).not.toBeNull();
  });

  it('measures the upload from 250 ms after the first ACK', async () => {
    // Four 8 KiB chunks acknowledged every 20 ms from 105 ms into the stage.
    const feed: Feed = { firstMs: 105, everyMs: 20, units: () => 4 };
    RampSocketMock.feed = feed;
    const { result, snapshots } = await run('upload', { durationMs: 1500 });

    const fromMs = 105 + 250;
    const fromBytes = delivered(feed, fromMs, UPLOAD_CHUNK_BYTES);
    expect(result.bytes).toBe(delivered(feed, 1500, UPLOAD_CHUNK_BYTES));
    expect(result.speedMbps).toBe(speedSince(result.bytes, 1500, fromBytes, fromMs));
    expect(result.overallSpeedMbps).toBe(stageSpeed(result.bytes, 1500, BIAS_MS));
    for (const snapshot of snapshots.filter((s) => s.timeOffsetMs < fromMs)) {
      expect(snapshot.speedMbps).toBe(stageSpeed(snapshot.bytes, snapshot.timeOffsetMs, BIAS_MS));
    }
    for (const snapshot of snapshots.filter((s) => s.timeOffsetMs > fromMs && s.timeOffsetMs <= 1500)) {
      expect(snapshot.speedMbps).toBe(speedSince(snapshot.bytes, snapshot.timeOffsetMs, fromBytes, fromMs));
    }
    // Loaded latency pings start 1 s after the first ACK.
    expect(RampSocketMock.instances[1].pings[0]).toBe(105 + 1000);
  });
});
