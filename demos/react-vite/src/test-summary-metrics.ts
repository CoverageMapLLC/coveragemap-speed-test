import type { LiveCallbackState } from './live-measurements';

export type TestSummaryMetrics = {
  medianLatency: number | null;
  medianJitter: number | null;
  downloadSpeed: number | null;
  uploadSpeed: number | null;
  downloadLoadedLatency: number | null;
  uploadLoadedLatency: number | null;
};

export function selectTestSummary(state: LiveCallbackState): TestSummaryMetrics {
  return {
    medianLatency: state.latencyResult?.medianLatency ?? null,
    medianJitter: state.latencyResult?.medianJitter ?? null,
    downloadSpeed: state.downloadResult?.speedMbps ?? state.downloadProgress?.speedMbps ?? null,
    uploadSpeed: state.uploadResult?.speedMbps ?? state.uploadProgress?.speedMbps ?? null,
    downloadLoadedLatency: state.downloadResult?.loadedLatency?.medianLatency ?? null,
    uploadLoadedLatency: state.uploadResult?.loadedLatency?.medianLatency ?? null,
  };
}
