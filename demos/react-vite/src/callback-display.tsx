import type { LatencyTestData, SpeedSnapshot, SpeedTestData } from '@coveragemap/speed-test';
import { LineChart } from './components/charts';
import { CollapsiblePanel, CollapsibleSection } from './components/collapsible-panel';
import {
  StatSummary,
  jitterStats,
  latencyStats,
  type StatSet,
} from './components/stat-summary';
import {
  formatBytes,
  formatMbps,
  formatMs,
  formatSecondsFromMs,
} from './formatters';
import type { CallbackError, LatencyPingEntry } from './live-measurements';

function statsFromValues(values: number[]): StatSet | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((total, value) => total + value, 0);

  return {
    min: sorted[0],
    avg: sum / values.length,
    med: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
  };
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={value === '-' ? 'muted-value' : undefined}>{value}</dd>
    </div>
  );
}

function LatencyStatSummaries({ data }: { data: LatencyTestData }) {
  return (
    <div className="stat-stack">
      <StatSummary title="Latency" unit="ms" stats={latencyStats(data)} accent="latency" embedded />
      <StatSummary title="Jitter" unit="ms" stats={jitterStats(data)} accent="jitter" embedded />
    </div>
  );
}

function LoadedLatencyContent({ data }: { data: LatencyTestData }) {
  return (
    <>
      <LineChart
        title="Loaded latency sequence"
        points={data.latencies.map((latency, index) => ({
          x: index + 1,
          y: latency,
        }))}
        xLabel="Ping #"
        yLabel="ms"
        color="#57d39a"
        formatX={(value) => `#${Math.round(value)}`}
        formatY={formatMs}
        embedded
      />
      <LatencyStatSummaries data={data} />
    </>
  );
}

function LatencyStatSections({ data }: { data: LatencyTestData }) {
  return (
    <>
      <CollapsibleSection title="Latency (ms)" defaultOpen>
        <StatSummary title="Latency" unit="ms" stats={latencyStats(data)} accent="latency" embedded hideHeader />
      </CollapsibleSection>
      <CollapsibleSection title="Jitter (ms)" defaultOpen>
        <StatSummary title="Jitter" unit="ms" stats={jitterStats(data)} accent="jitter" embedded hideHeader />
      </CollapsibleSection>
    </>
  );
}

function LatencyDataPanel({ data }: { data: LatencyTestData | null }) {
  return (
    <CollapsiblePanel
      title="onLatencyResult"
      description="Final idle latency and jitter stats after the latency stage."
      wide
    >
      {!data ? <p className="muted">No data yet.</p> : <LatencyStatSections data={data} />}
    </CollapsiblePanel>
  );
}

function SpeedTestResultContent({
  data,
  accent,
}: {
  data: SpeedTestData;
  accent: 'download' | 'upload';
}) {
  const speedStats = statsFromValues(data.snapshots.map((snapshot) => snapshot.speedMbps));

  return (
    <>
      <dl className="detail-list metric-cards metric-cards-inline">
        <DetailRow label="Duration" value={formatSecondsFromMs(data.durationMs)} />
        <DetailRow label="Final speed" value={`${formatMbps(data.speedMbps)} Mbps`} />
        <DetailRow label="Total bytes" value={formatBytes(data.bytes)} />
        <DetailRow label="Snapshots" value={String(data.snapshots.length)} />
      </dl>

      {speedStats && (
        <CollapsibleSection title="Speed over test (Mbps)" defaultOpen>
          <StatSummary
            title="Speed over test"
            unit="Mbps"
            stats={speedStats}
            formatValue={formatMbps}
            accent={accent}
            embedded
            hideHeader
          />
        </CollapsibleSection>
      )}

      <CollapsibleSection title="Loaded latency" defaultOpen>
        <LoadedLatencyContent data={data.loadedLatency} />
      </CollapsibleSection>
    </>
  );
}

function SpeedTestDataPanel({
  title,
  description,
  data,
  accent,
}: {
  title: string;
  description: string;
  data: SpeedTestData | null;
  accent: 'download' | 'upload';
}) {
  return (
    <CollapsiblePanel title={title} description={description} wide>
      {!data ? (
        <p className="muted">No data yet.</p>
      ) : (
        <SpeedTestResultContent data={data} accent={accent} />
      )}
    </CollapsiblePanel>
  );
}

export function LatencyPingPanel({ pings }: { pings: LatencyPingEntry[] }) {
  return (
    <CollapsiblePanel
      title="onLatencyPing"
      description="Fired for each idle latency ping during the latency stage."
      wide
    >
      {pings.length === 0 ? (
        <p className="muted">No pings yet.</p>
      ) : (
        <LineChart
          title="Ping sequence"
          points={pings.map((ping) => ({
            x: ping.index + 1,
            y: ping.latencyMs,
          }))}
          xLabel="Ping #"
          yLabel="ms"
          color="#57d39a"
          formatX={(value) => `#${Math.round(value)}`}
          formatY={formatMs}
          embedded
        />
      )}
    </CollapsiblePanel>
  );
}

