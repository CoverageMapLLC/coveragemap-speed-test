import { formatMbps, formatMs } from './formatters';
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
    downloadLoadedLatency: state.downloadResult?.loadedLatency.medianLatency ?? null,
    uploadLoadedLatency: state.uploadResult?.loadedLatency.medianLatency ?? null,
  };
}

type SummaryItemProps = {
  label: string;
  value: string;
  tone?: 'latency' | 'jitter' | 'download' | 'upload';
};

function SummaryItem({ label, value, tone }: SummaryItemProps) {
  return (
    <div className={`summary-item ${tone ? `summary-item-${tone}` : ''}`}>
      <span className="summary-label">{label}</span>
      <strong className="summary-value">{value}</strong>
    </div>
  );
}

type TestSummaryProps = {
  metrics: TestSummaryMetrics;
  isRunning?: boolean;
};

export function TestSummary({ metrics, isRunning = false }: TestSummaryProps) {
  return (
    <section className="card test-summary">
      <div className="metrics-header">
        <h2>Test Summary</h2>
        {isRunning && <span className="live-pill">Updating live</span>}
      </div>
      <div className="summary-grid">
        <SummaryItem
          label="Median latency"
          value={metrics.medianLatency == null ? '-' : `${formatMs(metrics.medianLatency)} ms`}
          tone="latency"
        />
        <SummaryItem
          label="Median jitter"
          value={metrics.medianJitter == null ? '-' : `${formatMs(metrics.medianJitter)} ms`}
          tone="jitter"
        />
        <SummaryItem
          label="Download speed"
          value={metrics.downloadSpeed == null ? '-' : `${formatMbps(metrics.downloadSpeed)} Mbps`}
          tone="download"
        />
        <SummaryItem
          label="Upload speed"
          value={metrics.uploadSpeed == null ? '-' : `${formatMbps(metrics.uploadSpeed)} Mbps`}
          tone="upload"
        />
        <SummaryItem
          label="Download loaded latency"
          value={
            metrics.downloadLoadedLatency == null
              ? '-'
              : `${formatMs(metrics.downloadLoadedLatency)} ms`
          }
          tone="latency"
        />
        <SummaryItem
          label="Upload loaded latency"
          value={
            metrics.uploadLoadedLatency == null ? '-' : `${formatMs(metrics.uploadLoadedLatency)} ms`
          }
          tone="latency"
        />
      </div>
    </section>
  );
}
