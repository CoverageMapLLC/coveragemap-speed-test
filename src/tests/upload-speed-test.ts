import type { SpeedTestData } from '../types/speed-test.js';
import { runThroughputTest, type ThroughputTestOptions } from './throughput-runner.js';

export type UploadSpeedTestOptions = ThroughputTestOptions;

/**
 * Sends binary chunks to the server over `connectionCount` sockets for `durationMs` and
 * measures the bytes the server acknowledged.
 */
export async function runUploadSpeedTest(options: UploadSpeedTestOptions): Promise<SpeedTestData> {
  return runThroughputTest('upload', options);
}