export function DownloadProgressPanel({ snapshots }: { snapshots: SpeedSnapshot[] }) {
  const speedStats = statsFromValues(snapshots.map((snapshot) => snapshot.speedMbps));

  return (
    <CollapsiblePanel
      title="onDownloadProgress"
      description="Live download throughput snapshots during the download stage."
      wide
    >
      {snapshots.length === 0 ? (
        <p className="muted">No snapshots yet.</p>
      ) : (
        <>
          {speedStats && (
            <CollapsibleSection title="Observed speed (Mbps)" defaultOpen>
              <StatSummary
                title="Observed speed"
                unit="Mbps"
                stats={speedStats}
                formatValue={formatMbps}
                accent="download"
                embedded
                hideHeader
              />
            </CollapsibleSection>
          )}
          <CollapsibleSection title="Throughput over time" defaultOpen>
            <LineChart
              title="Throughput over time"
              points={snapshots.map((snapshot) => ({
                x: snapshot.timeOffsetMs,
                y: snapshot.speedMbps,
              }))}
              xLabel="Elapsed time"
              yLabel="Mbps"
              color="#35c2ff"
              formatX={(value) => formatSecondsFromMs(value)}
              formatY={formatMbps}
              embedded
            />
          </CollapsibleSection>
          <CollapsibleSection title="Bytes transferred over time">
            <LineChart
              title="Bytes transferred over time"
              points={snapshots.map((snapshot) => ({
                x: snapshot.timeOffsetMs,
                y: snapshot.bytes,
              }))}
              xLabel="Elapsed time"
              yLabel="Bytes"
              color="#35c2ff"
              formatX={(value) => formatSecondsFromMs(value)}
              formatY={(value) => formatBytes(value)}
              embedded
            />
          </CollapsibleSection>
        </>
      )}
    </CollapsiblePanel>
  );
}

export function UploadProgressPanel({ snapshots }: { snapshots: SpeedSnapshot[] }) {
  const speedStats = statsFromValues(snapshots.map((snapshot) => snapshot.speedMbps));

  return (
    <CollapsiblePanel
      title="onUploadProgress"
      description="Live upload throughput snapshots during the upload stage."
      wide
    >
      {snapshots.length === 0 ? (
        <p className="muted">No snapshots yet.</p>
      ) : (
        <>
          {speedStats && (
            <CollapsibleSection title="Observed speed (Mbps)" defaultOpen>
              <StatSummary
                title="Observed speed"
                unit="Mbps"
                stats={speedStats}
                formatValue={formatMbps}
                accent="upload"
                embedded
                hideHeader
              />
            </CollapsibleSection>
          )}
          <CollapsibleSection title="Throughput over time" defaultOpen>
            <LineChart
              title="Throughput over time"
              points={snapshots.map((snapshot) => ({
                x: snapshot.timeOffsetMs,
                y: snapshot.speedMbps,
              }))}
              xLabel="Elapsed time"
              yLabel="Mbps"
              color="#ffb020"
              formatX={(value) => formatSecondsFromMs(value)}
              formatY={formatMbps}
              embedded
            />
          </CollapsibleSection>
          <CollapsibleSection title="Bytes transferred over time">
            <LineChart
              title="Bytes transferred over time"
              points={snapshots.map((snapshot) => ({
                x: snapshot.timeOffsetMs,
                y: snapshot.bytes,
              }))}
              xLabel="Elapsed time"
              yLabel="Bytes"
              color="#ffb020"
              formatX={(value) => formatSecondsFromMs(value)}
              formatY={(value) => formatBytes(value)}
              embedded
            />
          </CollapsibleSection>
        </>
      )}
    </CollapsiblePanel>
  );
}

export function CompletePanel({
  complete,
}: {
  complete: {
    latency: LatencyTestData | null;
    download: SpeedTestData | null;
    upload: SpeedTestData | null;
  } | null;
}) {
  return (
    <CollapsiblePanel
      title="onComplete"
      description="All stage results after the test finishes."
      wide
    >
      {!complete ? (
        <p className="muted">Test not complete yet.</p>
      ) : (
        <>
          {complete.latency && (
            <CollapsibleSection title="Idle latency" defaultOpen>
              <LatencyStatSummaries data={complete.latency} />
            </CollapsibleSection>
          )}
          {complete.download && (
            <CollapsibleSection title="Download" defaultOpen>
              <SpeedTestResultContent data={complete.download} accent="download" />
            </CollapsibleSection>
          )}
          {complete.upload && (
            <CollapsibleSection title="Upload" defaultOpen>
              <SpeedTestResultContent data={complete.upload} accent="upload" />
            </CollapsibleSection>
          )}
        </>
      )}
    </CollapsiblePanel>
  );
}

export function ErrorPanel({ error }: { error: CallbackError | null }) {
  return (
    <CollapsiblePanel
      title="onError"
      description="Error message and stage when the test fails."
      tone={error ? 'error' : 'default'}
    >
      {!error ? (
        <p className="muted">No errors.</p>
      ) : (
        <dl className="detail-list">
          <DetailRow label="Stage" value={error.stage} />
          <DetailRow label="Message" value={error.message} />
        </dl>
      )}
    </CollapsiblePanel>
  );
}

export {
  LatencyDataPanel,
  SpeedTestDataPanel,
};
