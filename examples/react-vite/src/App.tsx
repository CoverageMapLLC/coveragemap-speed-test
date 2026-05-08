import { useMemo, useState } from 'react';
import {
  SpeedTestEngine,
  type NetworkTestResultTestResults,
  type SpeedServer,
  type SpeedTestStage,
} from '@coveragemap/speed-test';

const engine = new SpeedTestEngine({
  application: {
    name: 'CoverageMap React Example',
    version: '0.1.0',
    author: 'CoverageMap',
    organization: 'CoverageMap',
    type: 'web',
  },
});

function formatMbps(value: number | null | undefined): string {
  if (value == null) return '-';
  if (value < 10) return value.toFixed(1);
  return Math.round(value).toString();
}

export default function App() {
  const [stage, setStage] = useState<SpeedTestStage>('idle');
  const [isRunning, setIsRunning] = useState(false);
  const [servers, setServers] = useState<SpeedServer[]>([]);
  const [selectedServerId, setSelectedServerId] = useState('');
  const [result, setResult] = useState<NetworkTestResultTestResults | null>(null);
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

  const runTest = async () => {
    setError(null);
    setResult(null);
    setIsRunning(true);

    engine.updateCallbacks({
      onStageChange: (nextStage) => setStage(nextStage),
    });

    try {
      const completed = selectedServer ? await engine.run(selectedServer) : await engine.run();
      setResult(completed);
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
        This sample app runs `@coveragemap/speed-test` in a browser using CoverageMap's production
        endpoints.
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

        <label>
          Server
          <select
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
        </label>

        <p>
          <strong>Stage:</strong> {stage}
        </p>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="card metrics">
        <h2>Latest Result</h2>
        <div className="grid">
          <div>
            <span>Download</span>
            <strong>{formatMbps(result?.results.measurements.downloadSpeed)} Mbps</strong>
          </div>
          <div>
            <span>Upload</span>
            <strong>{formatMbps(result?.results.measurements.uploadSpeed)} Mbps</strong>
          </div>
          <div>
            <span>Latency</span>
            <strong>{formatMbps(result?.results.measurements.latency)} ms</strong>
          </div>
          <div>
            <span>Jitter</span>
            <strong>{formatMbps(result?.results.measurements.jitter)} ms</strong>
          </div>
        </div>
      </section>
    </main>
  );
}
