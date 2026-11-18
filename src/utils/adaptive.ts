/**
 * The rules that adapt a test to the link: how estimation grows its rounds and when it stops,
 * and how large each throughput message is. They are pure functions of what was measured, the
 * same in every client (`docs/protocol.md`, "Estimation" and "Message sizes").
 */

import { calculateSpeedMbps } from './speed.js';

const KB = 1024;

// ---------------------------------------------------------------------------------------------
// Estimation

/** A round is long enough to measure once it takes this long beyond the latency. */
export const ESTIMATION_TARGET_MS = 100;
/** Each round asks for this many times the bytes of the round before. */
export const ESTIMATION_GROWTH = 3;
/** The largest estimation round. */
export const MAX_ESTIMATION_BYTES = 5 * 1024 * KB;
/** Estimation settles on what it has this long after its first round started. */
export const ESTIMATION_TIME_CAP_MS = 2000;
/** The estimate is the fastest of this many last rounds. */
export const ESTIMATION_REFERENCE_ROUNDS = 3;
/** A slow round under this share of the reference speed stalled (a loss), rather than ending estimation. */
export const STALLED_ROUND_RATIO = 0.5;
/** Download estimation's first round. */
export const DOWNLOAD_ESTIMATION_START_BYTES = 10 * KB;
/** Upload estimation's first round. */
export const UPLOAD_ESTIMATION_START_BYTES = 5 * KB;

export interface EstimationRound {
  bytes: number;
  /** The round's time less the latency bias, at least 1 ms. */
  durationMs: number;
  speedMbps: number;
}

/** A round of `bytes` that took `rawDurationMs`, less the latency bias (`latencyMs + jitterMs`). */
export function measureEstimationRound(
  bytes: number,
  rawDurationMs: number,
  latencyMs: number,
  jitterMs: number
): EstimationRound {
  const durationMs = Math.max(rawDurationMs - (latencyMs + jitterMs), 1);
  return { bytes, durationMs, speedMbps: calculateSpeedMbps(bytes, durationMs) };
}

/** The bytes of the round after one of `bytes`: three times as many, at most 5 MiB. */
export function nextEstimationBytes(bytes: number): number {
  return Math.min(bytes * ESTIMATION_GROWTH, MAX_ESTIMATION_BYTES);
}

/**
 * The fastest of the last `ESTIMATION_REFERENCE_ROUNDS` rounds. Small rounds are left out once
 * there are larger ones: a round of a few KB takes only milliseconds beyond the latency, so a
 * millisecond of jitter can make it read several times too fast, and larger rounds say more
 * about the link.
 */
export function estimationReference(rounds: readonly EstimationRound[]): EstimationRound | null {
  let best: EstimationRound | null = null;
  for (const round of rounds.slice(-ESTIMATION_REFERENCE_ROUNDS)) {
    if (!best || round.speedMbps > best.speedMbps) best = round;
  }
  return best;
}

export type EstimationStep = 'grow' | 'repeat' | 'stop';

/**
 * What estimation does after a round, given every round so far (the last one included) and how
 * long ago the first round started:
 *
 * - `stop` once `ESTIMATION_TIME_CAP_MS` have passed;
 * - a round under `ESTIMATION_TARGET_MS`: `grow`, or `stop` at the 5 MiB cap;
 * - a first round of `ESTIMATION_TARGET_MS` or more: `grow`. With nothing to compare it with, a
 *   slow first round can't tell a slow link from one that stalled: an upload estimate on a 300 ms
 *   path read 0.1 Mbps after its first 5 KB took a round trip longer. Only links under about
 *   0.8 Mbps take that long for the first round, so only they pay the second round;
 * - a round of `ESTIMATION_TARGET_MS` or more that reached half the reference speed is clean:
 *   `stop`;
 * - a slower one stalled, most likely on a lost packet whose recovery took a round trip or a
 *   retransmission timeout: `grow` (or `repeat` at the cap). Asking for more data can't make a
 *   link slower, and a larger round spreads the recovery over more data. Stopping there had
 *   made a 940 Mbps link with 1% loss estimate 1 to 90 Mbps.
 */
