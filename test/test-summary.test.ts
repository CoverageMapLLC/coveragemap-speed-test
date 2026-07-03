import { describe, expect, it } from 'vitest';
import { EMPTY_CALLBACK_STATE } from '../demos/react-vite/src/live-measurements';
import { mockLoadedLatency } from './fixtures/speed-test-data.js';
import { selectTestSummary } from '../demos/react-vite/src/test-summary';

describe('test summary selection', () => {
  it('derives summary metrics from callback state', () => {
    const summary = selectTestSummary({
      ...EMPTY_CALLBACK_STATE,
      latencyResult: {
        latencies: [10, 12, 11],
        minLatency: 10,
        averageLatency: 11,
        medianLatency: 11,
        maxLatency: 12,
        minJitter: 1,
        averageJitter: 1.5,
        medianJitter: 1.5,
        maxJitter: 2,
      },
      downloadProgress: { timeOffsetMs: 500, speedMbps: 80, bytes: 1_000_000 },
      downloadResult: {
        durationMs: 2000,
        speedMbps: 120,
        bytes: 4_000_000,
        snapshots: [],
        loadedLatency: { ...mockLoadedLatency, medianLatency: 45 },
      },
      uploadResult: {
        durationMs: 2000,
        speedMbps: 60,
        bytes: 2_000_000,
        snapshots: [],
        loadedLatency: { ...mockLoadedLatency, medianLatency: 52 },
      },
    });

    expect(summary).toEqual({
      medianLatency: 11,
      medianJitter: 1.5,
      downloadSpeed: 120,
      uploadSpeed: 60,
      downloadLoadedLatency: 45,
      uploadLoadedLatency: 52,
    });
  });

  it('uses live progress speeds before final results arrive', () => {
    const summary = selectTestSummary({
      ...EMPTY_CALLBACK_STATE,
      downloadProgress: { timeOffsetMs: 500, speedMbps: 80, bytes: 1_000_000 },
      uploadProgress: { timeOffsetMs: 500, speedMbps: 40, bytes: 500_000 },
    });

    expect(summary.downloadSpeed).toBe(80);
    expect(summary.uploadSpeed).toBe(40);
  });
});
