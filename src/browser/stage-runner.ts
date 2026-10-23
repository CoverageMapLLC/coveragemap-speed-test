import type { LatencyTestData, SpeedEstimationResult, SpeedTestData } from '../types/speed-test.js';
import { runDownloadEstimationTest, type DownloadEstimationTestOptions } from '../tests/download-estimation-test.js';
import { runDownloadSpeedTest } from '../tests/download-speed-test.js';
import { runLatencyTest, type LatencyTestOptions } from '../tests/latency-test.js';
import type { ThroughputTestOptions } from '../tests/throughput-runner.js';
import { runUploadEstimationTest, type UploadEstimationTestOptions } from '../tests/upload-estimation-test.js';
import { runUploadSpeedTest } from '../tests/upload-speed-test.js';

/**
 * Runs the network stages of a test. The engine uses one per run: on the calling thread
 * (`local`), or in browsers inside a dedicated Web Worker (`worker`) so the page's own work
 * cannot delay the sockets or the timing.
 */
export interface StageRunner {
  readonly mode: 'local' | 'worker';
  runLatencyTest(options: LatencyTestOptions): Promise<LatencyTestData>;
  runDownloadEstimationTest(options: DownloadEstimationTestOptions): Promise<SpeedEstimationResult>;
  runUploadEstimationTest(options: UploadEstimationTestOptions): Promise<SpeedEstimationResult>;
  runDownloadSpeedTest(options: ThroughputTestOptions): Promise<SpeedTestData>;
  runUploadSpeedTest(options: ThroughputTestOptions): Promise<SpeedTestData>;
  /** Releases the worker, if any. */
  close(): void;
}

export const localStageRunner: StageRunner = {
  mode: 'local',
  runLatencyTest,
  runDownloadEstimationTest,
  runUploadEstimationTest,
  runDownloadSpeedTest,
  runUploadSpeedTest,
  close() {},
};
