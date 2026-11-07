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
    if (payload === 'PING') {
      setTimeout(() => {
        this.onmessage?.({ data: 'PONG' } as MessageEvent);
      }, 0);
      return;
    }

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

/** Streams a 4 KiB frame every 10 ms after START, so a stage keeps moving data past its first second. */
class StreamingDownloadSocketMock extends ThroughputSocketMock {
  private streamTimer: ReturnType<typeof setInterval> | null = null;

  send(payload: string | Uint8Array): void {
    if (typeof payload === 'string' && payload.startsWith('START')) {
      if (this.streamTimer) return;
      this.streamTimer = setInterval(() => {
        if (this.readyState === ThroughputSocketMock.OPEN) {
          this.onmessage?.({ data: new ArrayBuffer(4 * 1024) } as MessageEvent);
        }
      }, 10);
      return;
    }
    super.send(payload);
  }

  close(): void {
    if (this.streamTimer) clearInterval(this.streamTimer);
    super.close();
  }
}

/** Fake clock for stages that last past the 1 s loaded latency delay. */
const FAKE_CLOCK: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
};

class ReplenishingDownloadSocketMock extends ThroughputSocketMock {
  static commands: string[] = [];

  send(payload: string | Uint8Array): void {
    if (payload === 'PING') {
      setTimeout(() => {
        this.onmessage?.({ data: 'PONG' } as MessageEvent);
      }, 0);
      return;
    }

    if (typeof payload !== 'string' || !payload.startsWith('START')) return;

    ReplenishingDownloadSocketMock.commands.push(payload);
    if (ReplenishingDownloadSocketMock.commands.length > 1) return;

    const [, kb, count] = payload.split(' ');
    const frameBytes = Number(kb) * 1024;
    const frameCount = Number(count);

    for (let i = 0; i < frameCount; i++) {
      setTimeout(() => {
        this.onmessage?.({ data: new ArrayBuffer(frameBytes) } as MessageEvent);
      }, 0);
    }
  }
}

class ReentrantExtraFrameDownloadSocketMock extends ThroughputSocketMock {
  static commands: string[] = [];

  send(payload: string | Uint8Array): void {
    if (payload === 'PING') {
      setTimeout(() => {
        this.onmessage?.({ data: 'PONG' } as MessageEvent);
      }, 0);
      return;
    }

    if (typeof payload !== 'string' || !payload.startsWith('START')) return;

    ReentrantExtraFrameDownloadSocketMock.commands.push(payload);

    const [, kb, count] = payload.split(' ');
    const frameBytes = Number(kb) * 1024;
    const frameCount = Number(count);

    if (ReentrantExtraFrameDownloadSocketMock.commands.length === 1) {
      for (let i = 0; i < frameCount; i++) {
        setTimeout(() => {
          this.onmessage?.({ data: new ArrayBuffer(frameBytes) } as MessageEvent);
        }, 0);
      }
      return;
    }

    if (ReentrantExtraFrameDownloadSocketMock.commands.length === 2) {
      this.onmessage?.({ data: new ArrayBuffer(frameBytes) } as MessageEvent);
    }
  }
}

