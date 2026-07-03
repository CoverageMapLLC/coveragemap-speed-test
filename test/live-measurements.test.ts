import { describe, expect, it } from 'vitest';
import {
  EMPTY_CALLBACK_STATE,
  mergeCompletedMeasurements,
  type LiveCallbackState,
} from '../demos/react-vite/src/live-measurements';
import { mockLoadedLatency } from './fixtures/speed-test-data.js';

const mockLatencyResult = {
  latencies: [32, 33, 31],
  minLatency: 31,
  averageLatency: 32,
  medianLatency: 32,
  maxLatency: 33,
  minJitter: 1,
  averageJitter: 1,
  medianJitter: 1,
  maxJitter: 2,
};

function completedResult(
  testsRun: { latency: boolean },
  measurements: {
    downloadSpeed: number | null;
    uploadSpeed: number | null;
    latency: number | null;
    jitter: number | null;
  }
) {
  return {
    testType: { testsRun },
    results: { measurements },
  };
}

function callbackState(overrides: Partial<LiveCallbackState> = {}): LiveCallbackState {
  return {
    ...EMPTY_CALLBACK_STATE,
    ...overrides,
  };
}

describe('live measurement completion merge', () => {
  it('preserves callback-stage values when latency test is enabled', () => {
    const previous = callbackState({
      latencyResult: mockLatencyResult,
      downloadResult: {
        durationMs: 2000,
        bytes: 4_000_000,
        speedMbps: 80,
        snapshots: [],
        loadedLatency: mockLoadedLatency,
      },
    });

    const merged = mergeCompletedMeasurements(
      previous,
      completedResult(
        { latency: true },
        {
          downloadSpeed: 120,
          uploadSpeed: 40,
          latency: 12,
          jitter: 2,
        }
      )
    );

    expect(merged.latencyResult).toEqual(mockLatencyResult);
    expect(merged.downloadResult?.speedMbps).toBe(80);
    expect(merged.downloadResult?.loadedLatency).toEqual(mockLoadedLatency);
  });

  it('uses completed fallback latency values when latency test is disabled', () => {
    const previous = callbackState();

    const merged = mergeCompletedMeasurements(
      previous,
      completedResult(
        { latency: false },
        {
          downloadSpeed: 120,
          uploadSpeed: 40,
          latency: 12,
          jitter: 2,
        }
      )
    );

    expect(merged.latencyResult).toEqual({
      latencies: [],
      minLatency: 12,
      averageLatency: 12,
      medianLatency: 12,
      maxLatency: 12,
      minJitter: 2,
      averageJitter: 2,
      medianJitter: 2,
      maxJitter: 2,
    });
  });
});
