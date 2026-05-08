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
}

export interface SpeedTestConfig {
  pingCount: number;
  downloadDurationMs: number;
  uploadDurationMs: number;
  snapshotIntervalMs: number;
  latencyTimeoutMs: number;
  estimationTimeoutMs: number;
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
};

export interface SpeedTestCallbacks {
  onStageChange?: (stage: SpeedTestStage) => void;
  onLatencyPing?: (latencyMs: number, index: number) => void;
  onLatencyResult?: (data: LatencyTestData) => void;
  onDownloadProgress?: (snapshot: SpeedSnapshot) => void;
  onDownloadResult?: (data: SpeedTestData) => void;
  onUploadProgress?: (snapshot: SpeedSnapshot) => void;
  onUploadResult?: (data: SpeedTestData) => void;
  onComplete?: (downloadMbps: number, uploadMbps: number, latencyMs: number) => void;
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
