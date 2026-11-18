import { describe, expect, it } from 'vitest';
import { getNextUploadChunkSizeKb, getUploadInFlightLimitBytes } from '../src/tests/throughput-lanes.js';
import {
  DOWNLOAD_MESSAGE_SIZES_KB,
  ESTIMATION_TIME_CAP_MS,
  MAX_ESTIMATION_BYTES,
  RateMeter,
  UPLOAD_CHUNK_SIZES_KB,
  estimationReference,
  getDownloadMessageSizeForSpeedKb,
  getDownloadRefillMessages,
  getFirstDownloadMessageSizeKb,
  getUploadChunkSizeForSpeedKb,
  measureEstimationRound,
  nearestSizeKb,
  nextEstimationBytes,
  nextEstimationStep,
  stalledEstimationRounds,
  type EstimationRound,
} from '../src/utils/adaptive.js';

const KB = 1024;
/** A round of `kb` KiB at `mbps`, `stallMs` slower. */
const round = (kb: number, mbps: number, stallMs = 0): EstimationRound =>
  measureEstimationRound(kb * KB, (kb * KB) / (mbps * 125) + stallMs, 0, 0);

describe('estimation rounds', () => {
  it('triple from 10 KiB (download) and 5 KiB (upload) up to 5 MiB', () => {
    const sizes = (bytes: number) => {
      const all = [bytes / KB];
      while (bytes < MAX_ESTIMATION_BYTES) all.push((bytes = nextEstimationBytes(bytes)) / KB);
      return all;
    };
    expect(sizes(10 * KB)).toEqual([10, 30, 90, 270, 810, 2430, 5120]);
    expect(sizes(5 * KB)).toEqual([5, 15, 45, 135, 405, 1215, 3645, 5120]);
  });

  it('take the latency bias off, at least 1 ms', () => {
    expect(measureEstimationRound(125_000, 150, 30, 20)).toEqual({ bytes: 125_000, durationMs: 100, speedMbps: 10 });
    expect(measureEstimationRound(10_000, 20, 30, 20).durationMs).toBe(1);
  });

  it('grow while a round is under 100 ms', () => {
    expect(nextEstimationStep([round(10, 900)], 20)).toBe('grow');
    expect(nextEstimationStep([round(10, 900), round(30, 900)], 40)).toBe('grow');
  });

  it('stop on a clean round of 100 ms or more', () => {
    // 1 Mbps: the first round already takes 82 ms; the second, 245 ms
    expect(nextEstimationStep([round(10, 1)], 100)).toBe('grow');
    expect(nextEstimationStep([round(10, 1), round(30, 1)], 400)).toBe('stop');
    // A slow first round is never trusted alone: a 100 kbps link takes a second round
    expect(nextEstimationStep([round(10, 0.1)], 900)).toBe('grow');
    expect(nextEstimationStep([round(10, 0.1), round(30, 0.1)], 1900)).toBe('stop');
    // ...which tells a first round that stalled from a slow link
    expect(nextEstimationStep([round(5, 900, 300), round(15, 900)], 400)).toBe('grow');
  });

  it("go on past a round that stalled below half the fastest of the last three", () => {
    // 900 Mbps with a 200 ms retransmission in the 270 KiB round
    const rounds = [round(30, 900), round(90, 900), round(270, 900, 200)];
    expect(rounds[2].durationMs).toBeGreaterThanOrEqual(100);
    expect(nextEstimationStep(rounds, 400)).toBe('grow');
    // 8 Mbps, then a 270 KiB round at 6 Mbps (368 ms): still at least half, so the link: stop
    expect(nextEstimationStep([round(90, 8), round(270, 6)], 500)).toBe('stop');
    // At 3 Mbps it fell under half: a stall, grow
    expect(nextEstimationStep([round(90, 8), round(270, 3)], 900)).toBe('grow');
  });

  it('compare each round with the fastest earlier round that did not stall', () => {
    // 900 Mbps with 200 ms recoveries in three rounds in a row
    const rounds = [round(10, 900), round(30, 900), round(90, 900, 200), round(270, 900, 200), round(810, 900, 200)];
    expect(stalledEstimationRounds(rounds)).toEqual([false, false, true, true, true]);
    // Against one another the third stall (32 → 90 Mbps) would look clean; against the clean
    // rounds it stalled, so estimation goes on
    expect(nextEstimationStep(rounds, 700)).toBe('grow');
    // When the last three rounds all stalled, the estimate is the fastest clean round
    expect(estimationReference(rounds)).toBe(rounds[1]);
    // A first slow round is never a stall, and is the baseline until a faster clean round
    expect(stalledEstimationRounds([round(10, 0.1), round(30, 0.1)])).toEqual([false, false]);
  });

  it('stop at 5 MiB when the round is short, and repeat it when it stalled', () => {
    expect(nextEstimationStep([round(2430, 9000), round(5120, 9000)], 300)).toBe('stop');
    expect(nextEstimationStep([round(2430, 900), round(5120, 900, 400)], 300)).toBe('repeat');
  });

  it(`stop ${ESTIMATION_TIME_CAP_MS} ms after the first round started, whatever the round`, () => {
    expect(nextEstimationStep([round(10, 900)], ESTIMATION_TIME_CAP_MS)).toBe('stop');
    expect(nextEstimationStep([round(810, 900), round(2430, 900, 900)], ESTIMATION_TIME_CAP_MS)).toBe('stop');
  });

  it('estimate the fastest of the last three rounds, leaving out earlier small rounds', () => {
    // A small round that read too fast (the latency bias left it 1 ms) doesn't count once three
    // larger rounds followed
    const rounds = [round(10, 80), round(30, 900), round(90, 900), round(270, 900, 200), round(810, 850)];
    rounds[0] = { ...rounds[0], speedMbps: 5000 };
    expect(estimationReference(rounds)).toBe(rounds[4]);
    expect(estimationReference(rounds.slice(0, 2))).toBe(rounds[0]);
    expect(estimationReference([])).toBeNull();
  });
});

