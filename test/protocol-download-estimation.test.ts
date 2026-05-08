import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDownloadEstimationTest } from '../src/tests/download-estimation-test.js';
import { CancellationToken } from '../src/utils/cancellation.js';

class DownloadEstimationSocketMock {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = DownloadEstimationSocketMock.CONNECTING;
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(_url: string) {
    setTimeout(() => {
      this.readyState = DownloadEstimationSocketMock.OPEN;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  send(payload: string | Uint8Array): void {
    if (typeof payload === 'string' && payload.startsWith('START')) {
      const [, kb] = payload.split(' ');
      const bytes = Number(kb) * 1024;
      setTimeout(() => {
        this.onmessage?.({ data: new ArrayBuffer(bytes) } as MessageEvent);
      }, 0);
    }
  }

  close(): void {
    this.readyState = DownloadEstimationSocketMock.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

describe('download estimation protocol', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('estimates download speed from binary payload responses', async () => {
    vi.stubGlobal('WebSocket', DownloadEstimationSocketMock as unknown as typeof WebSocket);
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 120;
      return now;
    });

    const result = await runDownloadEstimationTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      latencyMs: 5,
      jitterMs: 5,
      cancellationToken: new CancellationToken(),
    });

    expect(result.bytes).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.speedMbps).toBeGreaterThan(0);
  });

  it('retries on socket error and succeeds on reconnect', async () => {
    class RetrySocketMock extends DownloadEstimationSocketMock {
      static instances = 0;

      constructor(url: string) {
        super(url);
        RetrySocketMock.instances++;
        const current = RetrySocketMock.instances;
        if (current === 1) {
          setTimeout(() => {
            this.onerror?.(new Event('error'));
          }, 0);
        }
      }
    }

    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', RetrySocketMock as unknown as typeof WebSocket);
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 150;
      return now;
    });

    const promise = runDownloadEstimationTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      latencyMs: 5,
      jitterMs: 5,
      cancellationToken: new CancellationToken(),
    });

    await vi.runAllTimersAsync();
    const result = await promise;
    expect(RetrySocketMock.instances).toBeGreaterThan(1);
    expect(result.speedMbps).toBeGreaterThan(0);
  });

  it('fails with timeout when no payloads are received', async () => {
    class NeverRespondSocketMock extends DownloadEstimationSocketMock {
      send(): void {
        // Intentionally no-op to trigger timeout path.
      }
    }

    vi.stubGlobal('WebSocket', NeverRespondSocketMock as unknown as typeof WebSocket);
    await expect(
      runDownloadEstimationTest({
        serverUrl: 'wss://speed.example.com/v1/ws',
        latencyMs: 5,
        jitterMs: 5,
        timeoutMs: 20,
        cancellationToken: new CancellationToken(),
      })
    ).rejects.toThrow('Download estimation timed out');
  });
});
