// @vitest-environment node
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { LOCALHOST_CERT, LOCALHOST_KEY } from './fixtures/tls-localhost.js';
import { createSpeedTestServer } from '@coveragemap/speed-transport';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { runDownloadEstimationTest } from '../src/tests/download-estimation-test.js';
import { runDownloadSpeedTest } from '../src/tests/download-speed-test.js';
import { runLatencyTest } from '../src/tests/latency-test.js';
import {
  NodeWebSocket,
  NodeWebSocketCloseEvent,
  getPremaskedZeroFrame,
  parseWebSocketUrl,
} from '../src/tests/node-websocket.js';
import {
  SocketConnectError,
  loadNodeWebSocket,
  openSocket,
  sendZeroFilled,
  usesNodeWebSocket,
} from '../src/tests/sockets.js';
import { runUploadEstimationTest } from '../src/tests/upload-estimation-test.js';
import { runUploadSpeedTest } from '../src/tests/upload-speed-test.js';
import {
  getWorkerThreadCount,
  hostWorkerLane,
  type HostToWorkerMessage,
  type WorkerToHostMessage,
} from '../src/tests/worker-lanes.js';
import { CancellationToken } from '../src/utils/cancellation.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A `ws` server, which rejects unmasked or malformed client frames. Records what it receives. */
async function startWsServer(onConnection?: (socket: WsSocket) => void) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const received: Array<{ data: Buffer; binary: boolean }> = [];
  const closes: number[] = [];
  wss.on('connection', (socket) => {
    socket.on('message', (data, binary) => received.push({ data: Buffer.from(data as Buffer), binary }));
    socket.on('close', (code) => closes.push(code));
    onConnection?.(socket);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      })
  );
  return { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v1/ws`, received, closes };
}

/** The speed test server from speed-transport, WebSocket on a plaintext port. */
async function startSpeedTestServer(): Promise<string> {
  const transport = createSpeedTestServer({ websocket: { path: '/v1/ws' } });
  await transport.listen(0, '127.0.0.1');
  cleanups.push(() => transport.close());
  return `ws://127.0.0.1:${transport.address()!.port}/v1/ws`;
}

/** A TCP server that answers every connection with `response`, or never answers when null. */
async function startRawServer(response: string | null): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket.on('error', () => {}));
    if (response !== null) socket.once('data', () => socket.write(response));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
}

function open(url: string, options?: ConstructorParameters<typeof NodeWebSocket>[1]): Promise<NodeWebSocket> {
  const socket = new NodeWebSocket(url, options);
  cleanups.push(() => socket.close());
  return new Promise((resolve, reject) => {
    socket.onopen = () => resolve(socket);
    socket.onerror = () => reject(new Error('error before open'));
  });
}

function nextMessage(socket: NodeWebSocket): Promise<MessageEvent> {
  return new Promise((resolve) => (socket.onmessage = resolve));
}

/** Resolves with the error and close events of a socket that must never open. */
function failure(socket: NodeWebSocket): Promise<{ opened: boolean; errors: number; close: NodeWebSocketCloseEvent }> {
  let opened = false;
  let errors = 0;
  socket.onopen = () => (opened = true);
  socket.onerror = () => errors++;
  return new Promise((resolve) => (socket.onclose = (close) => resolve({ opened, errors, close })));
}

describe('parseWebSocketUrl', () => {
  it('uses the default port of each scheme and keeps the path and query', () => {
    expect(parseWebSocketUrl('wss://speed.example.com/v1/ws')).toEqual({
      secure: true,
      host: 'speed.example.com',
      port: 443,
      hostHeader: 'speed.example.com',
      path: '/v1/ws',
    });
    expect(parseWebSocketUrl('ws://speed.example.com:8080/v1/ws?a=1')).toMatchObject({
      secure: false,
      port: 8080,
      hostHeader: 'speed.example.com:8080',
      path: '/v1/ws?a=1',
    });
    expect(parseWebSocketUrl('ws://[::1]:9000/')).toMatchObject({ host: '::1', hostHeader: '[::1]:9000', path: '/' });
  });

  it('rejects other schemes', () => {
    expect(() => parseWebSocketUrl('tcp://speed.example.com:443')).toThrow(SyntaxError);
  });
});