export function nextEstimationStep(
  rounds: readonly EstimationRound[],
  sinceFirstRoundMs: number
): EstimationStep {
  const round = rounds[rounds.length - 1];
  if (!round || sinceFirstRoundMs >= ESTIMATION_TIME_CAP_MS) return 'stop';
  const atCap = round.bytes >= MAX_ESTIMATION_BYTES;
  if (round.durationMs < ESTIMATION_TARGET_MS) return atCap ? 'stop' : 'grow';
  if (rounds.length === 1 && !atCap) return 'grow';
  const reference = estimationReference(rounds)!;
  if (round.speedMbps >= reference.speedMbps * STALLED_ROUND_RATIO) return 'stop';
  return atCap ? 'repeat' : 'grow';
}

// ---------------------------------------------------------------------------------------------
// Message sizes

/** A throughput message holds about this much of its connection's speed. */
export const MESSAGE_TARGET_MS = 10;
/**
 * A connection's first messages (a download connection's first batch, an upload connection's
 * first chunks) hold this much of its starting speed. Too small corrects itself at once (the
 * batch ends, or the chunks are acknowledged, quickly), too large would last a whole stage on a
 * slow link and make the gauge pulse with every large message, so they start small: up to 4
 * times slower than expected is still the 10 ms target.
 */
export const FIRST_MESSAGE_TARGET_MS = 2.5;
export const MIN_MESSAGE_SIZE_KB = 1;
export const MAX_DOWNLOAD_MESSAGE_SIZE_KB = 5 * 1024;
export const MAX_UPLOAD_CHUNK_SIZE_KB = 1024;

/**
 * Download message sizes, in KiB: powers of two from 1 KiB to 4 MiB, and 5 MiB. Servers keep one
 * zero-filled buffer per size, so clients only ask for these (about 13 MB together).
 */
export const DOWNLOAD_MESSAGE_SIZES_KB: readonly number[] = [
  ...Array.from({ length: 13 }, (_, i) => 2 ** i),
  MAX_DOWNLOAD_MESSAGE_SIZE_KB,
];
/** Upload chunk sizes, in KiB: powers of two from 1 KiB to 1 MiB. */
export const UPLOAD_CHUNK_SIZES_KB: readonly number[] = Array.from({ length: 11 }, (_, i) => 2 ** i);

/** The size in `sizesKb` nearest to `kb`, by ratio. */
export function nearestSizeKb(kb: number, sizesKb: readonly number[]): number {
  if (!(kb > sizesKb[0])) return sizesKb[0];
  let best = sizesKb[0];
  for (const size of sizesKb) {
    if (Math.abs(Math.log(size / kb)) < Math.abs(Math.log(best / kb))) best = size;
  }
  return best;
}

/** KiB that `mbps` carries in `ms`. */
function kbAt(mbps: number, ms: number): number {
  return (Math.max(mbps, 0) * 125 * ms) / KB;
}

/** The download message size for a connection at `mbps`, holding `targetMs` of it. */
export function getDownloadMessageSizeForSpeedKb(mbps: number, targetMs = MESSAGE_TARGET_MS): number {
  return nearestSizeKb(kbAt(mbps, targetMs), DOWNLOAD_MESSAGE_SIZES_KB);
}

/** The upload chunk size for a connection at `mbps`, holding `targetMs` of it. */
export function getUploadChunkSizeForSpeedKb(mbps: number, targetMs = MESSAGE_TARGET_MS): number {
  return nearestSizeKb(kbAt(mbps, targetMs), UPLOAD_CHUNK_SIZES_KB);
}

/** The first download batch's message size, for a connection starting at `mbps`. */
export function getFirstDownloadMessageSizeKb(mbps: number): number {
  return getDownloadMessageSizeForSpeedKb(mbps, FIRST_MESSAGE_TARGET_MS);
}

/** The first upload chunk size, for a connection starting at `mbps`. */
export function getFirstUploadChunkSizeKb(mbps: number): number {
  return getUploadChunkSizeForSpeedKb(mbps, FIRST_MESSAGE_TARGET_MS);
}

// ---------------------------------------------------------------------------------------------
// Download batches

