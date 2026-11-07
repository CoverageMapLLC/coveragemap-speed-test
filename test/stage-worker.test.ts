// @vitest-environment node
import { createSpeedTestServer, type SpeedTransportServer } from '@coveragemap/speed-transport';
import net, { type AddressInfo } from 'node:net';
import vm from 'node:vm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  deserializeError,
  serializeError,
  type StageCommand,
  type StageEvent,
} from '../src/browser/stage-protocol.js';
import { localStageRunner, type StageRunner } from '../src/browser/stage-runner.js';
import { serveStages, type StagePort } from '../src/browser/stage-worker.js';
import {
  createStageRunner,
  startStageWorker,
  type StageWorkerHandle,
} from '../src/browser/stage-worker-client.js';
import { STAGE_WORKER_SOURCE } from '../src/browser/stage-worker-source.generated.js';
import { SocketConnectError } from '../src/tests/sockets.js';
import type { LatencyTestData, SpeedEstimationResult, SpeedSnapshot, SpeedTestData } from '../src/types/speed-test.js';
import { CancellationError, CancellationToken } from '../src/utils/cancellation.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  // Node.js 20 has no global WebSocket; the library expects one in browsers and workers.
  if (typeof WebSocket === 'undefined') {
    const { WebSocket: WsWebSocket } = await import('ws');
    (globalThis as { WebSocket?: unknown }).WebSocket = WsWebSocket;
  }
});

/** The stage an event belongs to, if any. */
const idOf = (event: StageEvent): number | undefined => ('id' in event ? event.id : undefined);

/** A local speed test server speaking the real protocol over plain WebSocket. */
async function startServer(): Promise<string> {
  const server: SpeedTransportServer = createSpeedTestServer({ websocket: { path: '/v1/ws' } });
  await server.listen(0, '127.0.0.1');
  cleanups.push(() => server.close());
  return `ws://127.0.0.1:${server.address()!.port}/v1/ws`;
}

/** A URL nothing listens on. */
async function closedUrl(): Promise<string> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `ws://127.0.0.1:${port}/v1/ws`;
}

/** Collects every event a stage worker posts on one end of a MessageChannel. */
function servedChannel() {
  const { port1, port2 } = new MessageChannel();
  const events: StageEvent[] = [];
  const waiters: Array<() => void> = [];
  port1.addEventListener('message', (event) => {
    events.push(event.data as StageEvent);
    for (const waiter of waiters.splice(0)) waiter();
  });
  port1.start();
  cleanups.push(() => {
    port1.close();
    port2.close();
  });
  serveStages(port2 as unknown as StagePort);
  const send = (command: StageCommand) => port1.postMessage(command);
  const until = async (predicate: (event: StageEvent) => boolean, timeoutMs = 15000): Promise<StageEvent> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error('timed out waiting for a stage event');
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };
  return { events, send, until };
}

/**
 * A stand-in for a browser `Worker`: the real `serveStages` behind a MessageChannel in this
 * process. `script` replaces it to simulate workers that misbehave.
 */
function channelWorker(script?: (port: { post(event: StageEvent): void; commands: StageCommand[] }) => void) {
  const { port1, port2 } = new MessageChannel();
  const errorListeners: Array<(event: { message?: string }) => void> = [];
  const commands: StageCommand[] = [];
  let terminated = false;
  const handle: StageWorkerHandle & { terminated: () => boolean; fail(message: string): void; commands: StageCommand[] } = {
    postMessage(message) {
      commands.push(message);
      if (!terminated) port1.postMessage(message);
    },
    addEventListener(type: 'message' | 'error', listener: (event: never) => void) {
      if (type === 'message') port1.addEventListener('message', listener as never);
      else errorListeners.push(listener as (event: { message?: string }) => void);
    },
    terminate() {
      terminated = true;
      port1.close();
      port2.close();
    },
    terminated: () => terminated,
    fail(message: string) {
      for (const listener of errorListeners) listener({ message });
    },
    commands,
  };
  port1.start();
  cleanups.push(() => handle.terminate());
  if (script) {
    port2.start();
    script({ post: (event) => port2.postMessage(event), commands });
  } else {
    serveStages(port2 as unknown as StagePort);
  }
  return handle;
}