describe('throughput protocol runners', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('runs download throughput and emits snapshots', async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    vi.stubGlobal('WebSocket', StreamingDownloadSocketMock as unknown as typeof WebSocket);
    const snapshots: number[] = [];
    // Longer than the 1 s loaded latency delay, so the stage also measures loaded latency.
    const promise = runDownloadSpeedTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      messageSizeKb: 64,
      connectionCount: 1,
      durationMs: 1500,
      latencyMs: 1,
      jitterMs: 1,
      snapshotIntervalMs: 100,
      cancellationToken: new CancellationToken(),
      onSnapshot: (snapshot) => snapshots.push(snapshot.bytes),
    });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result.bytes).toBeGreaterThan(0);
    expect(result.speedMbps).toBeGreaterThan(0);
    expect(result.overallSpeedMbps).toBeGreaterThan(0);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(result.loadedLatency).not.toBeNull();
    expect(result.loadedLatency!.latencies.length).toBeGreaterThan(0);
    expect(result.loadedLatency!.minLatency).toBeGreaterThan(0);
  });

  it('requests a doubled download packet size after a batch is exhausted', async () => {
    vi.useFakeTimers();
    ReplenishingDownloadSocketMock.commands = [];
    vi.stubGlobal('WebSocket', ReplenishingDownloadSocketMock as unknown as typeof WebSocket);

    const promise = runDownloadSpeedTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      messageSizeKb: 64,
      connectionCount: 1,
      durationMs: 40,
      latencyMs: 1,
      jitterMs: 1,
      snapshotIntervalMs: 10,
      cancellationToken: new CancellationToken(),
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(ReplenishingDownloadSocketMock.commands).toEqual(['START 64 500', 'START 128 500']);

    await vi.advanceTimersByTimeAsync(39);
    const result = await promise;
    expect(result.bytes).toBe(64 * 1024 * 500);
  });

  it('ignores extra download frames that arrive after a batch is exhausted', async () => {
    vi.useFakeTimers();
    ReentrantExtraFrameDownloadSocketMock.commands = [];
    vi.stubGlobal('WebSocket', ReentrantExtraFrameDownloadSocketMock as unknown as typeof WebSocket);

    const promise = runDownloadSpeedTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      messageSizeKb: 64,
      connectionCount: 1,
      durationMs: 40,
      latencyMs: 1,
      jitterMs: 1,
      snapshotIntervalMs: 10,
      cancellationToken: new CancellationToken(),
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(ReentrantExtraFrameDownloadSocketMock.commands).toEqual([
      'START 64 500',
      'START 128 500',
    ]);

    await vi.advanceTimersByTimeAsync(39);
    const result = await promise;
    expect(result.bytes).toBe(64 * 1024 * 500);
  });

  it('completes download when loaded latency monitor receives no PONG samples', async () => {
    const pings: string[] = [];
    class SilentPingThroughputSocketMock extends StreamingDownloadSocketMock {
      send(payload: string | Uint8Array): void {
        if (payload === 'PING') {
          pings.push(payload);
          return;
        }
        super.send(payload);
      }
    }

    vi.useFakeTimers(FAKE_CLOCK);
    vi.stubGlobal('WebSocket', SilentPingThroughputSocketMock as unknown as typeof WebSocket);
    const promise = runDownloadSpeedTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      messageSizeKb: 64,
      connectionCount: 1,
      durationMs: 1500,
      latencyMs: 1,
      jitterMs: 1,
      snapshotIntervalMs: 100,
      cancellationToken: new CancellationToken(),
    });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    // A PING went out after the 1 s delay but was never answered.
    expect(pings).toEqual(['PING']);

    expect(result.bytes).toBeGreaterThan(0);
    expect(result.speedMbps).toBeGreaterThan(0);
    expect(result.loadedLatency).toBeNull();
  });

  it('rejects download when loaded latency WebSocket creation fails', async () => {
    vi.useFakeTimers();
    let socketCount = 0;
    vi.stubGlobal(
      'WebSocket',
      class extends ThroughputSocketMock {
        constructor(url: string) {
          socketCount++;
          if (socketCount > 1) {
            throw new Error('loaded latency ws failed');
          }
          super(url);
        }
      } as unknown as typeof WebSocket
    );

    const promise = runDownloadSpeedTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      messageSizeKb: 64,
      connectionCount: 1,
      durationMs: 5000,
      latencyMs: 1,
      jitterMs: 1,
      snapshotIntervalMs: 10,
      cancellationToken: new CancellationToken(),
    });
    const expectation = expect(promise).rejects.toThrow('Failed to create loaded latency WebSocket');

    await vi.advanceTimersByTimeAsync(1);

    await expectation;
  });

  it('rejects upload when loaded latency WebSocket creation fails', async () => {
    vi.useFakeTimers();
    let socketCount = 0;
    vi.stubGlobal(
      'WebSocket',
      class extends ThroughputSocketMock {
        constructor(url: string) {
          socketCount++;
          if (socketCount > 1) {
            throw new Error('loaded latency ws failed');
          }
          super(url);
        }
      } as unknown as typeof WebSocket
    );

    const promise = runUploadSpeedTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      messageSizeKb: 8,
      connectionCount: 1,
      durationMs: 5000,
      latencyMs: 1,
      jitterMs: 1,
      snapshotIntervalMs: 10,
      cancellationToken: new CancellationToken(),
    });
    const expectation = expect(promise).rejects.toThrow('Failed to create loaded latency WebSocket');

    await vi.advanceTimersByTimeAsync(1);

    await expectation;
  });

  it('runs upload throughput and tracks acknowledged bytes', async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    vi.stubGlobal('WebSocket', ThroughputSocketMock as unknown as typeof WebSocket);
    const promise = runUploadSpeedTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      messageSizeKb: 8,
      connectionCount: 1,
      durationMs: 1500,
      latencyMs: 1,
      jitterMs: 1,
      snapshotIntervalMs: 100,
      cancellationToken: new CancellationToken(),
    });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result.bytes).toBeGreaterThan(0);
    expect(result.speedMbps).toBeGreaterThan(0);
    expect(result.loadedLatency).not.toBeNull();
    expect(result.loadedLatency!.latencies.length).toBeGreaterThan(0);
    expect(result.loadedLatency!.minLatency).toBeGreaterThan(0);
  });
});
