// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SocketConnectError } from '../src/tests/sockets.js';
import type { SpeedTestTransport } from '../src/types/speed-test.js';
import type { SpeedTestServer } from '../src/types/speed-server.js';
import { mockLoadedLatency } from './fixtures/speed-test-data.js';

// The stages are mocked; the transport choice and the first-connection fallback are real.
const mocks = vi.hoisted(() => ({
  latency: vi.fn(),
  downloadEstimation: vi.fn(),
  uploadEstimation: vi.fn(),
  download: vi.fn(),
  upload: vi.fn(),
}));

vi.mock('../src/tests/latency-test.js', () => ({ runLatencyTest: mocks.latency }));
vi.mock('../src/tests/download-estimation-test.js', () => ({ runDownloadEstimationTest: mocks.downloadEstimation }));
vi.mock('../src/tests/upload-estimation-test.js', () => ({ runUploadEstimationTest: mocks.uploadEstimation }));
vi.mock('../src/tests/download-speed-test.js', () => ({ runDownloadSpeedTest: mocks.download }));
vi.mock('../src/tests/upload-speed-test.js', () => ({ runUploadSpeedTest: mocks.upload }));
vi.mock('../src/api/speed-api.js', () => ({
  SpeedTestApiClient: class {
    getServers = vi.fn().mockResolvedValue([]);
    getConnectionInfo = vi.fn().mockResolvedValue({ client: { ip: '127.0.0.1', asOrg: 'Loopback' } });
    setLocationProvider = vi.fn();
  },
}));
vi.mock('../src/api/coveragemap-api.js', () => ({
  CoverageMapApiClient: class {
    uploadSpeedTestResults = vi.fn().mockResolvedValue(undefined);
  },
}));

const application = {
  id: '9f8e7d6c-5b4a-4321-9fed-cba987654321',
  name: 'Engine Transport Harness',
  version: '1.0.0',
  organization: 'CoverageMap',
  type: 'backend',
};

const throughput = {
  durationMs: 2000,
  bytes: 1_000_000,
  speedMbps: 100,
  snapshots: [],
  loadedLatency: mockLoadedLatency,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.latency.mockResolvedValue({
    latencies: [1, 1],
    minLatency: 1,
    averageLatency: 1,
    medianLatency: 1,
    maxLatency: 1,
    minJitter: 0,
    averageJitter: 0,
    medianJitter: 0,
    maxJitter: 0,
  });
  mocks.downloadEstimation.mockResolvedValue({ durationMs: 100, bytes: 100_000, speedMbps: 50 });
  mocks.uploadEstimation.mockResolvedValue({ durationMs: 100, bytes: 100_000, speedMbps: 50 });
  mocks.download.mockResolvedValue(throughput);
  mocks.upload.mockResolvedValue(throughput);
});


function localServer(port: number, overrides: Partial<SpeedTestServer> = {}): SpeedTestServer {
  return {
    id: 'local',
    domain: '127.0.0.1',
    port,
    provider: null,
    city: null,
    region: null,
    country: 'US',
    location: 'Local',
    latitude: null,
    longitude: null,
    distance: null,
    isCDN: false,
    ...overrides,
  };
}

const ALL = ['WSSv1', 'WSv1', 'TCPSv1', 'TCPv1'];

async function run(
  server: SpeedTestServer,
  options: { transport?: SpeedTestTransport; tests?: { latency?: boolean; download?: boolean; upload?: boolean } } = {}
) {
  const { SpeedTestEngine } = await import('../src/engine.js');
  const engine = new SpeedTestEngine({
    application,
    config: options.transport ? { transport: options.transport } : {},
    tests: options.tests,
  });
  const result = await engine.run(server);
  const stages = [mocks.latency, mocks.downloadEstimation, mocks.download, mocks.uploadEstimation, mocks.upload];
  const urls = stages.filter((mock) => mock.mock.lastCall).map((mock) => (mock.mock.lastCall![0] as { serverUrl: string }).serverUrl);
  return {
    protocol: result.testType.testProtocol,
    status: result.results.testStatus,
    failedReason: result.results.measurements.failedReason,
    urls: [...new Set(urls)],
    latencyCalls: mocks.latency.mock.calls.map(([options]) => [options.serverUrl, options.connectTimeoutMs]),
  };
}