describe('message sizes', () => {
  it('are powers of two from 1 KiB, up to 4 MiB and 5 MiB down, 1 MiB up', () => {
    expect(DOWNLOAD_MESSAGE_SIZES_KB).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 5120]);
    expect(UPLOAD_CHUNK_SIZES_KB).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]);
    // About 13 MB together, so a server's buffer pool holds every one
    expect(DOWNLOAD_MESSAGE_SIZES_KB.reduce((sum, kb) => sum + kb, 0) * KB).toBeLessThan(14 * 1024 * KB);
  });

  it('round to the nearest size by ratio', () => {
    expect(nearestSizeKb(0, DOWNLOAD_MESSAGE_SIZES_KB)).toBe(1);
    expect(nearestSizeKb(Number.NaN, DOWNLOAD_MESSAGE_SIZES_KB)).toBe(1);
    expect(nearestSizeKb(1.4, DOWNLOAD_MESSAGE_SIZES_KB)).toBe(1);
    expect(nearestSizeKb(1.5, DOWNLOAD_MESSAGE_SIZES_KB)).toBe(2);
    expect(nearestSizeKb(12.8, DOWNLOAD_MESSAGE_SIZES_KB)).toBe(16);
    expect(nearestSizeKb(4500, DOWNLOAD_MESSAGE_SIZES_KB)).toBe(4096);
    expect(nearestSizeKb(4600, DOWNLOAD_MESSAGE_SIZES_KB)).toBe(5120);
    expect(nearestSizeKb(1_000_000, DOWNLOAD_MESSAGE_SIZES_KB)).toBe(5120);
    expect(nearestSizeKb(5000, UPLOAD_CHUNK_SIZES_KB)).toBe(1024);
  });

  it('hold 10 ms of a connection, and a first download batch 2.5 ms', () => {
    const table = [0.1, 1, 10, 100, 1000, 3000].map((mbps) => [
      mbps,
      getDownloadMessageSizeForSpeedKb(mbps),
      getUploadChunkSizeForSpeedKb(mbps),
      getFirstDownloadMessageSizeKb(mbps),
    ]);
    expect(table).toEqual([
      [0.1, 1, 1, 1],
      [1, 1, 1, 1],
      [10, 16, 16, 4],
      [100, 128, 128, 32],
      [1000, 1024, 1024, 256],
      [3000, 4096, 1024, 1024],
    ]);
  });
});

