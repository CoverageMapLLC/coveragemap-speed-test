import type { SpeedTestData } from '../types/speed-test.js';
import { runThroughputTest, type ThroughputTestOptions } from './throughput-runner.js';

export type DownloadSpeedTestOptions = ThroughputTestOptions;

/**
 * Streams binary frames from the server over `connectionCount` sockets for `durationMs` and
 * measures the received bytes.
 */
export async function runDownloadSpeedTest(
  options: DownloadSpeedTestOptions
): Promise<SpeedTestData> {
  return runThroughputTest('download', options);
}
