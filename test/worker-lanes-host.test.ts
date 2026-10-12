// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDownloadSpeedTest } from '../src/tests/download-speed-test.js';
import type { ThroughputLaneCallbacks } from '../src/tests/throughput-lanes.js';
import {
  hostWorkerLane,
  openWorkerLanes,
  type HostToWorkerMessage,
  type LanePort,
  type WorkerLaneData,
  type WorkerToHostMessage,
} from '../src/tests/worker-lanes.js';
import { CancellationToken } from '../src/utils/cancellation.js';

/**
 * Stands in for `worker_threads.Worker`. By default it runs the real `hostWorkerLane` in
 * this process, so the host side of `openWorkerLanes` sees genuine worker messages. A test
 * can script a worker instead through `FakeWorker.script`.
 */
class FakeWorker extends EventEmitter {
  static instances: FakeWorker[] = [];
  /** Return true to replace the real lane for this worker. */
  static script: ((worker: FakeWorker) => boolean) | null = null;

  readonly data: WorkerLaneData;
  terminated = false;
  unrefed = false;
  private toWorker: ((message: HostToWorkerMessage) => void) | null = null;

  constructor(_file: URL, options: { workerData: WorkerLaneData }) {
    super();
    this.data = options.workerData;
    FakeWorker.instances.push(this);
    const port: LanePort = {
      postMessage: (message) => setTimeout(() => this.emit('message', message), 0),
      on: (_event, listener) => {
        this.toWorker = listener;
      },
    };
    queueMicrotask(() => {
      if (!FakeWorker.script?.(this)) void hostWorkerLane(port, this.data);
    });
  }

  /** Posts a message as if the worker sent it. */
  post(message: WorkerToHostMessage): void {
    setTimeout(() => this.emit('message', message), 0);
  }

  postMessage(message: HostToWorkerMessage): void {
    setTimeout(() => this.toWorker?.(message), 0);
  }

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }

  unref(): void {
    this.unrefed = true;
  }
}

vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }));
// Enough cores for every requested thread, whatever machine runs the tests.
vi.mock('node:os', () => ({ availableParallelism: () => 16, cpus: () => [] }));

/** Opens immediately, streams one 2 KiB frame per START, answers PING. */
class LaneSocketMock {
  static instances: LaneSocketMock[] = [];
  readyState = 0;
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  sent: Array<string | Uint8Array> = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    LaneSocketMock.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  send(payload: string | Uint8Array): void {
    this.sent.push(payload);
    if (payload === 'PING') setTimeout(() => this.onmessage?.({ data: 'PONG' } as MessageEvent), 0);
    else if (typeof payload === 'string' && payload.startsWith('START')) {
      setTimeout(() => this.onmessage?.({ data: new ArrayBuffer(2048) } as MessageEvent), 0);
    }
  }

  close(): void {
    this.readyState = 3;
  }
}

const SERVER_URL = 'wss://speed.example.com/v1/ws';

