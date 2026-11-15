import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOADED_LATENCY_PING_INTERVAL_MS,
  createLoadedLatencyMonitor,
} from '../src/tests/loaded-latency-test.js';
import { CancellationToken } from '../src/utils/cancellation.js';

class LoadedLatencySocketMock {
  static instances: LoadedLatencySocketMock[] = [];
  static openDelayMs = 0;
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = LoadedLatencySocketMock.CONNECTING;
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  /** `performance.now()` at each PING. */
  pings: number[] = [];

  constructor(_url: string) {
    LoadedLatencySocketMock.instances.push(this);
    setTimeout(() => {
      this.readyState = LoadedLatencySocketMock.OPEN;
      this.onopen?.(new Event('open'));
    }, LoadedLatencySocketMock.openDelayMs);
  }

  send(payload: string | Uint8Array): void {
    if (payload === 'PING') {
      this.pings.push(performance.now());
      setTimeout(() => {
        this.onmessage?.({ data: 'PONG' } as MessageEvent);
      }, 0);
    }
  }

  close(): void {
    this.readyState = LoadedLatencySocketMock.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

describe('loaded latency monitor', () => {
  afterEach(() => {
    LoadedLatencySocketMock.instances = [];
    LoadedLatencySocketMock.openDelayMs = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('collects ping samples and returns latency stats', async () => {
    vi.stubGlobal('WebSocket', LoadedLatencySocketMock as unknown as typeof WebSocket);
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 10;
      return now;
    });

    const monitor = createLoadedLatencyMonitor({
      serverUrl: 'wss://speed.example.com/v1/ws',
      pingIntervalMs: 1000,
      cancellationToken: new CancellationToken(),
    });

    monitor.start();
    monitor.linkLoaded();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await monitor.stop();

    expect(result).not.toBeNull();
    expect(result!.latencies.length).toBeGreaterThan(0);
    expect(result!.minLatency).toBeGreaterThan(0);
  });

  it('returns null when no ping responses are received', async () => {
    class SilentSocketMock extends LoadedLatencySocketMock {
      send(): void {
        // ignore pings
      }
    }

    vi.stubGlobal('WebSocket', SilentSocketMock as unknown as typeof WebSocket);
    const monitor = createLoadedLatencyMonitor({
      serverUrl: 'wss://speed.example.com/v1/ws',
      cancellationToken: new CancellationToken(),
    });

    monitor.start();
    monitor.linkLoaded();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(monitor.stop()).resolves.toBeNull();
  });

  it('pings every 500 ms by default', () => {
    expect(DEFAULT_LOADED_LATENCY_PING_INTERVAL_MS).toBe(500);
  });

  it('connects at start but does not ping until the link is loaded', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.stubGlobal('WebSocket', LoadedLatencySocketMock as unknown as typeof WebSocket);
    const monitor = createLoadedLatencyMonitor({
      serverUrl: 'wss://speed.example.com/v1/ws',
      cancellationToken: new CancellationToken(),
    });
    const startedAt = performance.now();

    monitor.start();
    await vi.advanceTimersByTimeAsync(400);
    const [socket] = LoadedLatencySocketMock.instances;
    expect(socket.readyState).toBe(LoadedLatencySocketMock.OPEN);
    expect(socket.pings).toEqual([]);

    monitor.linkLoaded();
    // The next PING goes 500 ms after each PONG, which the mock sends at once.
    await vi.advanceTimersByTimeAsync(1100);
    const offsets = socket.pings.map((at) => at - startedAt);
    expect(offsets).toHaveLength(3);
    expect(offsets[0]).toBe(400);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i] - offsets[i - 1]).toBeGreaterThanOrEqual(500);
      expect(offsets[i] - offsets[i - 1]).toBeLessThan(502);
    }

    const result = await monitor.stop();
    expect(result!.latencies).toHaveLength(3);
  });

  it('pings as soon as the socket opens when the link was loaded first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.stubGlobal('WebSocket', LoadedLatencySocketMock as unknown as typeof WebSocket);
    LoadedLatencySocketMock.openDelayMs = 300;
    const monitor = createLoadedLatencyMonitor({
      serverUrl: 'wss://speed.example.com/v1/ws',
      cancellationToken: new CancellationToken(),
    });
    const startedAt = performance.now();

    monitor.start();
    await vi.advanceTimersByTimeAsync(100);
    monitor.linkLoaded();
    await vi.advanceTimersByTimeAsync(250);
    const [socket] = LoadedLatencySocketMock.instances;
    expect(socket.pings.map((at) => at - startedAt)).toEqual([300]);
    await monitor.stop();
  });

  it('reports no loaded latency when the link was never loaded', async () => {
    vi.stubGlobal('WebSocket', LoadedLatencySocketMock as unknown as typeof WebSocket);
    const monitor = createLoadedLatencyMonitor({
      serverUrl: 'wss://speed.example.com/v1/ws',
      cancellationToken: new CancellationToken(),
    });

    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(monitor.stop()).resolves.toBeNull();
    expect(LoadedLatencySocketMock.instances[0].pings).toEqual([]);
  });
});
