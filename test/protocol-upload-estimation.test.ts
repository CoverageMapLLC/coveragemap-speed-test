import { afterEach, describe, expect, it, vi } from 'vitest';
import { runUploadEstimationTest } from '../src/tests/upload-estimation-test.js';
import { CancellationToken } from '../src/utils/cancellation.js';

class UploadEstimationSocketMock {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = UploadEstimationSocketMock.CONNECTING;
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(_url: string) {
    setTimeout(() => {
      this.readyState = UploadEstimationSocketMock.OPEN;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  send(payload: string | Uint8Array): void {
    if (payload instanceof Uint8Array) {
      setTimeout(() => {
        this.onmessage?.({ data: 'ACK' } as MessageEvent);
      }, 0);
    }
  }

  close(): void {
    this.readyState = UploadEstimationSocketMock.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

describe('upload estimation protocol', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('estimates upload speed from ACK responses', async () => {
    vi.stubGlobal('WebSocket', UploadEstimationSocketMock as unknown as typeof WebSocket);
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 120;
      return now;
    });

    const result = await runUploadEstimationTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      latencyMs: 5,
      jitterMs: 5,
      cancellationToken: new CancellationToken(),
    });

    expect(result.bytes).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.speedMbps).toBeGreaterThan(0);
  });

  it('fails when websocket closes before completion', async () => {
    class EarlyCloseSocketMock extends UploadEstimationSocketMock {
      send(): void {
        setTimeout(() => {
          this.onclose?.(new CloseEvent('close'));
        }, 0);
      }
    }

    vi.stubGlobal('WebSocket', EarlyCloseSocketMock as unknown as typeof WebSocket);
    await expect(
      runUploadEstimationTest({
        serverUrl: 'wss://speed.example.com/v1/ws',
        latencyMs: 5,
        jitterMs: 5,
        cancellationToken: new CancellationToken(),
      })
    ).rejects.toThrow('WebSocket closed before upload estimation completed');
  });

  it('times out when ACK responses are never received', async () => {
    class NoAckSocketMock extends UploadEstimationSocketMock {
      send(): void {
        // Intentionally no ACK.
      }
    }

    vi.stubGlobal('WebSocket', NoAckSocketMock as unknown as typeof WebSocket);
    await expect(
      runUploadEstimationTest({
        serverUrl: 'wss://speed.example.com/v1/ws',
        latencyMs: 5,
        jitterMs: 5,
        timeoutMs: 20,
        cancellationToken: new CancellationToken(),
      })
    ).rejects.toThrow('Upload estimation timed out');
  });
});
