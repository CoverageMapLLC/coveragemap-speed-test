// @vitest-environment node
import type { AddressInfo } from 'node:net';
import { createSpeedTestServer } from '@coveragemap/speed-transport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { SpeedTestTransport } from '../src/types/speed-test.js';
import type { SpeedTestServer } from '../src/types/speed-server.js';
import { mockLoadedLatency } from './fixtures/speed-test-data.js';

// The stages are mocked; the transport choice (probe and URL) is real.
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

const cleanups: Array<() => Promise<void> | void> = [];

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

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
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

/** A speed-transport server: raw TCP and WebSocket on one port. */
async function startTransportServer(): Promise<number> {
  const server = createSpeedTestServer({ websocket: { path: '/v1/ws' } });
  const { port } = await server.listen(0, '127.0.0.1');
  cleanups.push(() => server.close());
  return port;
}

/** A WebSocket-only server, like servers that predate raw TCP. */
async function startWebSocketOnlyServer(): Promise<number> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      })
  );
  return (wss.address() as AddressInfo).port;
}

async function run(server: SpeedTestServer, transport?: SpeedTestTransport) {
  const { SpeedTestEngine } = await import('../src/engine.js');
  const engine = new SpeedTestEngine({ application, config: transport ? { transport } : {} });
  const result = await engine.run(server);
  const urls = [mocks.latency, mocks.downloadEstimation, mocks.download, mocks.uploadEstimation, mocks.upload].map(
    (mock) => (mock.mock.lastCall![0] as { serverUrl: string }).serverUrl
  );
  return { protocol: result.testType.testProtocol, urls: [...new Set(urls)] };
}

describe('engine transport choice', () => {
  it('runs every stage over raw TCP when the server offers it', async () => {
    const port = await startTransportServer();
    expect(await run(localServer(port))).toEqual({ protocol: 'TCP', urls: [`tcp://127.0.0.1:${port}`] });
  });

  it('runs every stage over WebSocket against a server without raw TCP', async () => {
    const port = await startWebSocketOnlyServer();
    expect(await run(localServer(port))).toEqual({ protocol: 'WSS', urls: [`ws://127.0.0.1:${port}/v1/ws`] });
  });

  it('never probes CDN servers', async () => {
    const port = await startTransportServer();
    expect(await run(localServer(port, { isCDN: true }))).toEqual({
      protocol: 'WSS',
      urls: [`ws://127.0.0.1:${port}/v1/ws`],
    });
  });

  it('uses tls URLs for servers other than local', async () => {
    // Nothing listens there; with an explicit transport the stages are mocked and nothing
    // connects, so only the URLs matter.
    expect(await run(localServer(1, { id: 'remote' }), 'websocket')).toEqual({
      protocol: 'WSS',
      urls: ['wss://127.0.0.1:1/v1/ws'],
    });
    expect(await run(localServer(1, { id: 'remote' }), 'tcp')).toEqual({ protocol: 'TCP', urls: ['tcps://127.0.0.1:1'] });
  });

  it('lets config.transport override the probe', async () => {
    const port = await startTransportServer();
    expect(await run(localServer(port), 'websocket')).toEqual({ protocol: 'WSS', urls: [`ws://127.0.0.1:${port}/v1/ws`] });

    const wsOnly = await startWebSocketOnlyServer();
    // tcp skips the probe, so a server without raw TCP is still addressed over tcp://.
    expect(await run(localServer(wsOnly), 'tcp')).toEqual({ protocol: 'TCP', urls: [`tcp://127.0.0.1:${wsOnly}`] });
  });
});
