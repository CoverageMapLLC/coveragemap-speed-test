import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLatencyTest } from '../src/tests/latency-test.js';
import { CancellationToken } from '../src/utils/cancellation.js';

class LatencySocketMock {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = LatencySocketMock.CONNECTING;
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(_url: string) {
    setTimeout(() => {
      this.readyState = LatencySocketMock.OPEN;
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
    this.readyState = LatencySocketMock.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

describe('latency protocol', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('completes ping/pong latency flow', async () => {
    vi.stubGlobal('WebSocket', LatencySocketMock as unknown as typeof WebSocket);
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 10;
      return now;
    });

    const result = await runLatencyTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      pingCount: 3,
      cancellationToken: new CancellationToken(),
    });

    expect(result.latencies).toHaveLength(3);
    expect(result.minLatency).toBeGreaterThan(0);
    expect(result.minJitter).toBeGreaterThanOrEqual(0);
  });
});
