// @vitest-environment node
import net, { type AddressInfo } from 'node:net';
import {
  FrameParser,
  Opcode,
  TCP_PREAMBLE,
  computeAcceptKey,
  encodeFrameHeader,
} from '@coveragemap/speed-transport';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { supportsPayloadProgress } from '../src/tests/payload-progress.js';
import { loadNodeWebSocket, loadTcpTransport, openSocket } from '../src/tests/sockets.js';
import { openDownloadLane } from '../src/tests/throughput-lanes.js';
import { hostWorkerLane, type HostToWorkerMessage, type LanePort } from '../src/tests/worker-lanes.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

beforeAll(async () => {
  expect(await loadTcpTransport()).not.toBeNull();
  expect(await loadNodeWebSocket()).not.toBeNull();
});

const MESSAGE_BYTES = 1024 * 1024;
const FIRST_PART_BYTES = 300 * 1024;

/**
 * A server that answers `START` with one 1 MiB binary message, sending its first 300 KiB at
 * once and the rest when `release()` is called. Raw TCP or WebSocket.
 */
async function startSlowServer(kind: 'tcp' | 'ws') {
  let releaseRest: (() => void) | null = null;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket.on('error', () => {}));
    let handshake = true;
    const commands = new FrameParser(
      { requireMask: false, maxMessageBytes: 1 << 20, maxBufferedMessageBytes: 1 << 20 },
      {
        onMessage: (data, binary) => {
          if (binary || !data.toString().startsWith('START')) return;
          const frame = Buffer.concat([encodeFrameHeader(Opcode.Binary, MESSAGE_BYTES), Buffer.alloc(MESSAGE_BYTES)]);
          const split = frame.length - (MESSAGE_BYTES - FIRST_PART_BYTES);
          socket.write(frame.subarray(0, split));
          releaseRest = () => socket.write(frame.subarray(split));
        },
        onBulkMessage: () => {},
        onPing: () => {},
        onPong: () => {},
        onClose: () => socket.destroy(),
        onError: () => socket.destroy(),
      }
    );
    socket.on('data', (chunk: Buffer) => {
      if (!handshake) {
        commands.push(chunk);
        return;
      }
      handshake = false;
      if (kind === 'tcp') {
        socket.write(TCP_PREAMBLE);
        if (chunk.length > TCP_PREAMBLE.length) commands.push(chunk.subarray(TCP_PREAMBLE.length));
        return;
      }
      const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(chunk.toString('latin1'))![1].trim();
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${computeAcceptKey(key)}\r\n\r\n`
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: kind === 'tcp' ? `tcp://127.0.0.1:${port}` : `ws://127.0.0.1:${port}/v1/ws`,
    /** Resolves once the server has sent the first part. */
    firstPartSent: () => expect.poll(() => releaseRest !== null).toBe(true),
    release: () => releaseRest!(),
  };
}

describe('download lanes on Node.js sockets', () => {
  it.each(['tcp', 'ws'] as const)('give %s sockets payload progress', async (kind) => {
    const { url } = await startSlowServer(kind);
    const socket = openSocket(url);
    cleanups.push(() => socket.close());
    expect(supportsPayloadProgress(socket)).toBe(true);
  });

  it.each(['tcp', 'ws'] as const)('count %s bytes as they arrive, each byte once', async (kind) => {
    const server = await startSlowServer(kind);
    const reported: number[] = [];
    let opened = false;
    const lane = openDownloadLane(
      { serverUrl: server.url, connectionCount: 1, messageSizeKb: 1024 },
      {
        onOpen: () => {
          opened = true;
        },
        onError: (error) => {
          throw error;
        },
        onBytes: (bytes) => reported.push(bytes),
      }
    );
    cleanups.push(() => lane.close());
    await expect.poll(() => opened).toBe(true);
    lane.start();
    await server.firstPartSent();

    // The message is still arriving: its first part already counts.
    await expect.poll(() => lane.bytes).toBe(FIRST_PART_BYTES);
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.at(-1)).toBe(FIRST_PART_BYTES);

    server.release();
    await expect.poll(() => lane.bytes).toBe(MESSAGE_BYTES);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lane.bytes).toBe(MESSAGE_BYTES);
    expect(reported.at(-1)).toBe(MESSAGE_BYTES);
  });

  it('publish bytes still arriving from worker-thread lanes', async () => {
    const server = await startSlowServer('tcp');
    const counters = new SharedArrayBuffer(8);
    const view = new BigInt64Array(counters);
    let toWorker: ((message: HostToWorkerMessage) => void) | null = null;
    const messages: string[] = [];
    const port: LanePort = {
      postMessage: (message) => messages.push(message.type),
      on: (_event, listener) => {
        toWorker = listener;
      },
    };
    await hostWorkerLane(port, {
      direction: 'download',
      serverUrl: server.url,
      connectionCount: 1,
      messageSizeKb: 1024,
      counters,
      slot: 0,
      webSocketSource: null,
    });
    cleanups.push(() => toWorker?.({ type: 'close' }));
    await expect.poll(() => messages.includes('open')).toBe(true);
    toWorker!({ type: 'start' });
    await server.firstPartSent();
    await expect.poll(() => Number(Atomics.load(view, 0))).toBe(FIRST_PART_BYTES);
    server.release();
    await expect.poll(() => Number(Atomics.load(view, 0))).toBe(MESSAGE_BYTES);
    expect(messages.filter((type) => type === 'bytes')).toHaveLength(1);
  });
});
