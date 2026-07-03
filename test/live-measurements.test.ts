import { describe, expect, it } from 'vitest';
import {
  mergeCompletedMeasurements,
  type LiveMeasurements,
} from '../demos/react-vite/src/live-measurements';

function completedResult(testsRun: { latency: boolean }, measurements: LiveMeasurements) {
  return {
    testType: { testsRun },
    results: { measurements },
  };
}

describe('live measurement completion merge', () => {
  it('preserves latency-stage values when latency test is enabled', () => {
    const previous = {
      downloadSpeed: 80,
      uploadSpeed: null,
      latency: 32,
      jitter: 7,
      downloadLoadedLatency: 45,
      uploadLoadedLatency: null,
    };

    const merged = mergeCompletedMeasurements(
      previous,
      completedResult(
        { latency: true },
        {
          downloadSpeed: 120,
          uploadSpeed: 40,
          latency: 12,
          jitter: 2,
          downloadLoadedLatency: null,
          uploadLoadedLatency: null,
        }
      )
    );

    expect(merged).toEqual({
      downloadSpeed: 120,
      uploadSpeed: 40,
      latency: 32,
      jitter: 7,
      downloadLoadedLatency: 45,
      uploadLoadedLatency: null,
    });
  });

  it('uses completed fallback latency values when latency test is disabled', () => {
    const previous = {
      downloadSpeed: 80,
      uploadSpeed: null,
      latency: null,
      jitter: null,
      downloadLoadedLatency: null,
      uploadLoadedLatency: null,
    };

    const merged = mergeCompletedMeasurements(
      previous,
      completedResult(
        { latency: false },
        {
          downloadSpeed: 120,
          uploadSpeed: 40,
          latency: 12,
          jitter: 2,
          downloadLoadedLatency: null,
          uploadLoadedLatency: null,
        }
      )
    );

    expect(merged).toEqual({
      downloadSpeed: 120,
      uploadSpeed: 40,
      latency: 12,
      jitter: 2,
      downloadLoadedLatency: null,
      uploadLoadedLatency: null,
    });
  });
});
