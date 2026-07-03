import { useEffect, useMemo, useState } from 'react';
import {
  SpeedTestEngine,
  formatBrowserDisplay,
  formatOSDisplay,
  type NetworkTestResultDevice,
  type NetworkTestResultLocation,
  type NetworkTestResultTestResults,
  type SpeedTestServer,
  type SpeedTestStage,
} from '@coveragemap/speed-test';
import {
  CompletePanel,
  DownloadProgressPanel,
  ErrorPanel,
  LatencyDataPanel,
  LatencyPingPanel,
  SpeedTestDataPanel,
  UploadProgressPanel,
} from './callback-display';
import {
  EMPTY_CALLBACK_STATE,
  mergeCompletedMeasurements,
  type LiveCallbackState,
} from './live-measurements';
import { selectTestSummary, TestSummary } from './test-summary';

const engine = new SpeedTestEngine({
  application: {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'CoverageMap React Example',
    version: '0.1.0',
    organization: 'CoverageMap',
    type: 'web',
  },
});

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
  const [callbackState, setCallbackState] = useState<LiveCallbackState>(EMPTY_CALLBACK_STATE);
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

  const testSummary = useMemo(() => selectTestSummary(callbackState), [callbackState]);

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
    setCallbackState(EMPTY_CALLBACK_STATE);
    setIsRunning(true);

    engine.updateCallbacks({
      onStageChange: (nextStage) => setStage(nextStage),
      onLatencyPing: (latencyMs, index) => {
        setCallbackState((previous) => ({
          ...previous,
          latencyPings: [...previous.latencyPings, { index, latencyMs }],
        }));
      },
      onLatencyResult: (data) => {
        setCallbackState((previous) => ({ ...previous, latencyResult: data }));
      },
      onDownloadProgress: (snapshot) => {
        setCallbackState((previous) => ({
          ...previous,
          downloadProgress: snapshot,
          downloadSnapshots: [...previous.downloadSnapshots, snapshot],
        }));
      },
      onDownloadResult: (data) => {
        setCallbackState((previous) => ({ ...previous, downloadResult: data }));
      },
      onUploadProgress: (snapshot) => {
        setCallbackState((previous) => ({
          ...previous,
          uploadProgress: snapshot,
          uploadSnapshots: [...previous.uploadSnapshots, snapshot],
        }));
      },
      onUploadResult: (data) => {
        setCallbackState((previous) => ({ ...previous, uploadResult: data }));
      },
      onComplete: (latency, download, upload) => {
        setCallbackState((previous) => ({
          ...previous,
          complete: { latency, download, upload },
        }));
      },
      onError: (callbackError, callbackStage) => {
        setCallbackState((previous) => ({
          ...previous,
          lastError: {
            message: callbackError.message,
            stage: callbackStage,
          },
        }));
      },
    });

    try {
      const completed = selectedServer ? await engine.run(selectedServer) : await engine.run();
      setResult(completed);
      setCallbackState((previous) => mergeCompletedMeasurements(previous, completed));
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
        This sample app runs `@coveragemap/speed-test` in a browser and displays every callback
        payload live.
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

        <p className="stage-line">
          <span className="stage-label">onStageChange</span>
          <span className={`stage-pill stage-${stage}`}>{stage}</span>
        </p>
        {error && <p className="error">{error}</p>}
      </section>

      <TestSummary metrics={testSummary} isRunning={isRunning} />

      <section className="card metrics">
        <div className="metrics-header">
          <h2>Callback Payloads</h2>
        </div>
        <div className="callback-sections">
          <LatencyPingPanel pings={callbackState.latencyPings} />
          <LatencyDataPanel data={callbackState.latencyResult} />
          <DownloadProgressPanel snapshots={callbackState.downloadSnapshots} />
          <SpeedTestDataPanel
            title="onDownloadResult"
            description="Final download speed, bytes, and loaded latency stats."
            data={callbackState.downloadResult}
            accent="download"
          />
          <UploadProgressPanel snapshots={callbackState.uploadSnapshots} />
          <SpeedTestDataPanel
            title="onUploadResult"
            description="Final upload speed, bytes, and loaded latency stats."
            data={callbackState.uploadResult}
            accent="upload"
          />
          <CompletePanel complete={callbackState.complete} />
          <ErrorPanel error={callbackState.lastError} />
        </div>
      </section>

      {result && (
        <section className="card context">
          <h2>Uploaded Result Summary</h2>
          <dl className="detail-list">
            <div>
              <dt>Download speed</dt>
              <dd>{result.results.measurements.downloadSpeed ?? '-'} Mbps</dd>
            </div>
            <div>
              <dt>Upload speed</dt>
              <dd>{result.results.measurements.uploadSpeed ?? '-'} Mbps</dd>
            </div>
            <div>
              <dt>Latency</dt>
              <dd>{result.results.measurements.latency ?? '-'} ms</dd>
            </div>
            <div>
              <dt>Jitter</dt>
              <dd>{result.results.measurements.jitter ?? '-'} ms</dd>
            </div>
          </dl>
        </section>
      )}

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