describe('download refill lead', () => {
  it('covers max(two round trips, 300 ms) at the message rate, at most one batch', () => {
    expect(getDownloadRefillMessages(null, 50)).toBe(100);
    expect(getDownloadRefillMessages(0, 50)).toBe(100);
    expect(getDownloadRefillMessages(100, 20)).toBe(30);
    expect(getDownloadRefillMessages(100, 300)).toBe(60);
    expect(getDownloadRefillMessages(10_000, 20)).toBe(200);
  });
});

describe('upload chunk sizes', () => {
  it('hold 10 ms of the acknowledged speed', () => {
    expect(getNextUploadChunkSizeKb(1024, 1)).toBe(1);
    expect(getNextUploadChunkSizeKb(1, 100)).toBe(128);
    expect(getNextUploadChunkSizeKb(64, null)).toBe(64);
  });
});

describe('upload data in flight', () => {
  it('is 64 chunks until the speed is known', () => {
    expect(getUploadInFlightLimitBytes(1 * KB, null, 300)).toBe(64 * KB);
    expect(getUploadInFlightLimitBytes(1024 * KB, null, 20)).toBe(64 * 1024 * KB);
  });

  it('covers 8 round trips of the acknowledged speed, at least 50 ms each', () => {
    // 100 Mbps at 300 ms: 8 round trips are 30 MB
    expect(getUploadInFlightLimitBytes(128 * KB, 100, 300)).toBe(30_000_000);
    // A short path still allows 8 × 50 ms
    expect(getUploadInFlightLimitBytes(1 * KB, 100, 5)).toBe(5_000_000);
    // A slow link keeps a small queue: 64 chunks are more than 8 round trips at 1 Mbps
    expect(getUploadInFlightLimitBytes(1 * KB, 1, 20)).toBe(64 * KB);
    // At most 64 MiB, however fast
    expect(getUploadInFlightLimitBytes(1024 * KB, 20_000, 50)).toBe(64 * 1024 * KB);
    expect(getUploadInFlightLimitBytes(4 * KB, 10_000, 300)).toBe(64 * 1024 * KB);
  });

  it('grows about 8 times per round trip while it limits the speed', () => {
    // 1 KiB chunks at 300 ms: 64 KiB in flight acknowledges 1.7 Mbps
    let limit = getUploadInFlightLimitBytes(1 * KB, null, 300);
    const growth: number[] = [];
    for (let i = 0; i < 3; i++) {
      const mbps = limit / (300 * 125);
      const next = getUploadInFlightLimitBytes(1 * KB, mbps, 300);
      growth.push(next / limit);
      limit = next;
    }
    expect(growth.every((factor) => factor === 8)).toBe(true);
  });
});

describe('rate meter', () => {
  it('reads the rate over the last 500 ms, once it has 50 ms of history', () => {
    const meter = new RateMeter();
    meter.record(0, 0);
    expect(meter.ratePerSecond(40, 40)).toBeNull();
    for (let t = 10; t <= 2000; t += 10) meter.record(t, t);
    expect(meter.ratePerSecond(2000, 2000)).toBe(1000);
    // The speed changed in the last 500 ms: only that counts
    expect(meter.ratePerSecond(2000, 2500)).toBeCloseTo(2000, -1);
    expect(meter.mbps(2000, 2000)).toBe(0.008);
  });

  it('keeps few samples on a busy socket', () => {
    const meter = new RateMeter();
    for (let t = 0; t < 10_000; t += 0.1) meter.record(t, t);
    expect((meter as unknown as { times: number[] }).times.length).toBeLessThan(60);
  });
});
