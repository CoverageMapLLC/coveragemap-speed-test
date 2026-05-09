import { useMemo, useState } from 'react';
import {
  SpeedTestEngine,
  type LatencyTestData,
  type SpeedSnapshot,
  type SpeedTestData,
  type NetworkTestResultTestResults,
  type SpeedTestServer,
  type SpeedTestStage,
} from '@coveragemap/speed-test';

const engine = new SpeedTestEngine({
  application: {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'CoverageMap React Example',
    version: '0.1.0',
    organization: 'CoverageMap',
    type: 'web',
  },
});

function formatMbps(value: number | null | undefined): string {
  if (value == null) return '-';
  if (value < 10) return value.toFixed(1);
  return Math.round(value).toString();
}

type LiveMeasurements = {
  downloadSpeed: number | null;
  uploadSpeed: number | null;
  latency: number | null;
  jitter: number | null;
};

const EMPTY_MEASUREMENTS: LiveMeasurements = {
  downloadSpeed: null,
  uploadSpeed: null,
  latency: null,
  jitter: null,
};

export default function App() {
  const [stage, setStage] = useState<SpeedTestStage>('idle');
  const [isRunning, setIsRunning] = useState(false);
  const [servers, setServers] = useState<SpeedTestServer[]>([]);
  const [selectedServerId, setSelectedServerId] = useState('');
  const [result, setResult] = useState<NetworkTestResultTestResults | null>(null);
  const [liveMeasurements, setLiveMeasurements] = useState<LiveMeasurements>(EMPTY_MEASUREMENTS);
  const [error, setError] = useState<string | null>(null);

  const selectedServer = useMemo(() => {
    if (!selectedServerId) return null;
    return servers.find((server) => server.id === selectedServerId) ?? null;
  }, [selectedServerId, servers]);

  const loadServers = async () => {
    setError(null);
    try {
      const list = await engine.getServers();
      setServers(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateDownload = (snapshot: SpeedSnapshot) => {
    setLiveMeasurements((previous) => ({ ...previous, downloadSpeed: snapshot.speedMbps }));
  };

  const updateUpload = (snapshot: SpeedSnapshot) => {
    setLiveMeasurements((previous) => ({ ...previous, uploadSpeed: snapshot.speedMbps }));
  };

  const updateLatency = (data: LatencyTestData) => {
    setLiveMeasurements((previous) => ({
      ...previous,
      latency: data.averageLatency,
      jitter: data.averageJitter,
    }));
  };

  const updateFinalStageSpeed =
    (key: 'downloadSpeed' | 'uploadSpeed') =>
    (data: SpeedTestData) => {
      setLiveMeasurements((previous) => ({ ...previous, [key]: data.speedMbps }));
    };

  const runTest = async () => {
    setError(null);
    setResult(null);
    setLiveMeasurements(EMPTY_MEASUREMENTS);
    setIsRunning(true);

    engine.updateCallbacks({
      onStageChange: (nextStage) => setStage(nextStage),
      onLatencyResult: updateLatency,
      onDownloadProgress: updateDownload,
      onDownloadResult: updateFinalStageSpeed('downloadSpeed'),
      onUploadProgress: updateUpload,
      onUploadResult: updateFinalStageSpeed('uploadSpeed'),
    });

    try {
      const completed = selectedServer ? await engine.run(selectedServer) : await engine.run();
      setResult(completed);
      setLiveMeasurements({
        downloadSpeed: completed.results.measurements.downloadSpeed,
        uploadSpeed: completed.results.measurements.uploadSpeed,
        latency: completed.results.measurements.latency,
        jitter: completed.results.measurements.jitter,
      });
      setStage('complete');
    } catch (err) {
      setStage('error');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <main className="container">
      <h1>CoverageMap Speed Test Example</h1>
      <p className="subtitle">
        This sample app runs `@coveragemap/speed-test` in a browser.
      </p>

      <section className="card controls">
        <div className="row">
          <button type="button" onClick={loadServers} disabled={isRunning}>
            Load Servers
          </button>
          <button type="button" onClick={runTest} disabled={isRunning}>
            {isRunning ? 'Running...' : 'Start Test'}
          </button>
          <button type="button" onClick={() => engine.cancel()} disabled={!isRunning}>
            Cancel
          </button>
        </div>

        <label className="server-control" htmlFor="server-select">
          <span className="label-title">Server</span>
          <select
            id="server-select"
            className="server-select"
            value={selectedServerId}
            disabled={isRunning}
            onChange={(event) => setSelectedServerId(event.target.value)}
          >
            <option value="">Auto-select best server (first in list)</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.location} ({server.domain})
              </option>
            ))}
          </select>
          <span className="server-note">
            {servers.length === 0
              ? 'Load servers to choose a specific endpoint.'
              : `${servers.length} server${servers.length === 1 ? '' : 's'} loaded`}
          </span>
        </label>

        <p>
          <strong>Stage:</strong> {stage}
        </p>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="card metrics">
        <div className="metrics-header">
          <h2>Live Result</h2>
          {isRunning && <span className="live-pill">Updating live</span>}
        </div>
        <div className="grid">
          <div>
            <span>Download</span>
            <strong>{formatMbps(liveMeasurements.downloadSpeed)} Mbps</strong>
          </div>
          <div>
            <span>Upload</span>
            <strong>{formatMbps(liveMeasurements.uploadSpeed)} Mbps</strong>
          </div>
          <div>
            <span>Latency</span>
            <strong>{formatMbps(liveMeasurements.latency)} ms</strong>
          </div>
          <div>
            <span>Jitter</span>
            <strong>{formatMbps(liveMeasurements.jitter)} ms</strong>
          </div>
        </div>
      </section>
    </main>
  );
}
