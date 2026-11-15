// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadNodeWebSocket, usesNodeWebSocket } from '../src/tests/sockets.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadNodeWebSocket runtimes', () => {
  // Runs first: once the client is loaded, later calls return it.
  it('keeps the native WebSocket in Deno', async () => {
    vi.stubGlobal('Deno', {});
    expect(await loadNodeWebSocket()).toBeNull();
    expect(usesNodeWebSocket('wss://speed.example.com/v1/ws')).toBe(false);
  });

  it('loads the client in Node.js', async () => {
    expect(await loadNodeWebSocket()).not.toBeNull();
    expect(usesNodeWebSocket('wss://speed.example.com/v1/ws')).toBe(true);
    expect(usesNodeWebSocket('wss://speed.example.com/v1/ws', false)).toBe(false);
  });
});
