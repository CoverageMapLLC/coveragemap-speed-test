import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDownloadSpeedTest } from '../src/tests/download-speed-test.js';
import {
  getWebSocketSource,
  hostWorkerLane,
  openWorkerLanes,
  splitConnections,
  type HostToWorkerMessage,
  type WorkerToHostMessage,
} from '../src/tests/worker-lanes.js';
import { isNodeRuntime } from '../src/tests/sockets.js';
import { getThroughputThreadCount } from '../src/types/speed-test.js';
import { CancellationToken } from '../src/utils/cancellation.js';

class LaneSocketMock {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: LaneSocketMock[] = [];

  readyState = LaneSocketMock.CONNECTING;
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  sent: Array<string | Uint8Array> = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(_url: string) {
    LaneSocketMock.instances.push(this);
    setTimeout(() => {
      this.readyState = LaneSocketMock.OPEN;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  send(payload: string | Uint8Array): void {
    this.sent.push(payload);
    if (payload === 'PING') {
      setTimeout(() => this.onmessage?.({ data: 'PONG' } as MessageEvent), 0);
      return;
    }
    if (typeof payload === 'string' && payload.startsWith('START')) {
      setTimeout(() => this.onmessage?.({ data: new ArrayBuffer(2048) } as MessageEvent), 0);
    }
  }

  close(): void {
    this.readyState = LaneSocketMock.CLOSED;
  }
}

function createPort() {
  const posted: WorkerToHostMessage[] = [];
  let listener: ((message: HostToWorkerMessage) => void) | null = null;
  return {
    posted,
    port: {
      postMessage: (message: WorkerToHostMessage) => posted.push(message),
      on: (_event: 'message', fn: (message: HostToWorkerMessage) => void) => {
        listener = fn;
      },
    },
    send: (message: HostToWorkerMessage) => listener?.(message),
  };
}

describe('throughput threads', () => {
  afterEach(() => {
    LaneSocketMock.instances = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('splits connections across threads as evenly as possible', () => {
    expect(splitConnections(10, 4)).toEqual([3, 3, 2, 2]);
    expect(splitConnections(8, 4)).toEqual([2, 2, 2, 2]);
    expect(splitConnections(2, 4)).toEqual([1, 1]);
    expect(splitConnections(5, 1)).toEqual([5]);
  });

  it('uses one thread below 1 Gbps and six above', () => {
    expect(getThroughputThreadCount(0.1)).toBe(1);
    expect(getThroughputThreadCount(999)).toBe(1);
    expect(getThroughputThreadCount(1000)).toBe(6);
    expect(getThroughputThreadCount(25000)).toBe(6);
  });

  it('uses the configured thread count for multi-gigabit stages', () => {
    expect(getThroughputThreadCount(25000, 1)).toBe(1);
    expect(getThroughputThreadCount(25000, 2)).toBe(2);
    expect(getThroughputThreadCount(25000, 16)).toBe(16);
    expect(getThroughputThreadCount(500, 16)).toBe(1);
  });

  it('does not treat a DOM environment as Node.js', () => {
    expect(isNodeRuntime()).toBe(false);
  });

  it('resolves null outside Node.js so the caller falls back to the calling thread', async () => {
    vi.stubGlobal('WebSocket', LaneSocketMock as unknown as typeof WebSocket);
    const lanes = await openWorkerLanes(
      'download',
      { serverUrl: 'wss://speed.example.com/v1/ws', connectionCount: 4, messageSizeKb: 2, threads: 4 },
      { onOpen: () => {}, onError: () => {} }
    );
    expect(lanes).toBeNull();
  });

  it('runs a multi-thread download on the calling thread when workers are unavailable', async () => {
    vi.stubGlobal('WebSocket', LaneSocketMock as unknown as typeof WebSocket);
    const result = await runDownloadSpeedTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      messageSizeKb: 2,
      connectionCount: 4,
      durationMs: 40,
      latencyMs: 1,
      jitterMs: 1,
      snapshotIntervalMs: 10,
      threads: 4,
      cancellationToken: new CancellationToken(),
    });

    expect(result.bytes).toBe(4 * 2048);
    // 4 throughput sockets plus the loaded latency socket
    expect(LaneSocketMock.instances).toHaveLength(5);
  });

  it('reports unsupported when the worker WebSocket differs from the calling thread', () => {
    vi.stubGlobal('WebSocket', LaneSocketMock as unknown as typeof WebSocket);
    const { port, posted } = createPort();
    hostWorkerLane(port, {
      direction: 'download',
      serverUrl: 'wss://speed.example.com/v1/ws',
      connectionCount: 1,
      messageSizeKb: 2,
      counters: new SharedArrayBuffer(8),
      slot: 0,
      webSocketSource: 'class SomeOtherWebSocket {}',
    });

    expect(posted).toEqual([{ type: 'unsupported' }]);
    expect(LaneSocketMock.instances).toHaveLength(0);
  });

  it('hosts a lane that opens, starts on request, and publishes bytes to the shared counter', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', LaneSocketMock as unknown as typeof WebSocket);
    const counters = new SharedArrayBuffer(16);
    const { port, posted, send } = createPort();

    hostWorkerLane(port, {
      direction: 'download',
      serverUrl: 'wss://speed.example.com/v1/ws',
      connectionCount: 2,
      messageSizeKb: 2,
      counters,
      slot: 1,
      webSocketSource: getWebSocketSource() as string,
    });

    expect(posted).toEqual([{ type: 'ready' }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(posted).toEqual([{ type: 'ready' }, { type: 'open' }]);

    send({ type: 'start' });
    expect(LaneSocketMock.instances.map((socket) => socket.sent)).toEqual([
      ['START 2 500'],
      ['START 2 500'],
    ]);

    await vi.advanceTimersByTimeAsync(1);
    expect(Atomics.load(new BigInt64Array(counters), 1)).toBe(4096n);
    expect(Atomics.load(new BigInt64Array(counters), 0)).toBe(0n);

    send({ type: 'close' });
    expect(LaneSocketMock.instances.every((socket) => socket.readyState === LaneSocketMock.CLOSED)).toBe(true);
  });

  it('rejects when a socket fails before the lane opens instead of waiting forever', async () => {
    class FailingSocketMock extends LaneSocketMock {
      constructor(url: string) {
        super(url);
        if (LaneSocketMock.instances.length === 2) {
          setTimeout(() => this.onerror?.(new Event('error')), 0);
        }
      }
    }
    vi.stubGlobal('WebSocket', FailingSocketMock as unknown as typeof WebSocket);

    await expect(
      runDownloadSpeedTest({
        serverUrl: 'wss://speed.example.com/v1/ws',
        messageSizeKb: 2,
        connectionCount: 3,
        durationMs: 40,
        latencyMs: 1,
        jitterMs: 1,
        cancellationToken: new CancellationToken(),
      })
    ).rejects.toThrow('Download WebSocket connection 1 failed');
  });
});
