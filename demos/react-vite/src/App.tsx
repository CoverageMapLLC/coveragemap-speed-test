import { useEffect, useMemo, useState } from 'react';
import {
  SpeedTestEngine,
  formatBrowserDisplay,
  formatOSDisplay,
  type LatencyTestData,
  type NetworkTestResultDevice,
  type NetworkTestResultLocation,
  type SpeedSnapshot,
  type SpeedTestData,
  type NetworkTestResultTestResults,
  type SpeedTestServer,
  type SpeedTestStage,
} from '@coveragemap/speed-test';
import {
  EMPTY_MEASUREMENTS,
  mergeCompletedMeasurements,
  type LiveMeasurements,
} from './live-measurements';

const engine = new SpeedTestEngine({
  application: {
    id: '11111111-1111-1111-1111-111111111111',
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

function formatCoordinate(value: number | null | undefined): string {
  if (value == null) return '-';
  return value.toFixed(5);
}

function formatLocationType(locationType: NetworkTestResultLocation['locationType']): string {
  return locationType === 'device' ? 'Device GPS' : 'IP geolocation';
}

export default function App() {
  const [stage, setStage] = useState<SpeedTestStage>('idle');
  const [isRunning, setIsRunning] = useState(false);
  const [servers, setServers] = useState<SpeedTestServer[]>([]);
  const [selectedServerId, setSelectedServerId] = useState('');
  const [result, setResult] = useState<NetworkTestResultTestResults | null>(null);
  const [liveMeasurements, setLiveMeasurements] = useState<LiveMeasurements>(EMPTY_MEASUREMENTS);
  const [device, setDevice] = useState<NetworkTestResultDevice | null>(null);
  const [location, setLocation] = useState<NetworkTestResultLocation | null>(null);
  const [isLoadingContext, setIsLoadingContext] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadContext = async () => {
    setDevice(engine.getDevice());
    setIsLoadingContext(true);
    try {
      const resolvedLocation = await engine.getLocation();
      setLocation(resolvedLocation);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoadingContext(false);
    }
  };

  useEffect(() => {
    void loadContext();
  }, []);

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
      latency: data.minLatency,
      jitter: data.medianJitter,
    }));
  };

  const updateDownloadResult = (data: SpeedTestData) => {
    setLiveMeasurements((previous) => ({
      ...previous,
      downloadSpeed: data.speedMbps,
      downloadLoadedLatency: data.loadedLatency.minLatency,
    }));
  };

  const updateUploadResult = (data: SpeedTestData) => {
    setLiveMeasurements((previous) => ({
      ...previous,
      uploadSpeed: data.speedMbps,
      uploadLoadedLatency: data.loadedLatency.minLatency,
    }));
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
      onDownloadResult: updateDownloadResult,
      onUploadProgress: updateUpload,
      onUploadResult: updateUploadResult,
    });

    try {
      const completed = selectedServer ? await engine.run(selectedServer) : await engine.run();
      setResult(completed);
      setLiveMeasurements((previous) => mergeCompletedMeasurements(previous, completed));
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
          <div>
            <span>Download Loaded Latency</span>
            <strong>{formatMbps(liveMeasurements.downloadLoadedLatency)} ms</strong>
          </div>
          <div>
            <span>Upload Loaded Latency</span>
            <strong>{formatMbps(liveMeasurements.uploadLoadedLatency)} ms</strong>
          </div>
        </div>
      </section>

      <section className="card context">
        <div className="metrics-header">
          <h2>Device &amp; Location</h2>
          <button type="button" onClick={() => void loadContext()} disabled={isRunning || isLoadingContext}>
            {isLoadingContext ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        <div className="context-grid">
          <div className="context-panel">
            <h3>Device</h3>
            {device ? (
              <dl className="detail-list">
                <div>
                  <dt>Name</dt>
                  <dd>{device.name}</dd>
                </div>
                <div>
                  <dt>OS</dt>
                  <dd>{formatOSDisplay(device.os, device.osVersion)}</dd>
                </div>
                <div>
                  <dt>Browser</dt>
                  <dd>{formatBrowserDisplay(device.browserName, device.browserVersion)}</dd>
                </div>
                <div>
                  <dt>Type</dt>
                  <dd>{device.isMobile ? 'Mobile' : device.deviceType ?? 'Unknown'}</dd>
                </div>
                <div>
                  <dt>Device ID</dt>
                  <dd className="mono">{device.id ?? '-'}</dd>
                </div>
              </dl>
            ) : (
              <p className="muted">Loading device metadata...</p>
            )}
          </div>

          <div className="context-panel">
            <h3>Location</h3>
            {isLoadingContext ? (
              <p className="muted">Resolving location...</p>
            ) : location ? (
              <dl className="detail-list">
                <div>
                  <dt>Latitude</dt>
                  <dd>{formatCoordinate(location.latitude)}</dd>
                </div>
                <div>
                  <dt>Longitude</dt>
                  <dd>{formatCoordinate(location.longitude)}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{formatLocationType(location.locationType)}</dd>
                </div>
                {location.elevation != null && (
                  <div>
                    <dt>Elevation</dt>
                    <dd>{formatCoordinate(location.elevation)} m</dd>
                  </div>
                )}
              </dl>
            ) : (
              <p className="muted">No location available.</p>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
