// @vitest-environment node
import net, { type AddressInfo } from 'node:net';
import { createSpeedTestServer, type SpeedTransportServer } from '@coveragemap/speed-transport';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { runDownloadEstimationTest } from '../src/tests/download-estimation-test.js';
import { runDownloadSpeedTest } from '../src/tests/download-speed-test.js';
import { runLatencyTest } from '../src/tests/latency-test.js';
import {
  getServerProtocols,
  getServerTcpUrl,
  getServerWebSocketUrl,
  isTcpUrl,
  loadTcpTransport,
  openSocket,
  requiresSecureWebSocket,
  selectServerUrl,
  SocketConnectError,
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

describe('server URLs', () => {
  it('uses the WebSocket port for raw TCP, always without TLS', () => {
    expect(getServerTcpUrl(server({ port: 8080 }))).toBe('tcp://127.0.0.1:8080');
    expect(getServerTcpUrl(server({ id: 'abc', domain: 'speed.example.com', port: 443 }))).toBe('tcp://speed.example.com:443');
    expect(getServerTcpUrl(server({ id: 'abc', domain: 'speed.example.com', port: null }))).toBe('tcp://speed.example.com:80');
  });

  it('builds plain and secure WebSocket URLs on the same port', () => {
    const remote = server({ id: 'abc', domain: 'speed.example.com', port: 443 });
    expect(getServerWebSocketUrl(remote, false)).toBe('ws://speed.example.com:443/v1/ws');
    expect(getServerWebSocketUrl(remote, true)).toBe('wss://speed.example.com:443/v1/ws');
    expect(getServerWebSocketUrl(server({ port: null }), false)).toBe('ws://127.0.0.1:80/v1/ws');
    expect(getServerWebSocketUrl(server({ port: null }), true)).toBe('wss://127.0.0.1:443/v1/ws');
  });

  it('recognizes raw TCP URLs', () => {
    expect(isTcpUrl('tcp://a:1')).toBe(true);
    expect(isTcpUrl('ws://a:1/v1/ws')).toBe(false);
    expect(isTcpUrl('wss://a:1/v1/ws')).toBe(false);
  });

  it('assumes secure WebSocket for servers that report no protocols, plain for local ones', () => {
    expect(getServerProtocols(server({ id: 'abc' }))).toEqual(['WSSv1']);
    expect(getServerProtocols(server({ id: 'abc', protocols: [] }))).toEqual(['WSSv1']);
    expect(getServerProtocols(server())).toEqual(['WSv1']);
    expect(getServerProtocols(server({ protocols: ['TCPv1'] }))).toEqual(['TCPv1']);
  });

  it('never requires secure WebSockets in Node.js', () => {
    expect(requiresSecureWebSocket()).toBe(false);
  });
});

describe('selectServerUrl', () => {
  const ALL = ['WSSv1', 'WSv1', 'TCPv1'];
  const remote = (protocols?: string[]) => server({ id: 'abc', domain: 'speed.example.com', port: 443, protocols });
  const TCP = { url: 'tcp://speed.example.com:443', protocol: 'TCP' };
  const WS = { url: 'ws://speed.example.com:443/v1/ws', protocol: 'WS' };
  const WSS = { url: 'wss://speed.example.com:443/v1/ws', protocol: 'WSS' };

  it('orders the transports fastest first: raw TCP, WebSocket, secure WebSocket', async () => {
    expect(await selectServerUrl(remote(ALL))).toEqual({ primary: TCP, fallbacks: [WS, WSS] });
    expect(await selectServerUrl(remote(['WSSv1', 'TCPv1']))).toEqual({ primary: TCP, fallbacks: [WSS] });
    expect(await selectServerUrl(remote(['WSv1', 'WSSv1']))).toEqual({ primary: WS, fallbacks: [WSS] });
    expect(await selectServerUrl(remote(['TCPv1', 'WSv1']))).toEqual({ primary: TCP, fallbacks: [WS] });
  });

  it('uses only what the server lists', async () => {
    expect(await selectServerUrl(remote(['WSSv1']))).toEqual({ primary: WSS, fallbacks: [] });
    expect(await selectServerUrl(remote())).toEqual({ primary: WSS, fallbacks: [] });
    expect(await selectServerUrl(remote(['TCPv1']))).toEqual({ primary: TCP, fallbacks: [] });
    expect(await selectServerUrl(server({ port: 8080 }))).toEqual({
      primary: { url: 'ws://127.0.0.1:8080/v1/ws', protocol: 'WS' },
      fallbacks: [],
    });
  });

  it('ignores protocols it does not know', async () => {
    expect(await selectServerUrl(remote(['QUICv1', 'WSSv1']))).toEqual({ primary: WSS, fallbacks: [] });
    await expect(selectServerUrl(remote(['QUICv1']))).rejects.toThrow('The server offers no transport this runtime can use (QUICv1)');
  });

  it('forces one transport with tcp, ws, and wss, whatever the server lists', async () => {
    expect(await selectServerUrl(remote(['WSSv1']), 'tcp')).toEqual({ primary: TCP, fallbacks: [] });
    expect(await selectServerUrl(remote(['WSSv1']), 'ws')).toEqual({ primary: WS, fallbacks: [] });
    expect(await selectServerUrl(remote(ALL), 'wss')).toEqual({ primary: WSS, fallbacks: [] });
  });

  it('never connects to the server to choose', async () => {
    let sessions = 0;
    const transport = createSpeedTestServer({
      authorize: () => {
        sessions++;
        return true;
      },
    });
    const { port } = await transport.listen(0, '127.0.0.1');
    cleanups.push(() => transport.close());
    let accepted = 0;
    transport.httpServer.on('connection', () => accepted++);
    await selectServerUrl(server({ port, protocols: ALL }));
    await selectServerUrl(server({ port }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect([sessions, accepted, transport.connectionCount]).toEqual([0, 0, 0]);
  });
});

describe('first connection failures', () => {
  it('reports a raw TCP connection a server without raw TCP refuses as a connect error', async () => {
    const port = await startWebSocketOnlyServer();
    const failure = runLatencyTest({ serverUrl: `tcp://127.0.0.1:${port}`, pingCount: 3, cancellationToken: new CancellationToken() });
    await expect(failure).rejects.toBeInstanceOf(SocketConnectError);
  });

  it('gives up on a raw TCP connection that is never answered after connectTimeoutMs', async () => {
    const sockets = new Set<net.Socket>();
    const silent = net.createServer((socket) => sockets.add(socket.on('error', () => {})));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => silent.close(() => resolve()));
    });
    const started = Date.now();
    await expect(
      runLatencyTest({
        serverUrl: `tcp://127.0.0.1:${(silent.address() as AddressInfo).port}`,
        pingCount: 3,
        connectTimeoutMs: 300,
        cancellationToken: new CancellationToken(),
      })
    ).rejects.toBeInstanceOf(SocketConnectError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('gives up on a WebSocket whose handshake is never answered after connectTimeoutMs', async () => {
    if (typeof WebSocket === 'undefined') {
      // Node.js 20 has no global WebSocket; the library expects one for ws:// URLs.
      const { WebSocket: WsWebSocket } = await import('ws');
      (globalThis as { WebSocket?: unknown }).WebSocket = WsWebSocket;
    }
    const sockets = new Set<net.Socket>();
    const silent = net.createServer((socket) => sockets.add(socket.on('error', () => {})));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => silent.close(() => resolve()));
    });
    const started = Date.now();
    await expect(
      runLatencyTest({
        serverUrl: `ws://127.0.0.1:${(silent.address() as AddressInfo).port}/v1/ws`,
        pingCount: 3,
        connectTimeoutMs: 300,
        cancellationToken: new CancellationToken(),
      })
    ).rejects.toBeInstanceOf(SocketConnectError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reports a refused connection as a connect error', async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));
    await expect(
      runLatencyTest({ serverUrl: `tcp://127.0.0.1:${port}`, pingCount: 3, cancellationToken: new CancellationToken() })
    ).rejects.toBeInstanceOf(SocketConnectError);
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
