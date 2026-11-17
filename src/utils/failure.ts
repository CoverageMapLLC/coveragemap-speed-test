/**
 * Why a test failed, as reported in `measurements.failedReason` (`"<reason>: <message>"`).
 * The same values as the native engine's `FailureReason`, so results from every CoverageMap
 * client can be grouped by cause:
 *
 * - `unreachable`: the server cannot be reached from this runtime at all (no transport it offers
 *   can be used here).
 * - `connectionFailed`: a connection was refused, could not be created, or dropped.
 * - `connectionTimeout`: a connection did not open in time.
 * - `transferTimeout`: a throughput stage did not move data.
 * - `timeout`: a stage did not finish in time after it connected.
 * - `protocolError`: the server answered with something the protocol does not allow.
 * - `unknown`: anything else.
 */
export type SpeedTestFailureReason =
  | 'unreachable'
  | 'connectionFailed'
  | 'connectionTimeout'
  | 'transferTimeout'
  | 'timeout'
  | 'protocolError'
  | 'unknown';

const FAILURE_REASONS: readonly string[] = [
  'unreachable',
  'connectionFailed',
  'connectionTimeout',
  'transferTimeout',
  'timeout',
  'protocolError',
  'unknown',
];

export function isSpeedTestFailureReason(value: unknown): value is SpeedTestFailureReason {
  return typeof value === 'string' && FAILURE_REASONS.includes(value);
}

/** An error tagged with why the test failed. */
export class SpeedTestError extends Error {
  readonly reason: SpeedTestFailureReason;

  constructor(reason: SpeedTestFailureReason, message: string) {
    super(message);
    this.name = 'SpeedTestError';
    this.reason = reason;
  }
}

/** The reason an error is tagged with (`error.reason`), or `unknown`. */
export function getFailureReason(error: unknown): SpeedTestFailureReason {
  const reason = (error as { reason?: unknown } | null)?.reason;
  return isSpeedTestFailureReason(reason) ? reason : 'unknown';
}

/**
 * The reason `error` is tagged with, or `fallback` for an untagged error. For errors that wrap
 * another one, such as a socket constructor that threw.
 */
export function getFailureReasonOr(error: unknown, fallback: SpeedTestFailureReason): SpeedTestFailureReason {
  const reason = getFailureReason(error);
  return reason === 'unknown' ? fallback : reason;
}

/** `measurements.failedReason` for an error: `"<reason>: <message>"`. */
export function formatFailedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${getFailureReason(error)}: ${message}`;
}
