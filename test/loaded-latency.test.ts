import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLoadedLatencyMonitor } from '../src/tests/loaded-latency-test.js';
import { CancellationToken } from '../src/utils/cancellation.js';

class LoadedLatencySocketMock {
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

  constructor(_url: string) {
    setTimeout(() => {
      this.readyState = LoadedLatencySocketMock.OPEN;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  send(payload: string | Uint8Array): void {
    if (payload === 'PING') {
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
    vi.restoreAllMocks();
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
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await monitor.stop();

    expect(result.latencies.length).toBeGreaterThan(0);
    expect(result.minLatency).toBeGreaterThan(0);
  });

  it('rejects when no ping responses are received', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(monitor.stop()).rejects.toThrow('No loaded latency ping responses received');
  });
});
