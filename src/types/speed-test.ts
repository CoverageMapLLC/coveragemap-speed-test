import type { NetworkTestResultTestResults } from './test-results.js';

export type SpeedTestStage =
  | 'idle'
  | 'latency'
  | 'downloadEstimation'
  | 'download'
  | 'uploadEstimation'
  | 'upload'
  | 'complete'
  | 'error';

export interface LatencyTestData {
  latencies: number[];
  minLatency: number;
  averageLatency: number;
  medianLatency: number;
  maxLatency: number;
  minJitter: number;
  averageJitter: number;
  medianJitter: number;
  maxJitter: number;
}

export interface SpeedEstimationResult {
  durationMs: number;
  bytes: number;
  speedMbps: number;
}

export interface SpeedSnapshot {
  timeOffsetMs: number;
  speedMbps: number;
  bytes: number;
}

export interface SpeedTestData {
  durationMs: number;
  speedMbps: number;
  bytes: number;
  snapshots: SpeedSnapshot[];
  loadedLatency: LatencyTestData | null;
}

export interface SpeedTestConfig {
  pingCount: number;
  downloadDurationMs: number;
  uploadDurationMs: number;
  snapshotIntervalMs: number;
  latencyTimeoutMs: number;
  estimationTimeoutMs: number;
  /**
   * Most threads the download and upload stages may spread their sockets across. `0` (the
   * default) chooses from the estimated speed, `1` keeps every socket on the calling thread.
   * Extra threads are Node.js worker threads, used only with Node's built-in WebSocket.
   */
  throughputThreads?: number;
}

export interface SpeedTestSelection {
  latency?: boolean;
  download?: boolean;
  upload?: boolean;
}

export const DEFAULT_CONFIG: SpeedTestConfig = {
  pingCount: 10,
  downloadDurationMs: 10000,
  uploadDurationMs: 10000,
  snapshotIntervalMs: 100,
  latencyTimeoutMs: 10000,
  estimationTimeoutMs: 15000,
  throughputThreads: 0,
};

export interface SpeedTestCallbacks {
  onStageChange?: (stage: SpeedTestStage) => void;
  onLatencyPing?: (latencyMs: number, index: number) => void;
  onLatencyResult?: (data: LatencyTestData) => void;
  onDownloadProgress?: (snapshot: SpeedSnapshot) => void;
  onDownloadResult?: (data: SpeedTestData) => void;
  onUploadProgress?: (snapshot: SpeedSnapshot) => void;
  onUploadResult?: (data: SpeedTestData) => void;
  onComplete?: (
    latencyData: LatencyTestData | null,
    downloadData: SpeedTestData | null,
    uploadData: SpeedTestData | null,
    result: NetworkTestResultTestResults
  ) => void;
  onError?: (error: Error, stage: SpeedTestStage) => void;
}

export function getDownloadMessageSizeKb(estimatedMbps: number): number {
  if (estimatedMbps < 0.5) return 1;
  if (estimatedMbps < 1) return 16;
  if (estimatedMbps < 10) return 32;
  if (estimatedMbps < 20) return 64;
  if (estimatedMbps < 30) return 128;
  if (estimatedMbps < 40) return 256;
  if (estimatedMbps < 50) return 512;
  return 1024;
}

export function getDownloadConnectionCount(estimatedMbps: number): number {
  if (estimatedMbps < 0.5) return 1;
  if (estimatedMbps < 1) return 2;
  if (estimatedMbps < 10) return 4;
  if (estimatedMbps < 100) return 6;
  if (estimatedMbps < 1000) return 8;
  return 10;
}

export function getUploadMessageSizeKb(estimatedMbps: number): number {
  if (estimatedMbps < 0.5) return 1;
  if (estimatedMbps < 1) return 16;
  if (estimatedMbps < 10) return 128;
  if (estimatedMbps < 50) return 512;
  return 1024;
}

export function getUploadConnectionCount(estimatedMbps: number): number {
  if (estimatedMbps < 0.5) return 1;
  if (estimatedMbps < 1) return 2;
  if (estimatedMbps < 10) return 4;
  if (estimatedMbps < 100) return 6;
  if (estimatedMbps < 1000) return 8;
  return 10;
}

/** Estimated speed per thread when spreading multi-gigabit tests across threads. */
const MBPS_PER_THROUGHPUT_THREAD = 1000;
const MAX_AUTO_THROUGHPUT_THREADS = 4;

/**
 * Threads for a throughput stage. Below 1 Gbps one thread is plenty. Faster links get a
 * thread per estimated gigabit, up to 4, unless `configuredThreads` sets the maximum.
 */
export function getThroughputThreadCount(estimatedMbps: number, configuredThreads = 0): number {
  const auto = Math.min(
    MAX_AUTO_THROUGHPUT_THREADS,
    Math.max(1, Math.ceil(estimatedMbps / MBPS_PER_THROUGHPUT_THREAD))
  );
  if (estimatedMbps < MBPS_PER_THROUGHPUT_THREAD) return 1;
  return configuredThreads > 0 ? Math.min(auto, configuredThreads) : auto;
}