function callbacks(): ThroughputLaneCallbacks & { opens: number; errors: Error[] } {
  const result = {
    opens: 0,
    errors: [] as Error[],
    onOpen: () => {
      result.opens++;
    },
    onError: (error: Error) => {
      result.errors.push(error);
    },
  };
  return result;
}

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.script = null;
  LaneSocketMock.instances = [];
  vi.stubGlobal('WebSocket', LaneSocketMock as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openWorkerLanes', () => {
  it('opens a lane per worker, starts them, publishes their bytes, and closes them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const events = callbacks();
      const opening = openWorkerLanes('download', { serverUrl: SERVER_URL, connectionCount: 4, messageSizeKb: 2, threads: 2 }, events);
      await vi.advanceTimersByTimeAsync(5);
      const lanes = await opening;

      expect(lanes).toHaveLength(2);
      expect(FakeWorker.instances.map((worker) => [worker.data.connectionCount, worker.data.firstSocketIndex])).toEqual([
        [2, 0],
        [2, 2],
      ]);
      // Every socket in every lane is open.
      expect(events.opens).toBe(2);

      for (const lane of lanes!) lane.start();
      await vi.advanceTimersByTimeAsync(5);
      expect(LaneSocketMock.instances.map((socket) => socket.sent)).toEqual(Array(4).fill(['START 2 500']));
      // Each lane's two sockets received one 2 KiB frame, read through the shared counters.
      expect(lanes!.map((lane) => lane.bytes)).toEqual([4096, 4096]);

      for (const lane of lanes!) lane.close();
      await vi.advanceTimersByTimeAsync(5);
      expect(LaneSocketMock.instances.every((socket) => socket.readyState === 3)).toBe(true);
      expect(FakeWorker.instances.every((worker) => worker.unrefed && !worker.terminated)).toBe(true);
      // Workers that do not exit on their own are terminated after a grace period.
      await vi.advanceTimersByTimeAsync(2000);
      expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true);
      expect(events.errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects when a socket fails before every worker is ready, instead of falling back', async () => {
    // The second worker reports a connection failure while the first is still starting.
    FakeWorker.script = (worker) => {
      if (worker.data.slot !== 1) return false;
      worker.post({ type: 'error', message: 'Download WebSocket connection 2 failed' });
      return true;
    };
    await expect(
      openWorkerLanes('download', { serverUrl: SERVER_URL, connectionCount: 4, messageSizeKb: 2, threads: 2 }, callbacks())
    ).rejects.toThrow('Download WebSocket connection 2 failed');
    expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true);
  });

  it('fails the stage rather than retrying on the calling thread', async () => {
    FakeWorker.script = (worker) => {
      if (worker.data.slot !== 1) return false;
      worker.post({ type: 'error', message: 'Download WebSocket connection 6 failed' });
      return true;
    };
    await expect(
      runDownloadSpeedTest({
        serverUrl: SERVER_URL,
        messageSizeKb: 2,
        connectionCount: 12,
        durationMs: 50,
        latencyMs: 1,
        jitterMs: 1,
        threads: 2,
        cancellationToken: new CancellationToken(),
      })
    ).rejects.toThrow('Download WebSocket connection 6 failed');
    // Six sockets from the first worker plus the loaded latency socket; no second set of
    // twelve on the calling thread.
    expect(LaneSocketMock.instances.length).toBeLessThanOrEqual(7);
  });

  it('reports a socket failure after the lanes were handed over through onError', async () => {
    const events = callbacks();
    const lanes = await openWorkerLanes('download', { serverUrl: SERVER_URL, connectionCount: 4, messageSizeKb: 2, threads: 2 }, events);
    expect(lanes).toHaveLength(2);
    FakeWorker.instances[0].post({ type: 'error', message: 'late failure' });
    await expect.poll(() => events.errors.map((error) => error.message)).toEqual(['late failure']);
    for (const lane of lanes!) lane.close();
  });

  it('falls back when a worker cannot use the same WebSocket', async () => {
    FakeWorker.script = (worker) => {
      worker.post({ type: 'unsupported' });
      return true;
    };
    expect(
      await openWorkerLanes('download', { serverUrl: SERVER_URL, connectionCount: 4, messageSizeKb: 2, threads: 2 }, callbacks())
    ).toBeNull();
    expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true);
  });

  it('falls back when a worker fails or exits before it is ready', async () => {
    FakeWorker.script = (worker) => {
      if (worker.data.slot === 0) setTimeout(() => worker.emit('error', new Error('module not found')), 0);
      return true;
    };
    expect(
      await openWorkerLanes('download', { serverUrl: SERVER_URL, connectionCount: 4, messageSizeKb: 2, threads: 2 }, callbacks())
    ).toBeNull();

    FakeWorker.instances = [];
    FakeWorker.script = (worker) => {
      if (worker.data.slot === 1) setTimeout(() => worker.emit('exit', 1), 0);
      return worker.data.slot === 1;
    };
    expect(
      await openWorkerLanes('download', { serverUrl: SERVER_URL, connectionCount: 4, messageSizeKb: 2, threads: 2 }, callbacks())
    ).toBeNull();
  });
});
