import { formatMs } from '../formatters';

export type StatSet = {
  min: number;
  avg: number;
  med: number;
  max: number;
};

type StatSummaryProps = {
  title: string;
  unit: string;
  stats: StatSet;
  formatValue?: (value: number) => string;
  accent?: 'latency' | 'jitter' | 'download' | 'upload' | 'neutral';
  embedded?: boolean;
  hideHeader?: boolean;
};

const ACCENT_VAR: Record<NonNullable<StatSummaryProps['accent']>, string> = {
  latency: 'var(--accent-latency)',
  jitter: 'var(--accent-jitter)',
  download: 'var(--accent-download)',
  upload: 'var(--accent-upload)',
  neutral: 'var(--accent-neutral)',
};

export function StatSummary({
  title,
  unit,
  stats,
  formatValue = formatMs,
  accent = 'neutral',
  embedded = false,
  hideHeader = false,
}: StatSummaryProps) {
  const accentColor = ACCENT_VAR[accent];

  return (
    <div
      className={`stat-summary ${embedded ? 'stat-summary-embedded' : ''}`}
      style={{ ['--stat-accent' as string]: accentColor }}
    >
      {!hideHeader && (
        <div className="stat-summary-header">
          <span className="stat-summary-title">{title}</span>
          <span className="stat-summary-unit">{unit}</span>
        </div>
      )}

      <div className="stat-grid" role="list" aria-label={`${title} min average median max`}>
        <div className="stat-cell" role="listitem">
          <span className="stat-label">Min</span>
          <strong className="stat-value">{formatValue(stats.min)}</strong>
        </div>
        <div className="stat-cell" role="listitem">
          <span className="stat-label">Avg</span>
          <strong className="stat-value">{formatValue(stats.avg)}</strong>
        </div>
        <div className="stat-cell" role="listitem">
          <span className="stat-label">Med</span>
          <strong className="stat-value">{formatValue(stats.med)}</strong>
        </div>
        <div className="stat-cell" role="listitem">
          <span className="stat-label">Max</span>
          <strong className="stat-value">{formatValue(stats.max)}</strong>
        </div>
      </div>
    </div>
  );
}

export function latencyStats(data: {
  minLatency: number;
  averageLatency: number;
  medianLatency: number;
  maxLatency: number;
}): StatSet {
  return {
    min: data.minLatency,
    avg: data.averageLatency,
    med: data.medianLatency,
    max: data.maxLatency,
  };
}

export function jitterStats(data: {
  minJitter: number;
  averageJitter: number;
  medianJitter: number;
  maxJitter: number;
}): StatSet {
  return {
    min: data.minJitter,
    avg: data.averageJitter,
    med: data.medianJitter,
    max: data.maxJitter,
  };
}
