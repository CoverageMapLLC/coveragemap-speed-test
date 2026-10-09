// @vitest-environment node
import type { AddressInfo } from 'node:net';
import { createSpeedTestServer, type SpeedTransportServer } from '@coveragemap/speed-transport';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { runDownloadEstimationTest } from '../src/tests/download-estimation-test.js';
import { runDownloadSpeedTest } from '../src/tests/download-speed-test.js';
import { runLatencyTest } from '../src/tests/latency-test.js';
import {
  getServerTcpUrl,
  isTcpUrl,
  loadTcpTransport,
  openSocket,
  resolveServerUrl,
  SOCKET_OPEN,
} from '../src/tests/sockets.js';
import { runUploadEstimationTest } from '../src/tests/upload-estimation-test.js';
import { runUploadSpeedTest } from '../src/tests/upload-speed-test.js';
import {
  hostWorkerLane,
  type HostToWorkerMessage,
  type WorkerToHostMessage,
} from '../src/tests/worker-lanes.js';
import type { SpeedTestServer } from '../src/types/speed-server.js';
import { CancellationToken } from '../src/utils/cancellation.js';

function server(overrides: Partial<SpeedTestServer> = {}): SpeedTestServer {
  return {
    id: 'local',
    domain: '127.0.0.1',
    port: 0,
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

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A speed-transport server: raw TCP and WebSocket on one plaintext port. */
async function startTransportServer(): Promise<number> {
  const transport: SpeedTransportServer = createSpeedTestServer({ websocket: { path: '/v1/ws' } });
  await transport.listen(0, '127.0.0.1');
  cleanups.push(() => transport.close());
  return transport.address()!.port;
}

/** A WebSocket-only server, like servers that predate raw TCP. */
async function startWebSocketOnlyServer(): Promise<number> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  wss.on('connection', (socket) => socket.on('message', (data) => socket.send(String(data) === 'PING' ? 'PONG' : 'ACK')));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      })
  );
  return (wss.address() as AddressInfo).port;
}

beforeAll(async () => {
  expect(await loadTcpTransport()).not.toBeNull();
});

describe('raw TCP URLs', () => {
  it('uses the WebSocket port with tcp for local servers and tcps otherwise', () => {
    expect(getServerTcpUrl(server({ port: 8080 }))).toBe('tcp://127.0.0.1:8080');
    expect(getServerTcpUrl(server({ id: 'abc', domain: 'speed.example.com', port: 443 }))).toBe(
      'tcps://speed.example.com:443'
    );
    expect(getServerTcpUrl(server({ id: 'abc', domain: 'speed.example.com', port: null }))).toBe(
      'tcps://speed.example.com:443'
    );
  });

  it('recognizes raw TCP URLs', () => {
    expect(isTcpUrl('tcp://a:1')).toBe(true);
    expect(isTcpUrl('tcps://a:1')).toBe(true);
    expect(isTcpUrl('wss://a:1/v1/ws')).toBe(false);
  });
});

describe('resolveServerUrl', () => {
  it('uses raw TCP when the server supports it', async () => {
    const port = await startTransportServer();
    expect(await resolveServerUrl(server({ port }))).toEqual({ url: `tcp://127.0.0.1:${port}`, protocol: 'TCP' });
  });

  it('falls back to WebSocket for servers without raw TCP', async () => {
    const port = await startWebSocketOnlyServer();
    expect(await resolveServerUrl(server({ port }))).toEqual({ url: `ws://127.0.0.1:${port}/v1/ws`, protocol: 'WSS' });
  });

  it('never probes CDN servers', async () => {
    const port = await startTransportServer();
    const resolved = await resolveServerUrl(server({ port, isCDN: true }));
    expect(resolved.protocol).toBe('WSS');
  });

  it('honors websocket and tcp without probing', async () => {
    expect((await resolveServerUrl(server({ port: 1 }), 'websocket')).protocol).toBe('WSS');
    expect(await resolveServerUrl(server({ port: 1 }), 'tcp')).toEqual({ url: 'tcp://127.0.0.1:1', protocol: 'TCP' });
  });
});

describe('stages over raw TCP', () => {
  it('opens sockets with the WebSocket API', async () => {
    const port = await startTransportServer();
    const socket = openSocket(`tcp://127.0.0.1:${port}`);
    await new Promise((resolve) => (socket.onopen = resolve));
    expect(socket.readyState).toBe(SOCKET_OPEN);
    socket.send('PING');
    const reply = await new Promise<MessageEvent>((resolve) => (socket.onmessage = resolve));
    expect(reply.data).toBe('PONG');
    socket.close();
  });

  it('measures latency', async () => {
    const port = await startTransportServer();
    const result = await runLatencyTest({
      serverUrl: `tcp://127.0.0.1:${port}`,
      pingCount: 5,
      cancellationToken: new CancellationToken(),
    });
    expect(result.latencies).toHaveLength(5);
  });

  it('estimates download and upload speed', async () => {
    const port = await startTransportServer();
    const serverUrl = `tcp://127.0.0.1:${port}`;
    const options = { serverUrl, latencyMs: 0, jitterMs: 0, cancellationToken: new CancellationToken() };
    expect((await runDownloadEstimationTest(options)).bytes).toBeGreaterThan(0);
    expect((await runUploadEstimationTest(options)).bytes).toBeGreaterThan(0);
  });

  it('runs download and upload throughput stages', async () => {
    const port = await startTransportServer();
    const options = {
      serverUrl: `tcp://127.0.0.1:${port}`,
      messageSizeKb: 64,
      connectionCount: 2,
      durationMs: 500,
      latencyMs: 0,
      jitterMs: 0,
      cancellationToken: new CancellationToken(),
    };
    const download = await runDownloadSpeedTest(options);
    expect(download.bytes).toBeGreaterThan(0);
    expect(download.speedMbps).toBeGreaterThan(0);
    const upload = await runUploadSpeedTest(options);
    expect(upload.bytes).toBeGreaterThan(0);
  });

  it('hosts raw TCP lanes in workers without a matching WebSocket', async () => {
    const port = await startTransportServer();
    const posted: WorkerToHostMessage[] = [];
    let listener: ((message: HostToWorkerMessage) => void) | null = null;
    const counters = new SharedArrayBuffer(8);
    await hostWorkerLane(
      {
        postMessage: (message) => posted.push(message),
        on: (_event, fn) => {
          listener = fn;
        },
      },
      {
        direction: 'download',
        serverUrl: `tcp://127.0.0.1:${port}`,
        connectionCount: 1,
        messageSizeKb: 64,
        counters,
        slot: 0,
        webSocketSource: null,
      }
    );
    expect(posted).toEqual([{ type: 'ready' }]);
    await expect.poll(() => posted.some((message) => message.type === 'open')).toBe(true);
    listener!({ type: 'start' });
    await expect.poll(() => Atomics.load(new BigInt64Array(counters), 0)).toBeGreaterThan(0n);
    listener!({ type: 'close' });
  });
});