describe('engine transport choice', () => {
  it('runs every stage over raw TCP when the server lists it, without probing first', async () => {
    const result = await run(localServer(8080, { protocols: ALL }));
    expect(result).toMatchObject({ protocol: 'TCP', status: 'passed', urls: ['tcp://127.0.0.1:8080'] });
    // The first connection gets a short connect timeout so a blocked network falls back fast.
    expect(result.latencyCalls).toEqual([['tcp://127.0.0.1:8080', 3000]]);
  });

  it('uses WebSocket for servers that report no protocols or only WebSocket', async () => {
    for (const server of [localServer(8080), localServer(8080, { protocols: ['WSSv1', 'WSv1'] }), localServer(8080, { isCDN: true, protocols: ['WSSv1'] })]) {
      vi.clearAllMocks();
      const result = await run(server);
      expect(result).toMatchObject({ protocol: 'WSS', status: 'passed', urls: ['ws://127.0.0.1:8080/v1/ws'] });
      expect(result.latencyCalls).toEqual([['ws://127.0.0.1:8080/v1/ws', undefined]]);
    }
  });

  it('uses tls URLs for servers other than local', async () => {
    const remote = localServer(443, { id: 'remote', domain: 'speed.example.com', protocols: ALL });
    expect(await run(remote)).toMatchObject({ protocol: 'TCP', urls: ['tcps://speed.example.com:443'] });
    vi.clearAllMocks();
    expect(await run(remote, { transport: 'websocket' })).toMatchObject({ protocol: 'WSS', urls: ['wss://speed.example.com:443/v1/ws'] });
  });

  it('forces raw TCP with transport tcp, even when the server does not list it', async () => {
    expect(await run(localServer(8080), { transport: 'tcp' })).toMatchObject({ protocol: 'TCP', urls: ['tcp://127.0.0.1:8080'] });
  });
});

describe('first connection fallback', () => {
  const failTcp = () =>
    mocks.latency.mockImplementation(async ({ serverUrl }: { serverUrl: string }) => {
      if (serverUrl.startsWith('tcp')) throw new SocketConnectError('WebSocket connection failed during latency test');
      return { latencies: [1, 1], minLatency: 1, averageLatency: 1, medianLatency: 1, maxLatency: 1, minJitter: 0, averageJitter: 0, medianJitter: 0, maxJitter: 0 };
    });

  it('switches the whole run to WebSocket when the first raw TCP connection cannot open', async () => {
    failTcp();
    const result = await run(localServer(8080, { protocols: ALL }));
    expect(result).toMatchObject({ protocol: 'WSS', status: 'passed', failedReason: null, urls: ['ws://127.0.0.1:8080/v1/ws'] });
    expect(result.latencyCalls).toEqual([
      ['tcp://127.0.0.1:8080', 3000],
      ['ws://127.0.0.1:8080/v1/ws', undefined],
    ]);
  });

  it('falls back from the single latency ping when the latency stage is off', async () => {
    failTcp();
    const result = await run(localServer(8080, { protocols: ALL }), { tests: { latency: false, download: true, upload: true } });
    expect(result).toMatchObject({ protocol: 'WSS', status: 'passed', urls: ['ws://127.0.0.1:8080/v1/ws'] });
    expect(result.latencyCalls).toHaveLength(2);
  });

  it('does not fall back when the connection opened and something else failed', async () => {
    mocks.latency.mockRejectedValue(new Error('No ping responses received'));
    const result = await run(localServer(8080, { protocols: ALL }));
    expect(result).toMatchObject({ protocol: 'TCP', status: 'failed', failedReason: 'No ping responses received' });
    expect(result.latencyCalls).toEqual([['tcp://127.0.0.1:8080', 3000]]);
  });

  it('does not fall back when raw TCP was required', async () => {
    failTcp();
    const result = await run(localServer(8080, { protocols: ALL }), { transport: 'tcp' });
    expect(result).toMatchObject({ protocol: 'TCP', status: 'failed' });
    expect(result.latencyCalls).toEqual([['tcp://127.0.0.1:8080', undefined]]);
  });

  it('only falls back on the first connection', async () => {
    mocks.download.mockRejectedValue(new SocketConnectError('Download WebSocket connection 3 failed'));
    const result = await run(localServer(8080, { protocols: ALL }));
    expect(result).toMatchObject({ protocol: 'TCP', status: 'failed' });
    expect(mocks.download).toHaveBeenCalledTimes(1);
  });
});
