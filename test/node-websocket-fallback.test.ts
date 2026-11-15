// @vitest-environment node
import { createSpeedTestServer } from '@coveragemap/speed-transport';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket as WsWebSocket } from 'ws';
import { runLatencyTest } from '../src/tests/latency-test.js';
import { loadNodeWebSocket, openSocket, usesNodeWebSocket } from '../src/tests/sockets.js';
import { CancellationToken } from '../src/utils/cancellation.js';

// The Node.js WebSocket client cannot load (a bundle that left the file out, for example).
vi.mock('../src/tests/node-websocket.js', () => {
  throw new Error('node-websocket.js is not available');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('when the Node.js WebSocket client cannot load', () => {
  it('resolves null and keeps WebSockets on the global WebSocket', async () => {
    expect(await loadNodeWebSocket()).toBeNull();
    expect(usesNodeWebSocket('wss://speed.example.com/v1/ws')).toBe(false);

    const opened: string[] = [];
    class CountingWebSocket extends WsWebSocket {
      constructor(address: string) {
        super(address);
        opened.push(address);
      }
    }
    vi.stubGlobal('WebSocket', CountingWebSocket);

    const transport = createSpeedTestServer({ websocket: { path: '/v1/ws' } });
    await transport.listen(0, '127.0.0.1');
    try {
      const url = `ws://127.0.0.1:${transport.address()!.port}/v1/ws`;
      const socket = openSocket(url);
      expect(socket).toBeInstanceOf(CountingWebSocket);
      await new Promise((resolve) => (socket.onopen = resolve));
      socket.close();

      const result = await runLatencyTest({ serverUrl: url, pingCount: 5, cancellationToken: new CancellationToken() });
      expect(result.latencies).toHaveLength(5);
      expect(opened).toEqual([url, url]);
    } finally {
      await transport.close();
    }
  });
});
