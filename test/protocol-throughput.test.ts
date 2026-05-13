import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDownloadSpeedTest } from '../src/tests/download-speed-test.js';
import { runUploadSpeedTest } from '../src/tests/upload-speed-test.js';
import { CancellationToken } from '../src/utils/cancellation.js';

class ThroughputSocketMock {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = ThroughputSocketMock.CONNECTING;
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(_url: string) {
    setTimeout(() => {
      this.readyState = ThroughputSocketMock.OPEN;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  send(payload: string | Uint8Array): void {
    if (typeof payload === 'string' && payload.startsWith('START')) {
      for (let i = 0; i < 5; i++) {
        setTimeout(() => {
          this.onmessage?.({ data: new ArrayBuffer(4 * 1024) } as MessageEvent);
        }, i * 2);
      }
      return;
    }

    if (payload instanceof Uint8Array) {
      setTimeout(() => {
        this.onmessage?.({ data: 'ACK' } as MessageEvent);
      }, 0);
    }
  }

  close(): void {
    this.readyState = ThroughputSocketMock.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

describe('throughput protocol runners', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs download throughput and emits snapshots', async () => {
    vi.stubGlobal('WebSocket', ThroughputSocketMock as unknown as typeof WebSocket);
    const snapshots: number[] = [];
    const result = await runDownloadSpeedTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      messageSizeKb: 64,
      connectionCount: 1,
      durationMs: 40,
      latencyMs: 1,
      jitterMs: 1,
      snapshotIntervalMs: 10,
      cancellationToken: new CancellationToken(),
      onSnapshot: (snapshot) => snapshots.push(snapshot.bytes),
    });

    expect(result.bytes).toBeGreaterThan(0);
    expect(result.speedMbps).toBeGreaterThan(0);
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it('runs upload throughput and tracks acknowledged bytes', async () => {
    vi.stubGlobal('WebSocket', ThroughputSocketMock as unknown as typeof WebSocket);
    const result = await runUploadSpeedTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      messageSizeKb: 8,
      connectionCount: 1,
      durationMs: 40,
      latencyMs: 1,
      jitterMs: 1,
      snapshotIntervalMs: 10,
      cancellationToken: new CancellationToken(),
    });

    expect(result.bytes).toBeGreaterThan(0);
    expect(result.speedMbps).toBeGreaterThan(0);
  });
});
