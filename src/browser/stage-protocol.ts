import type {
  LatencyTestData,
  SpeedEstimationResult,
  SpeedSnapshot,
  SpeedTestData,
} from '../types/speed-test.js';
import { CancellationError } from '../utils/cancellation.js';
import { SocketConnectError } from '../tests/sockets.js';

/**
 * Messages between the engine and the Web Worker that runs the test stages in browsers.
 * Everything is plain data: the cancellation token and the callbacks stay with the engine
 * and travel as `cancel`, `ping`, and `snapshot` messages.
 */

export interface LatencyStageOptions {
  serverUrl: string;
  pingCount: number;
  timeoutMs?: number;
  connectTimeoutMs?: number;
}

export interface EstimationStageOptions {
  serverUrl: string;
  latencyMs: number;
  jitterMs: number;
  timeoutMs?: number;
}

export interface ThroughputStageOptions {
  serverUrl: string;
  messageSizeKb: number;
  connectionCount: number;
  durationMs: number;
  latencyMs: number;
  jitterMs: number;
  snapshotIntervalMs?: number;
  threads?: number;
}

export type StageRequest =
  | { stage: 'latency'; options: LatencyStageOptions }
  | { stage: 'downloadEstimation' | 'uploadEstimation'; options: EstimationStageOptions }
  | { stage: 'download' | 'upload'; options: ThroughputStageOptions };

export type StageName = StageRequest['stage'];

/** Engine to worker. */
export type StageCommand = ({ type: 'run'; id: number } & StageRequest) | { type: 'cancel'; id: number };

export interface SerializedError {
  name: string;
  message: string;
}

/** Worker to engine. */
export type StageEvent =
  | { type: 'ready'; webSocketSource: string | null }
  | { type: 'unsupported'; reason: string }
  | { type: 'ping'; id: number; latencyMs: number; index: number }
  | { type: 'snapshot'; id: number; snapshot: SpeedSnapshot }
  | { type: 'result'; id: number; value: LatencyTestData | SpeedEstimationResult | SpeedTestData }
  | { type: 'error'; id: number; error: SerializedError };

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

/** Rebuilds the error types the engine tells apart: cancellation and failed connections. */
export function deserializeError(error: SerializedError): Error {
  if (error.name === 'CancellationError') return new CancellationError();
  if (error.name === 'SocketConnectError') return new SocketConnectError(error.message);
  const rebuilt = new Error(error.message);
  rebuilt.name = error.name;
  return rebuilt;
}
