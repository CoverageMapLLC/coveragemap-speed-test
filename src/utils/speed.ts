/**
 * Calculate speed in Mbps from bytes and milliseconds.
 * Formula: bytes / (ms * 125) = Mbps
 * Derivation: 1 Mbps = 125,000 bytes/sec = 125 bytes/ms
 */
export function roundTo3Decimals(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function calculateSpeedMbps(bytes: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return roundTo3Decimals(bytes / (durationMs * 125));
}

/**
 * Speed over a whole throughput stage: `elapsedMs` less the latency bias (`latencyMs + jitterMs`,
 * the wait for the first byte), at least 1 ms.
 */
export function calculateStageSpeedMbps(
  bytes: number,
  elapsedMs: number,
  latencyMs: number,
  jitterMs: number
): number {
  return calculateSpeedMbps(bytes, Math.max(elapsedMs - (latencyMs + jitterMs), 1));
}

/** Speed from the measurement start (`fromMs` into the stage, `fromBytes` counted) to `elapsedMs`. */
export function calculateSpeedSinceMbps(
  bytes: number,
  elapsedMs: number,
  fromBytes: number,
  fromMs: number
): number {
  return calculateSpeedMbps(bytes - fromBytes, elapsedMs - fromMs);
}

/**
 * How long after the measurement start the live speed takes to move from the whole-stage speed
 * to the measured speed. Progress callbacks only: stored snapshots and the result never blend.
 */
export const LIVE_SPEED_BLEND_MS = 1000;

/**
 * The live speed `sinceMeasurementStartMs` after the measurement start: `stageSpeedMbps` at the
 * start, moving in a straight line to `measuredSpeedMbps` over `LIVE_SPEED_BLEND_MS`, which it is
 * from then on. Right after the start the measured window is only milliseconds long, and its
 * speed jumps with every message or `ACK` that lands in it (or none): switching to it at once
 * made the live speed jump at the start and flicker for a moment after.
 */
export function calculateLiveSpeedMbps(
  stageSpeedMbps: number,
  measuredSpeedMbps: number,
  sinceMeasurementStartMs: number
): number {
  if (sinceMeasurementStartMs <= 0) return stageSpeedMbps;
  if (sinceMeasurementStartMs >= LIVE_SPEED_BLEND_MS) return measuredSpeedMbps;
  const weight = sinceMeasurementStartMs / LIVE_SPEED_BLEND_MS;
  return roundTo3Decimals(stageSpeedMbps + (measuredSpeedMbps - stageSpeedMbps) * weight);
}

export function formatSpeed(mbps: number): string {
  if (mbps < 0.01) return '0';
  if (mbps < 1) return mbps.toFixed(2);
  if (mbps < 10) return mbps.toFixed(1);
  return Math.round(mbps).toString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatLatency(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} us`;
  if (ms < 10) return ms.toFixed(1);
  return Math.round(ms).toString();
}
