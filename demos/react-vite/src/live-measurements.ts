export type LiveMeasurements = {
  downloadSpeed: number | null;
  uploadSpeed: number | null;
  latency: number | null;
  jitter: number | null;
};

export const EMPTY_MEASUREMENTS: LiveMeasurements = {
  downloadSpeed: null,
  uploadSpeed: null,
  latency: null,
  jitter: null,
};

type CompletedMeasurements = {
  testType: {
    testsRun: {
      latency: boolean;
    };
  };
  results: {
    measurements: LiveMeasurements;
  };
};

export function mergeCompletedMeasurements(
  previous: LiveMeasurements,
  completed: CompletedMeasurements
): LiveMeasurements {
  const completedMeasurements = completed.results.measurements;

  return {
    downloadSpeed: completedMeasurements.downloadSpeed,
    uploadSpeed: completedMeasurements.uploadSpeed,
    latency: completed.testType.testsRun.latency ? previous.latency : completedMeasurements.latency,
    jitter: completed.testType.testsRun.latency ? previous.jitter : completedMeasurements.jitter,
  };
}