async function startedRunner(worker = channelWorker()): Promise<StageRunner> {
  const runner = await startStageWorker({ createWorker: () => worker });
  expect(runner).not.toBeNull();
  cleanups.push(() => runner!.close());
  return runner!;
}

describe('stage protocol errors', () => {
  it('round trips the error types the engine tells apart', () => {
    expect(deserializeError(serializeError(new CancellationError()))).toBeInstanceOf(CancellationError);
    const connect = deserializeError(serializeError(new SocketConnectError('refused')));
    expect(connect).toBeInstanceOf(SocketConnectError);
    expect(connect.message).toBe('refused');
    const other = deserializeError(serializeError(new TypeError('bad')));
    expect(other).toBeInstanceOf(Error);
    expect(other.name).toBe('TypeError');
    expect(other.message).toBe('bad');
    expect(serializeError('text')).toEqual({ name: 'Error', message: 'text' });
  });
});

describe('serveStages (worker side)', () => {
  it('reports ready with the WebSocket it will use', async () => {
    const { until } = servedChannel();
    const ready = await until((event) => event.type === 'ready');
    expect(ready).toEqual({ type: 'ready', webSocketSource: Function.prototype.toString.call(WebSocket) });
  });

  it('reports unsupported where workers have no WebSocket', () => {
    vi.stubGlobal('WebSocket', undefined);
    const posted: StageEvent[] = [];
    serveStages({ postMessage: (event) => posted.push(event), addEventListener: () => {} });
    expect(posted).toEqual([{ type: 'unsupported', reason: 'WebSocket is not available in workers' }]);
  });

  it('runs the latency stage and reports every ping', async () => {
    const serverUrl = await startServer();
    const { send, until, events } = servedChannel();
    send({ type: 'run', id: 1, stage: 'latency', options: { serverUrl, pingCount: 5 } });
    const result = await until((event) => event.type === 'result' && idOf(event) === 1);
    const latency = (result as { value: LatencyTestData }).value;
    expect(latency.latencies).toHaveLength(5);
    const pings = events.filter((event) => event.type === 'ping' && idOf(event) === 1);
    expect(pings.map((ping) => (ping as { index: number }).index)).toEqual([0, 1, 2, 3, 4]);
  });

  it.each(['downloadEstimation', 'uploadEstimation'] as const)('runs the %s stage', async (stage) => {
    const serverUrl = await startServer();
    const { send, until } = servedChannel();
    send({ type: 'run', id: 7, stage, options: { serverUrl, latencyMs: 0, jitterMs: 0 } });
    const result = await until((event) => idOf(event) === 7 && (event.type === 'result' || event.type === 'error'));
    expect(result.type).toBe('result');
    const estimate = (result as { value: SpeedEstimationResult }).value;
    expect(estimate.bytes).toBeGreaterThan(0);
    expect(estimate.speedMbps).toBeGreaterThan(0);
  });

  it.each(['download', 'upload'] as const)('runs the %s stage and streams its snapshots', async (stage) => {
    const serverUrl = await startServer();
    const { send, until, events } = servedChannel();
    send({
      type: 'run',
      id: 3,
      stage,
      options: { serverUrl, messageSizeKb: 64, connectionCount: 2, durationMs: 600, latencyMs: 0, jitterMs: 0, snapshotIntervalMs: 100 },
    });
    const result = await until((event) => idOf(event) === 3 && (event.type === 'result' || event.type === 'error'));
    expect(result.type).toBe('result');
    const data = (result as { value: SpeedTestData }).value;
    expect(data.bytes).toBeGreaterThan(0);
    const snapshots = events.filter((event) => event.type === 'snapshot' && idOf(event) === 3);
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
    expect(data.snapshots).toHaveLength(snapshots.length);
  });

  it('cancels a running stage', async () => {
    const serverUrl = await startServer();
    const { send, until } = servedChannel();
    send({
      type: 'run',
      id: 4,
      stage: 'download',
      options: { serverUrl, messageSizeKb: 64, connectionCount: 2, durationMs: 10000, latencyMs: 0, jitterMs: 0 },
    });
    await until((event) => event.type === 'snapshot' && idOf(event) === 4);
    send({ type: 'cancel', id: 4 });
    const result = await until((event) => idOf(event) === 4 && (event.type === 'error' || event.type === 'result'), 3000);
    expect(result).toMatchObject({ type: 'error', error: { name: 'CancellationError' } });
  });

  it('ignores cancel messages for stages that are not running', async () => {
    const { send, until, events } = servedChannel();
    await until((event) => event.type === 'ready');
    send({ type: 'cancel', id: 99 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toHaveLength(1);
  });

  it('reports a server that cannot be reached as a connection error', async () => {
    const serverUrl = await closedUrl();
    const { send, until } = servedChannel();
    send({ type: 'run', id: 5, stage: 'latency', options: { serverUrl, pingCount: 5, timeoutMs: 3000 } });
    const result = await until((event) => idOf(event) === 5 && event.type === 'error');
    expect(result).toMatchObject({ error: { name: 'SocketConnectError' } });
  });

  it('reports an unknown stage as an error', async () => {
    const { send, until } = servedChannel();
    send({ type: 'run', id: 6, stage: 'teleport', options: {} } as unknown as StageCommand);
    const result = await until((event) => idOf(event) === 6);
    expect(result).toMatchObject({ type: 'error', error: { message: 'Unknown stage: teleport' } });
  });

  it('runs stages side by side', async () => {
    const serverUrl = await startServer();
    const { send, until } = servedChannel();
    send({ type: 'run', id: 10, stage: 'latency', options: { serverUrl, pingCount: 5 } });
    send({ type: 'run', id: 11, stage: 'latency', options: { serverUrl, pingCount: 6 } });
    const [first, second] = await Promise.all([
      until((event) => event.type === 'result' && idOf(event) === 10),
      until((event) => event.type === 'result' && idOf(event) === 11),
    ]);
    expect((first as { value: LatencyTestData }).value.latencies).toHaveLength(5);
    expect((second as { value: LatencyTestData }).value.latencies).toHaveLength(6);
  });
});

describe('startStageWorker (engine side)', () => {
  it('runs every stage in the worker with the same results as the calling thread', async () => {
    const serverUrl = await startServer();
    const runner = await startedRunner();
    expect(runner.mode).toBe('worker');
    const local = vi.spyOn(localStageRunner, 'runLatencyTest');
    const cancellationToken = new CancellationToken();

    const pings: number[] = [];
    const latency = await runner.runLatencyTest({
      serverUrl,
      pingCount: 5,
      cancellationToken,
      onPing: (_latencyMs, index) => pings.push(index),
    });
    expect(latency.latencies).toHaveLength(5);
    expect(pings).toEqual([0, 1, 2, 3, 4]);
    // The stand-in worker shares this process, so its call is the only one: the engine side
    // sent the stage to the worker instead of also running it.
    expect(local).toHaveBeenCalledTimes(1);

    const download = await runner.runDownloadEstimationTest({ serverUrl, latencyMs: 0, jitterMs: 0, cancellationToken });
    const upload = await runner.runUploadEstimationTest({ serverUrl, latencyMs: 0, jitterMs: 0, cancellationToken });
    expect(download.speedMbps).toBeGreaterThan(0);
    expect(upload.speedMbps).toBeGreaterThan(0);

    for (const stage of ['runDownloadSpeedTest', 'runUploadSpeedTest'] as const) {
      const snapshots: SpeedSnapshot[] = [];
      const data = await runner[stage]({
        serverUrl,
        messageSizeKb: 64,
        connectionCount: 2,
        durationMs: 600,
        latencyMs: 0,
        jitterMs: 0,
        snapshotIntervalMs: 100,
        cancellationToken,
        onSnapshot: (snapshot) => snapshots.push(snapshot),
      });
      expect(data.bytes).toBeGreaterThan(0);
      expect(snapshots.length).toBeGreaterThanOrEqual(3);
      expect(data.snapshots).toEqual(snapshots);
    }
  });

  it('cancels a stage in the worker and rejects at once', async () => {
    const serverUrl = await startServer();
    const worker = channelWorker();
    const runner = await startedRunner(worker);
    const cancellationToken = new CancellationToken();
    let snapshots = 0;
    const stage = runner.runDownloadSpeedTest({
      serverUrl,
      messageSizeKb: 64,
      connectionCount: 2,
      durationMs: 10000,
      latencyMs: 0,
      jitterMs: 0,
      cancellationToken,
      onSnapshot: () => {
        snapshots++;
        if (snapshots === 2) cancellationToken.cancel();
      },
    });
    const started = Date.now();
    await expect(stage).rejects.toBeInstanceOf(CancellationError);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(worker.commands).toContainEqual({ type: 'cancel', id: 1 });
  });

  it('rejects stages whose token was cancelled before they started', async () => {
    const worker = channelWorker();
    const runner = await startedRunner(worker);
    const cancellationToken = new CancellationToken();
    cancellationToken.cancel();
    await expect(
      runner.runLatencyTest({ serverUrl: 'ws://unused', pingCount: 5, cancellationToken })
    ).rejects.toBeInstanceOf(CancellationError);
    expect(worker.commands).toEqual([]);
  });

  it('passes connection errors through as SocketConnectError', async () => {
    const serverUrl = await closedUrl();
    const runner = await startedRunner();
    await expect(
      runner.runLatencyTest({ serverUrl, pingCount: 5, timeoutMs: 3000, cancellationToken: new CancellationToken() })
    ).rejects.toBeInstanceOf(SocketConnectError);
  });

  it('resolves null when the worker cannot be created', async () => {
    const runner = await startStageWorker({
      createWorker: () => {
        throw new Error('blocked by Content Security Policy');
      },
    });
    expect(runner).toBeNull();
  });

  it('resolves null and terminates a worker that reports unsupported', async () => {
    const worker = channelWorker(({ post }) => post({ type: 'unsupported', reason: 'no WebSocket' }));
    expect(await startStageWorker({ createWorker: () => worker })).toBeNull();
    expect(worker.terminated()).toBe(true);
  });

  it('resolves null and terminates a worker that never becomes ready', async () => {
    const worker = channelWorker(() => {});
    const started = Date.now();
    expect(await startStageWorker({ createWorker: () => worker, readyTimeoutMs: 100 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(worker.terminated()).toBe(true);
  });

  it('resolves null when the worker fails to load', async () => {
    const worker = channelWorker(() => {});
    const starting = startStageWorker({ createWorker: () => worker });
    worker.fail('Refused to create a worker from blob:');
    expect(await starting).toBeNull();
    expect(worker.terminated()).toBe(true);
  });

  it('resolves null when the page uses a different WebSocket than the worker', async () => {
    const worker = channelWorker(({ post }) => post({ type: 'ready', webSocketSource: 'function WebSocket() { [native code] }' }));
    vi.stubGlobal('WebSocket', class PolyfilledWebSocket {});
    expect(await startStageWorker({ createWorker: () => worker })).toBeNull();
    expect(worker.terminated()).toBe(true);
  });

  it('fails the stage in flight when the worker dies, then runs later stages on the calling thread', async () => {
    const serverUrl = await startServer();
    const worker = channelWorker();
    const runner = await startedRunner(worker);
    const cancellationToken = new CancellationToken();
    const inFlight = runner.runDownloadSpeedTest({
      serverUrl,
      messageSizeKb: 64,
      connectionCount: 2,
      durationMs: 5000,
      latencyMs: 0,
      jitterMs: 0,
      cancellationToken,
      onSnapshot: () => worker.fail('out of memory'),
    });
    await expect(inFlight).rejects.toThrow('The speed test worker failed: out of memory');
    expect(worker.terminated()).toBe(true);

    const local = vi.spyOn(localStageRunner, 'runLatencyTest');
    const latency = await runner.runLatencyTest({ serverUrl, pingCount: 5, cancellationToken });
    expect(latency.latencies).toHaveLength(5);
    expect(local).toHaveBeenCalledTimes(1);
  });

  it('terminates the worker on close and rejects stages still running', async () => {
    const serverUrl = await startServer();
    const worker = channelWorker();
    const runner = await startedRunner(worker);
    const stage = runner.runDownloadSpeedTest({
      serverUrl,
      messageSizeKb: 64,
      connectionCount: 2,
      durationMs: 10000,
      latencyMs: 0,
      jitterMs: 0,
      cancellationToken: new CancellationToken(),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    runner.close();
    await expect(stage).rejects.toBeInstanceOf(CancellationError);
    expect(worker.terminated()).toBe(true);
    runner.close();
  });

  it('ignores events for stages it does not know', async () => {
    const worker = channelWorker(({ post }) => {
      post({ type: 'ready', webSocketSource: Function.prototype.toString.call(WebSocket) });
      post({ type: 'result', id: 42, value: { durationMs: 1, bytes: 1, speedMbps: 1 } });
      post({ type: 'snapshot', id: 42, snapshot: { timeOffsetMs: 1, speedMbps: 1, bytes: 1 } });
      post({ type: 'error', id: 42, error: { name: 'Error', message: 'x' } });
    });
    const runner = await startedRunner(worker);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runner.mode).toBe('worker');
  });
});

describe('createStageRunner', () => {
  it('uses the calling thread when the worker is turned off', async () => {
    const createWorker = vi.fn(() => channelWorker());
    expect(await createStageRunner(false, { createWorker })).toBe(localStageRunner);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('uses the calling thread in Node.js', async () => {
    expect(await createStageRunner(true)).toBe(localStageRunner);
  });

  it('uses a worker when one starts', async () => {
    const runner = await createStageRunner(true, { createWorker: () => channelWorker() });
    cleanups.push(() => runner.close());
    expect(runner.mode).toBe('worker');
  });

  it('falls back to the calling thread when the worker cannot start', async () => {
    const runner = await createStageRunner(true, {
      createWorker: () => {
        throw new Error('no workers here');
      },
    });
    expect(runner).toBe(localStageRunner);
  });
});

describe('embedded worker script', () => {
  it('is one self-contained script', () => {
    expect(STAGE_WORKER_SOURCE.length).toBeGreaterThan(1000);
    expect(STAGE_WORKER_SOURCE).not.toMatch(/^\s*import\s/m);
    expect(STAGE_WORKER_SOURCE).not.toMatch(/\brequire\(/);
  });

  it('runs on its own in a worker-like global scope and serves stages', async () => {
    const serverUrl = await startServer();
    const posted: StageEvent[] = [];
    const listeners: Array<(event: { data: StageCommand }) => void> = [];
    // Only what a dedicated worker offers: no imports, no Node.js globals.
    const scope = {
      postMessage: (event: StageEvent) => posted.push(event),
      addEventListener: (_type: string, listener: (event: { data: StageCommand }) => void) => listeners.push(listener),
      WebSocket,
      performance,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      queueMicrotask,
      AbortController,
      Event,
      EventTarget,
      URL,
      Uint8Array,
      ArrayBuffer,
      TextEncoder,
      TextDecoder,
      console,
    };
    const context = vm.createContext({ ...scope });
    (context as { self: unknown }).self = context;
    vm.runInContext(STAGE_WORKER_SOURCE, context);

    expect(posted[0]).toMatchObject({ type: 'ready' });
    for (const listener of listeners) {
      listener({ data: { type: 'run', id: 1, stage: 'latency', options: { serverUrl, pingCount: 5 } } });
    }
    const deadline = Date.now() + 10000;
    while (!posted.some((event) => event.type === 'result' || event.type === 'error') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const result = posted.find((event) => event.type === 'result' || event.type === 'error');
    expect(result?.type).toBe('result');
    expect((result as { value: LatencyTestData }).value.latencies).toHaveLength(5);
    expect(posted.filter((event) => event.type === 'ping')).toHaveLength(5);
  });
});
