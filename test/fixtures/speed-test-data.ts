import type { LatencyTestData } from '../../src/types/speed-test.js';

export const mockLoadedLatency: LatencyTestData = {
  latencies: [15, 16, 14],
  minLatency: 14,
  averageLatency: 15,
  medianLatency: 15,
  maxLatency: 16,
  minJitter: 1,
  averageJitter: 1,
  medianJitter: 1,
  maxJitter: 2,
};
