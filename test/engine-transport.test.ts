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

const LATENCY = {
  latencies: [1, 1],
  minLatency: 1,
  averageLatency: 1,
  medianLatency: 1,
  maxLatency: 1,
  minJitter: 0,
  averageJitter: 0,
  medianJitter: 0,
  maxJitter: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.latency.mockResolvedValue(LATENCY);
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

const ALL = ['WSSv1', 'WSv1', 'TCPv1'];

const remote = (protocols?: string[]) => localServer(443, { id: 'remote', domain: 'speed.example.com', protocols });

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
    const result = await run(remote(ALL));
    expect(result).toMatchObject({ protocol: 'TCP', status: 'passed', urls: ['tcp://speed.example.com:443'] });
    // The first connection gets a short connect timeout so a blocked network falls back fast.
    expect(result.latencyCalls).toEqual([['tcp://speed.example.com:443', 3000]]);
  });

  it('uses plain WebSocket before secure WebSocket', async () => {
    const result = await run(remote(['WSSv1', 'WSv1']));
    expect(result).toMatchObject({ protocol: 'WS', status: 'passed', urls: ['ws://speed.example.com:443/v1/ws'] });
    expect(result.latencyCalls).toEqual([['ws://speed.example.com:443/v1/ws', 3000]]);
  });

  it('uses secure WebSocket for servers that offer only that or report no protocols', async () => {
    const cdn = localServer(443, { id: 'cdn', domain: 'cdn.example.com', isCDN: true, protocols: ['WSSv1'] });
    for (const server of [remote(), remote([]), remote(['WSSv1']), cdn]) {
      vi.clearAllMocks();
      const result = await run(server);
      expect(result.protocol).toBe('WSS');
      expect(result.urls).toEqual([`wss://${server.domain}:443/v1/ws`]);
      // Nothing to fall back to, so no short connect timeout.
      expect(result.latencyCalls).toEqual([[result.urls[0], undefined]]);
    }
  });

  it('uses plain WebSocket for local servers that report no protocols', async () => {
    const result = await run(localServer(8080));
    expect(result).toMatchObject({ protocol: 'WS', urls: ['ws://127.0.0.1:8080/v1/ws'] });
  });

  it('forces one transport with tcp, ws, and wss, whatever the server lists', async () => {
    expect(await run(remote(['WSSv1']), { transport: 'tcp' })).toMatchObject({ protocol: 'TCP', urls: ['tcp://speed.example.com:443'] });
    vi.clearAllMocks();
    expect(await run(remote(['WSSv1']), { transport: 'ws' })).toMatchObject({ protocol: 'WS', urls: ['ws://speed.example.com:443/v1/ws'] });
    vi.clearAllMocks();
    expect(await run(remote(ALL), { transport: 'wss' })).toMatchObject({ protocol: 'WSS', urls: ['wss://speed.example.com:443/v1/ws'] });
  });
});

describe('first connection fallback', () => {
  /** The first connection cannot open over the transports whose URLs start with these prefixes. */
  const failOver = (...prefixes: string[]) =>
    mocks.latency.mockImplementation(async ({ serverUrl }: { serverUrl: string }) => {
      if (prefixes.some((prefix) => serverUrl.startsWith(prefix))) {
        throw new SocketConnectError('Connection failed during latency test');
      }
      return LATENCY;
    });

  it('moves the whole run to plain WebSocket when raw TCP cannot open', async () => {
    failOver('tcp://');
    const result = await run(remote(ALL));
    expect(result).toMatchObject({ protocol: 'WS', status: 'passed', failedReason: null, urls: ['ws://speed.example.com:443/v1/ws'] });
    expect(result.latencyCalls).toEqual([
      ['tcp://speed.example.com:443', 3000],
      ['ws://speed.example.com:443/v1/ws', 3000],
    ]);
  });

  it('moves on to secure WebSocket when plain WebSocket cannot open either', async () => {
    failOver('tcp://', 'ws://');
    const result = await run(remote(ALL));
    expect(result).toMatchObject({ protocol: 'WSS', status: 'passed', failedReason: null, urls: ['wss://speed.example.com:443/v1/ws'] });
    expect(result.latencyCalls).toEqual([
      ['tcp://speed.example.com:443', 3000],
      ['ws://speed.example.com:443/v1/ws', 3000],
      ['wss://speed.example.com:443/v1/ws', undefined],
    ]);
  });

  it('fails when the last transport cannot open', async () => {
    failOver('tcp://', 'ws://', 'wss://');
    const result = await run(remote(ALL));
    expect(result).toMatchObject({ protocol: 'WSS', status: 'failed' });
    expect(result.latencyCalls).toHaveLength(3);
  });

  it('falls back from the single latency ping when the latency stage is off', async () => {
    failOver('tcp://');
    const result = await run(remote(ALL), { tests: { latency: false, download: true, upload: true } });
    expect(result).toMatchObject({ protocol: 'WS', status: 'passed', urls: ['ws://speed.example.com:443/v1/ws'] });
    expect(result.latencyCalls).toHaveLength(2);
  });

  it('does not fall back when the connection opened and something else failed', async () => {
    mocks.latency.mockRejectedValue(new Error('No ping responses received'));
    const result = await run(remote(ALL));
    expect(result).toMatchObject({ protocol: 'TCP', status: 'failed', failedReason: 'No ping responses received' });
    expect(result.latencyCalls).toEqual([['tcp://speed.example.com:443', 3000]]);
  });

  it('does not fall back when a transport was forced', async () => {
    failOver('tcp://');
    const result = await run(remote(ALL), { transport: 'tcp' });
    expect(result).toMatchObject({ protocol: 'TCP', status: 'failed' });
    expect(result.latencyCalls).toEqual([['tcp://speed.example.com:443', undefined]]);
  });

  it('only falls back on the first connection', async () => {
    mocks.download.mockRejectedValue(new SocketConnectError('Download WebSocket connection 3 failed'));
    const result = await run(remote(ALL));
    expect(result).toMatchObject({ protocol: 'TCP', status: 'failed' });
    expect(mocks.download).toHaveBeenCalledTimes(1);
  });
});