/** Messages each download `START` asks for. */
export const DOWNLOAD_BATCH_MESSAGES = 200;
/** A download connection asks for its next batch when less than this long, at least, is still due. */
export const MIN_DOWNLOAD_REFILL_LEAD_MS = 300;
/** Round trips the next batch is asked for ahead of time. */
export const DOWNLOAD_REFILL_ROUND_TRIPS = 2;
/**
 * Before a connection has a speed to go by, it asks for the next batch once this many messages
 * or fewer are due, at `UNKNOWN_SPEED_GROWTH` times the size.
 */
export const UNKNOWN_SPEED_REFILL_MESSAGES = 100;
export const UNKNOWN_SPEED_GROWTH = 4;

/**
 * Messages a download connection keeps due before it asks for the next batch: as many as it
 * receives in max(2 round trips, 300 ms), at most one batch, so it never has more than two
 * batches outstanding (the Cloudflare server queues a whole `START` at once, up to 96 MiB, and
 * drops a connection with about 256 MB unsent). With no message rate yet,
 * `UNKNOWN_SPEED_REFILL_MESSAGES`.
 */
export function getDownloadRefillMessages(messagesPerSecond: number | null, latencyMs: number): number {
  if (messagesPerSecond === null || !(messagesPerSecond > 0)) return UNKNOWN_SPEED_REFILL_MESSAGES;
  const leadMs = Math.max(DOWNLOAD_REFILL_ROUND_TRIPS * latencyMs, MIN_DOWNLOAD_REFILL_LEAD_MS);
  return Math.min(Math.ceil((messagesPerSecond * leadMs) / 1000), DOWNLOAD_BATCH_MESSAGES);
}

/**
 * The next batch's message size: 10 ms of the connection's speed, or with no speed yet,
 * `UNKNOWN_SPEED_GROWTH` times the last size (a first batch that ended before a speed could be
 * measured was far too small).
 */
export function getNextDownloadMessageSizeKb(lastSizeKb: number, mbps: number | null): number {
  if (mbps === null) return nearestSizeKb(lastSizeKb * UNKNOWN_SPEED_GROWTH, DOWNLOAD_MESSAGE_SIZES_KB);
  return getDownloadMessageSizeForSpeedKb(mbps);
}

// ---------------------------------------------------------------------------------------------
// Rates

/** A connection's speed is taken over this long. */
export const RATE_WINDOW_MS = 500;
/** A rate needs at least this much history. */
export const MIN_RATE_SPAN_MS = 50;
const RATE_SAMPLE_SPACING_MS = 20;

/**
 * A running total sampled over time, to read its rate over the last `RATE_WINDOW_MS`. Samples are
 * taken at most every 20 ms and kept for twice the window, so it stays small and cheap.
 */
export class RateMeter {
  private times: number[] = [];
  private totals: number[] = [];

  /** Records `total` at `now`. */
  record(now: number, total: number): void {
    const last = this.times.length - 1;
    // Too soon after the last sample: the rate is read against the total at query time anyway
    if (last >= 0 && now - this.times[last] < RATE_SAMPLE_SPACING_MS) return;
    this.times.push(now);
    this.totals.push(total);
    while (this.times.length > 2 && now - this.times[1] > 2 * RATE_WINDOW_MS) {
      this.times.shift();
      this.totals.shift();
    }
  }

  /**
   * Units per second from the newest sample at least `RATE_WINDOW_MS` before `now` (or the oldest
   * one) to `total` now. Null with less than `MIN_RATE_SPAN_MS` of history.
   */
  ratePerSecond(now: number, total: number): number | null {
    if (this.times.length === 0) return null;
    let from = 0;
    for (let i = this.times.length - 1; i >= 0; i--) {
      if (now - this.times[i] >= RATE_WINDOW_MS) {
        from = i;
        break;
      }
    }
    const span = now - this.times[from];
    if (span < MIN_RATE_SPAN_MS) return null;
    return ((total - this.totals[from]) * 1000) / span;
  }

  /** The rate as Mbps, for a total in bytes. */
  mbps(now: number, totalBytes: number): number | null {
    const bytesPerSecond = this.ratePerSecond(now, totalBytes);
    return bytesPerSecond === null ? null : bytesPerSecond / 125_000;
  }
}
