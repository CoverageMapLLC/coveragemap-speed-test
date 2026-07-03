import type {
  LatencyTestData,
  SpeedSnapshot,
  SpeedTestData,
  SpeedTestStage,
} from '../../../src/types/speed-test.js';

export type LatencyPingEntry = {
  index: number;
  latencyMs: number;
};

export type CallbackError = {
  message: string;
  stage: SpeedTestStage;
};

export type LiveCallbackState = {
  latencyPings: LatencyPingEntry[];
  latencyResult: LatencyTestData | null;
  downloadProgress: SpeedSnapshot | null;
  downloadSnapshots: SpeedSnapshot[];
  downloadResult: SpeedTestData | null;
  uploadProgress: SpeedSnapshot | null;
  uploadSnapshots: SpeedSnapshot[];
  uploadResult: SpeedTestData | null;
  complete: {
    latency: LatencyTestData | null;
    download: SpeedTestData | null;
    upload: SpeedTestData | null;
  } | null;
  lastError: CallbackError | null;
};

export const EMPTY_CALLBACK_STATE: LiveCallbackState = {
  latencyPings: [],
  latencyResult: null,
  downloadProgress: null,
  downloadSnapshots: [],
  downloadResult: null,
  uploadProgress: null,
  uploadSnapshots: [],
  uploadResult: null,
  complete: null,
  lastError: null,
};

type CompletedMeasurements = {
  testType: {
    testsRun: {
      latency: boolean;
    };
  };
  results: {
    measurements: {
      downloadSpeed: number | null;
      uploadSpeed: number | null;
      latency: number | null;
      jitter: number | null;
    };
  };
};

export function mergeCompletedMeasurements(
  previous: LiveCallbackState,
  completed: CompletedMeasurements
): LiveCallbackState {
  const completedMeasurements = completed.results.measurements;

  return {
    ...previous,
    latencyResult:
      completed.testType.testsRun.latency && previous.latencyResult
        ? previous.latencyResult
        : previous.latencyResult ??
          (completedMeasurements.latency != null
            ? {
                latencies: [],
                minLatency: completedMeasurements.latency,
                averageLatency: completedMeasurements.latency,
                medianLatency: completedMeasurements.latency,
                maxLatency: completedMeasurements.latency,
                minJitter: completedMeasurements.jitter ?? 0,
                averageJitter: completedMeasurements.jitter ?? 0,
                medianJitter: completedMeasurements.jitter ?? 0,
                maxJitter: completedMeasurements.jitter ?? 0,
              }
            : null),
    downloadResult: previous.downloadResult,
    uploadResult: previous.uploadResult,
    complete: previous.complete,
  };
}