describe('getPremaskedZeroFrame', () => {
  /** Unmasks a client frame built by getPremaskedZeroFrame. */
  function unmask(frame: Buffer): { opcode: number; masked: boolean; payload: Buffer } {
    const code = frame[1] & 0x7f;
    const keyAt = code === 126 ? 4 : code === 127 ? 10 : 2;
    const key = frame.subarray(keyAt, keyAt + 4);
    const payload = Buffer.from(frame.subarray(keyAt + 4));
    for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
    return { opcode: frame[0], masked: (frame[1] & 0x80) !== 0, payload };
  }

  it('builds a final, masked binary frame whose payload unmasks to zeros', () => {
    for (const length of [0, 1, 125, 126, 65535, 65536, 1024 * 1024]) {
      const { opcode, masked, payload } = unmask(getPremaskedZeroFrame(length));
      expect(opcode).toBe(0x82);
      expect(masked).toBe(true);
      expect(payload.length).toBe(length);
      expect(payload.every((byte) => byte === 0)).toBe(true);
    }
  });

  it('reuses one frame per size', () => {
    expect(getPremaskedZeroFrame(4096)).toBe(getPremaskedZeroFrame(4096));
  });
});

describe('NodeWebSocket', () => {
  it('sends masked text, binary, and zero-filled messages a strict server accepts', async () => {
    const server = await startWsServer();
    const socket = await open(server.url);
    socket.send('hello');
    socket.send(new Uint8Array([1, 2, 3]));
    socket.send(new Uint8Array([4, 5, 6]).buffer);
    socket.sendZeroFilled(200_000);
    await expect.poll(() => server.received.length).toBe(4);
    expect(server.received[0]).toEqual({ data: Buffer.from('hello'), binary: false });
    expect(server.received[1]).toEqual({ data: Buffer.from([1, 2, 3]), binary: true });
    expect(server.received[2]).toEqual({ data: Buffer.from([4, 5, 6]), binary: true });
    expect(server.received[3].binary).toBe(true);
    expect(server.received[3].data.length).toBe(200_000);
    expect(server.received[3].data.every((byte) => byte === 0)).toBe(true);
  });

  it('delivers text as strings, small binary messages with their bytes, and large ones by length only', async () => {
    const { url } = await startWsServer((client) => {
      client.send('PONG');
      client.send(Buffer.from([9, 8, 7]));
      client.send(Buffer.alloc(100 * 1024, 0xff));
    });
    const socket = new NodeWebSocket(url);
    cleanups.push(() => socket.close());
    const messages: unknown[] = [];
    socket.onmessage = (event) => messages.push(event.data);
    await expect.poll(() => messages.length).toBe(3);
    expect(messages[0]).toBe('PONG');
    expect(messages[1]).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(messages[1] as ArrayBuffer)]).toEqual([9, 8, 7]);
    // Counted, not read: the length is right, but the server's 0xff bytes were never copied.
    expect(messages[2]).toBeInstanceOf(ArrayBuffer);
    expect((messages[2] as ArrayBuffer).byteLength).toBe(100 * 1024);
    expect(new Uint8Array(messages[2] as ArrayBuffer).every((byte) => byte === 0)).toBe(true);
  });

  it('fires error once and then an abnormal close when the server drops the connection after open', async () => {
    const { url } = await startWsServer((client) => setTimeout(() => client.terminate(), 20));
    const socket = await open(url);
    const events = await new Promise<string[]>((resolve) => {
      const seen: string[] = [];
      socket.onerror = () => seen.push('error');
      socket.onclose = (event) => resolve([...seen, `close ${event.code} ${event.wasClean}`]);
    });
    expect(events).toEqual(['error', 'close 1006 false']);
  });

  it('fires error once and then an abnormal close when the connection is reset after open', async () => {
    const { url } = await startWsServer((client) =>
      setTimeout(() => (client as unknown as { _socket: net.Socket })._socket.resetAndDestroy(), 20)
    );
    const socket = await open(url);
    const events = await new Promise<string[]>((resolve) => {
      const seen: string[] = [];
      socket.onerror = () => seen.push('error');
      socket.onclose = (event) => resolve([...seen, `close ${event.code}`]);
    });
    expect(events).toEqual(['error', 'close 1006']);
  });

  it('fires no error when the server closes cleanly', async () => {
    const { url } = await startWsServer((client) => setTimeout(() => client.close(1000), 20));
    const socket = await open(url);
    const events = await new Promise<string[]>((resolve) => {
      const seen: string[] = [];
      socket.onerror = () => seen.push('error');
      socket.onclose = (event) => resolve([...seen, `close ${event.code} ${event.wasClean}`]);
    });
    expect(events).toEqual(['close 1000 true']);
  });

  it('lets download estimation reconnect when its socket is dropped after open', async () => {
    let connections = 0;
    const { url } = await startWsServer((client) => {
      const first = ++connections === 1;
      client.on('message', (data, binary) => {
        if (binary) return;
        const [command, sizeKb] = String(data).split(' ');
        if (command !== 'START') return;
        // The first connection drops on its first request; the second one answers.
        if (first) client.terminate();
        else client.send(Buffer.alloc(Number(sizeKb) * 1024));
      });
    });
    await loadNodeWebSocket();
    const started = Date.now();
    const result = await runDownloadEstimationTest({
      serverUrl: url,
      latencyMs: 0,
      jitterMs: 0,
      timeoutMs: 10_000,
      cancellationToken: new CancellationToken(),
    });
    expect(result.bytes).toBeGreaterThan(0);
    expect(connections).toBe(2);
    // Reconnected after the 1 s retry delay, not after the 10 s timeout.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('answers pings', async () => {
    let pongs = 0;
    const { url } = await startWsServer((client) => {
      client.on('pong', () => pongs++);
      client.ping();
    });
    await open(url);
    await expect.poll(() => pongs).toBe(1);
  });

  it('closes cleanly', async () => {
    const server = await startWsServer();
    const socket = await open(server.url);
    let errors = 0;
    socket.onerror = () => errors++;
    const closed = new Promise<NodeWebSocketCloseEvent>((resolve) => (socket.onclose = resolve));
    socket.close();
    expect(socket.readyState).toBe(NodeWebSocket.CLOSING);
    const event = await closed;
    expect(socket.readyState).toBe(NodeWebSocket.CLOSED);
    expect(errors).toBe(0);
    expect(event.wasClean).toBe(true);
    expect(event.code).toBe(1000);
    await expect.poll(() => server.closes).toEqual([1000]);
  });

  it('throws on send before the connection opens', async () => {
    const server = await startWsServer();
    const socket = new NodeWebSocket(server.url);
    cleanups.push(() => socket.close());
    expect(() => socket.send('PING')).toThrow('CONNECTING');
    expect(() => socket.sendZeroFilled(10)).toThrow('CONNECTING');
  });

  it('fails without opening when the server does not upgrade', async () => {
    const server = http.createServer((_req, res) => res.writeHead(403).end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const socket = new NodeWebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/ws`);
    const { opened, errors, close } = await failure(socket);
    expect([opened, errors, close.code]).toEqual([false, 1, 1006]);
  });

  it('fails without opening when the accept key is wrong', async () => {
    const port = await startRawServer(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n'
    );
    const { opened, errors, close } = await failure(new NodeWebSocket(`ws://127.0.0.1:${port}/v1/ws`));
    expect([opened, errors, close.code]).toEqual([false, 1, 1006]);
  });

  it('gives up on a handshake that is never answered after connectTimeoutMs', async () => {
    const port = await startRawServer(null);
    const started = Date.now();
    const { opened, errors, close } = await failure(new NodeWebSocket(`ws://127.0.0.1:${port}/v1/ws`, { connectTimeoutMs: 200 }));
    expect([opened, errors, close.code]).toEqual([false, 1, 1006]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('NodeWebSocket over TLS (wss://)', () => {
  /**
   * An HTTPS server with a `ws` server on it, speaking enough of the speed test protocol:
   * PING -> PONG, START <kb> <count> -> frames, uploads -> ACK. Records each connection's SNI.
   */
  async function startSecureServer() {
    const server = https.createServer({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY });
    const wss = new WebSocketServer({ server });
    const servernames: Array<string | false | null | undefined> = [];
    const uploads: Buffer[] = [];
    wss.on('connection', (client, request) => {
      servernames.push((request.socket as TLSSocket).servername);
      client.on('message', (data, binary) => {
        if (binary) {
          uploads.push(Buffer.from(data as Buffer));
          client.send('ACK');
          return;
        }
        const [command, sizeKb, count] = String(data).split(' ');
        if (command === 'PING') client.send('PONG');
        if (command === 'START') {
          for (let i = 0; i < Number(count); i++) client.send(Buffer.alloc(Number(sizeKb) * 1024, 0xff));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const client of wss.clients) client.terminate();
          wss.close();
          server.close(() => resolve());
        })
    );
    return { port: (server.address() as AddressInfo).port, servernames, uploads };
  }

  it('connects with SNI, exchanges commands, counts downloads, and uploads zeros', async () => {
    const server = await startSecureServer();
    const socket = await open(`wss://localhost:${server.port}/v1/ws`, { ca: LOCALHOST_CERT });
    expect(server.servernames).toEqual(['localhost']);

    socket.send('PING');
    expect((await nextMessage(socket)).data).toBe('PONG');

    // Large frames over TLS go through the read buffer and are counted without being copied.
    const sizes: number[] = [];
    socket.onmessage = (event) => {
      const data = event.data as ArrayBuffer;
      expect(new Uint8Array(data).every((byte) => byte === 0)).toBe(true);
      sizes.push(data.byteLength);
    };
    socket.send('START 512 4');
    await expect.poll(() => sizes).toEqual([512 * 1024, 512 * 1024, 512 * 1024, 512 * 1024]);

    socket.sendZeroFilled(300_000);
    await expect.poll(() => server.uploads.length).toBe(1);
    expect(server.uploads[0].length).toBe(300_000);
    expect(server.uploads[0].every((byte) => byte === 0)).toBe(true);
  });

  it('sends no SNI to an IP address', async () => {
    const server = await startSecureServer();
    await open(`wss://127.0.0.1:${server.port}/v1/ws`, { ca: LOCALHOST_CERT });
    expect(server.servernames).toEqual([false]);
  });

  it('checks the certificate by default: an untrusted one fails without opening', async () => {
    const server = await startSecureServer();
    const { opened, errors, close } = await failure(new NodeWebSocket(`wss://localhost:${server.port}/v1/ws`));
    expect([opened, errors, close.code]).toEqual([false, 1, 1006]);
    expect(server.servernames).toEqual([]);
  });
});

describe('sockets with the Node.js WebSocket client', () => {
  beforeAll(async () => {
    expect(await loadNodeWebSocket()).not.toBeNull();
  });

  it('opens ws:// and wss:// with the Node.js client, but not raw TCP', () => {
    expect(usesNodeWebSocket('ws://127.0.0.1:1/v1/ws')).toBe(true);
    expect(usesNodeWebSocket('wss://speed.example.com/v1/ws')).toBe(true);
    expect(usesNodeWebSocket('tcp://127.0.0.1:1')).toBe(false);
  });

  it('works without a global WebSocket', async () => {
    const url = await startSpeedTestServer();
    const saved = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
    try {
      const socket = openSocket(url);
      cleanups.push(() => socket.close());
      expect(socket).toBeInstanceOf(NodeWebSocket);
      await new Promise((resolve) => (socket.onopen = resolve));
      socket.send('PING');
      expect((await nextMessage(socket as unknown as NodeWebSocket)).data).toBe('PONG');
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = saved;
    }
  });

  it('uses the global WebSocket for every socket of a stage when nodeWebSocket is false', async () => {
    const url = await startSpeedTestServer();
    const { WebSocket: WsWebSocket } = await import('ws');
    const opened: string[] = [];
    class CountingWebSocket extends WsWebSocket {
      constructor(address: string) {
        super(address);
        opened.push(address);
      }
    }
    const saved = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = CountingWebSocket;
    try {
      expect(usesNodeWebSocket(url, false)).toBe(false);
      const socket = openSocket(url, { nodeWebSocket: false });
      expect(socket).toBeInstanceOf(CountingWebSocket);
      // `ws` reports a socket closed while connecting as an unhandled error, so wait for open.
      await new Promise((resolve) => (socket.onopen = resolve));
      socket.close();

      const cancellationToken = new CancellationToken();
      await runLatencyTest({ serverUrl: url, pingCount: 5, cancellationToken, nodeWebSocket: false });
      await runUploadSpeedTest({
        serverUrl: url,
        messageSizeKb: 64,
        connectionCount: 2,
        durationMs: 300,
        latencyMs: 0,
        jitterMs: 0,
        cancellationToken,
        nodeWebSocket: false,
      });
      // The latency socket, both upload sockets, and the loaded latency socket.
      expect(opened).toHaveLength(5);
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = saved;
    }
  });

  it('sends zero-filled chunks through sendZeroFilled where a socket has it, and send() otherwise', () => {
    const chunk = new Uint8Array(8);
    const fast = { sendZeroFilled: (length: number) => sent.push(`zeros ${length}`), send: () => sent.push('send') };
    const plain = { send: (data: Uint8Array) => sent.push(data) };
    const sent: unknown[] = [];
    sendZeroFilled(fast as unknown as WebSocket, chunk);
    sendZeroFilled(plain as unknown as WebSocket, chunk);
    expect(sent).toEqual(['zeros 8', chunk]);
  });

  it('reports a handshake that is never answered as a connect error', async () => {
    const port = await startRawServer(null);
    await expect(
      runLatencyTest({
        serverUrl: `ws://127.0.0.1:${port}/v1/ws`,
        pingCount: 3,
        connectTimeoutMs: 300,
        cancellationToken: new CancellationToken(),
      })
    ).rejects.toBeInstanceOf(SocketConnectError);
  });

  it('runs every stage against the speed test server', async () => {
    const serverUrl = await startSpeedTestServer();
    const cancellationToken = new CancellationToken();
    expect((await runLatencyTest({ serverUrl, pingCount: 5, cancellationToken })).latencies).toHaveLength(5);
    const estimation = { serverUrl, latencyMs: 0, jitterMs: 0, cancellationToken };
    expect((await runDownloadEstimationTest(estimation)).bytes).toBeGreaterThan(0);
    expect((await runUploadEstimationTest(estimation)).bytes).toBeGreaterThan(0);
    const throughput = {
      serverUrl,
      messageSizeKb: 256,
      connectionCount: 2,
      durationMs: 500,
      latencyMs: 0,
      jitterMs: 0,
      cancellationToken,
    };
    const download = await runDownloadSpeedTest(throughput);
    expect(download.bytes).toBeGreaterThan(0);
    expect(download.speedMbps).toBeGreaterThan(0);
    const upload = await runUploadSpeedTest(throughput);
    expect(upload.bytes).toBeGreaterThan(0);
    expect(upload.bytes % (256 * 1024)).toBe(0);
  });

  it('hosts WebSocket lanes in workers with the Node.js client and no matching global WebSocket', async () => {
    const serverUrl = await startSpeedTestServer();
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
        direction: 'upload',
        serverUrl,
        connectionCount: 1,
        messageSizeKb: 64,
        counters,
        slot: 0,
        webSocketSource: null,
        nodeWebSocket: true,
      }
    );
    expect(posted).toEqual([{ type: 'ready' }]);
    await expect.poll(() => posted.some((message) => message.type === 'open')).toBe(true);
    listener!({ type: 'start' });
    await expect.poll(() => Atomics.load(new BigInt64Array(counters), 0)).toBeGreaterThan(0n);
    listener!({ type: 'close' });
  });
});

describe('getWorkerThreadCount', () => {
  it('uses up to one worker per core, so two core clients get two', () => {
    expect(getWorkerThreadCount(6, 2)).toBe(2);
    expect(getWorkerThreadCount(6, 4)).toBe(4);
    expect(getWorkerThreadCount(6, 16)).toBe(6);
    expect(getWorkerThreadCount(6, 1)).toBe(1);
    expect(getWorkerThreadCount(6, 0)).toBe(1);
  });
});
