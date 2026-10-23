import type { LatencyTestData, SpeedEstimationResult, SpeedSnapshot, SpeedTestData } from '../types/speed-test.js';
import { CancellationError, type CancellationToken } from '../utils/cancellation.js';
import { isNodeRuntime } from '../tests/sockets.js';
import { getWebSocketSource } from '../tests/worker-lanes.js';
import { deserializeError, type StageCommand, type StageEvent, type StageRequest } from './stage-protocol.js';
import { localStageRunner, type StageRunner } from './stage-runner.js';
import { STAGE_WORKER_SOURCE } from './stage-worker-source.generated.js';

/**
 * Runs the test stages in a dedicated Web Worker in browsers. On the page's main thread,
 * rendering and other application work delays socket events and timers, which lowers the
 * measured speeds and inflates latency. A worker has its own thread, so the page cannot
 * get in the way.
 *
 * The worker script is embedded in the library and started from a `blob:` URL, so it works
 * with every bundler and needs no setup. When a worker cannot start (a Content Security
 * Policy without `worker-src blob:`, a runtime without `Worker`, a worker without
 * `WebSocket`), or the page replaced `WebSocket` with its own implementation, the stages
 * run on the calling thread as before.
 */

/** How long a new worker may take to report that it is ready. */
export const STAGE_WORKER_READY_TIMEOUT_MS = 3000;

/** The parts of a `Worker` the engine uses. */
export interface StageWorkerHandle {
  postMessage(message: StageCommand): void;
  addEventListener(type: 'message', listener: (event: { data: StageEvent }) => void): void;
  addEventListener(type: 'error', listener: (event: { message?: string }) => void): void;
  terminate(): void;
}

export type StageWorkerFactory = () => StageWorkerHandle;

export interface StartStageWorkerOptions {
  createWorker?: StageWorkerFactory;
  readyTimeoutMs?: number;
}

/** True where a worker can be started from a `blob:` URL: browsers, not Node.js. */
export function canUseStageWorker(): boolean {
  return (
    !isNodeRuntime() &&
    typeof Worker === 'function' &&
    typeof Blob === 'function' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  );
}

/** Starts the embedded worker script from a `blob:` URL. */
export function createBlobStageWorker(): StageWorkerHandle {
  const url = URL.createObjectURL(new Blob([STAGE_WORKER_SOURCE], { type: 'text/javascript' }));
  let worker: Worker;
  try {
    worker = new Worker(url, { name: 'coveragemap-speed-test' });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  // Revoked once the worker is gone: some browsers fetch the script after the constructor returns.
  const terminate = worker.terminate.bind(worker);
  return {
    postMessage: (message) => worker.postMessage(message),
    addEventListener: (type: 'message' | 'error', listener: (event: never) => void) =>
      worker.addEventListener(type, listener as EventListener),
    terminate() {
      terminate();
      URL.revokeObjectURL(url);
    },
  };
}

/**
 * The stage runner for a test run: a worker in browsers unless `useWorker` is false, and
 * the calling thread everywhere else or when the worker cannot start.
 */
export async function createStageRunner(
  useWorker: boolean,
  options: StartStageWorkerOptions = {}
): Promise<StageRunner> {
  if (!useWorker || (!options.createWorker && !canUseStageWorker())) return localStageRunner;
  return (await startStageWorker(options)) ?? localStageRunner;
}

interface PendingStage {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onPing?: (latencyMs: number, index: number) => void;
  onSnapshot?: (snapshot: SpeedSnapshot) => void;
}

/**
 * Starts a stage worker and waits until it is ready. Resolves null when it cannot start, does
 * not answer within `readyTimeoutMs`, or would use a different `WebSocket` than the page.
 */
export function startStageWorker(options: StartStageWorkerOptions = {}): Promise<StageRunner | null> {
  const { createWorker = createBlobStageWorker, readyTimeoutMs = STAGE_WORKER_READY_TIMEOUT_MS } = options;

  let worker: StageWorkerHandle;
  try {
    worker = createWorker();
  } catch {
    return Promise.resolve(null);
  }

  return new Promise<StageRunner | null>((resolveStart) => {
    let state: 'starting' | 'ready' | 'failed' | 'closed' = 'starting';
    let nextId = 1;
    const pending = new Map<number, PendingStage>();

    const giveUp = () => {
      if (state !== 'starting') return;
      state = 'failed';
      clearTimeout(readyTimer);
      worker.terminate();
      resolveStart(null);
    };
    const readyTimer = setTimeout(giveUp, readyTimeoutMs);

    /** The worker died after it was ready: stages in flight fail, later ones run locally. */
    const fail = (message: string) => {
      if (state !== 'ready') return giveUp();
      state = 'failed';
      worker.terminate();
      const error = new Error(`The speed test worker failed: ${message}`);
      for (const stage of pending.values()) stage.reject(error);
      pending.clear();
    };

    worker.addEventListener('error', (event: { message?: string }) => fail(event.message || 'unknown error'));
    worker.addEventListener('message', (event: { data: StageEvent }) => {
      const message = event.data;
      switch (message.type) {
        case 'ready':
          if (state !== 'starting') return;
          // A page that installed its own WebSocket keeps it: the worker would use the browser's.
          if (message.webSocketSource !== getWebSocketSource()) return giveUp();
          state = 'ready';
          clearTimeout(readyTimer);
          resolveStart(runner);
          return;
        case 'unsupported':
          return giveUp();
        case 'ping':
          pending.get(message.id)?.onPing?.(message.latencyMs, message.index);
          return;
        case 'snapshot':
          pending.get(message.id)?.onSnapshot?.(message.snapshot);
          return;
        case 'result': {
          const stage = pending.get(message.id);
          pending.delete(message.id);
          stage?.resolve(message.value);
          return;
        }
        case 'error': {
          const stage = pending.get(message.id);
          pending.delete(message.id);
          stage?.reject(deserializeError(message.error));
          return;
        }
      }
    });

    const call = <T>(
      request: StageRequest,
      cancellationToken: CancellationToken,
      handlers: Pick<PendingStage, 'onPing' | 'onSnapshot'>,
      runLocally: () => Promise<T>
    ): Promise<T> => {
      if (state !== 'ready') return runLocally();
      if (cancellationToken.isCancelled) return Promise.reject(new CancellationError());
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, ...handlers });
        cancellationToken.onCancel(() => {
          if (!pending.delete(id)) return;
          if (state === 'ready') worker.postMessage({ type: 'cancel', id });
          reject(new CancellationError());
        });
        worker.postMessage({ type: 'run', id, ...request } as StageCommand);
      });
    };

    const runner: StageRunner = {
      mode: 'worker',
      runLatencyTest: ({ cancellationToken, onPing, ...options }) =>
        call<LatencyTestData>({ stage: 'latency', options }, cancellationToken, { onPing }, () =>
          localStageRunner.runLatencyTest({ ...options, cancellationToken, onPing })
        ),
      runDownloadEstimationTest: ({ cancellationToken, ...options }) =>
        call<SpeedEstimationResult>({ stage: 'downloadEstimation', options }, cancellationToken, {}, () =>
          localStageRunner.runDownloadEstimationTest({ ...options, cancellationToken })
        ),
      runUploadEstimationTest: ({ cancellationToken, ...options }) =>
        call<SpeedEstimationResult>({ stage: 'uploadEstimation', options }, cancellationToken, {}, () =>
          localStageRunner.runUploadEstimationTest({ ...options, cancellationToken })
        ),
      runDownloadSpeedTest: ({ cancellationToken, onSnapshot, ...options }) =>
        call<SpeedTestData>({ stage: 'download', options }, cancellationToken, { onSnapshot }, () =>
          localStageRunner.runDownloadSpeedTest({ ...options, cancellationToken, onSnapshot })
        ),
      runUploadSpeedTest: ({ cancellationToken, onSnapshot, ...options }) =>
        call<SpeedTestData>({ stage: 'upload', options }, cancellationToken, { onSnapshot }, () =>
          localStageRunner.runUploadSpeedTest({ ...options, cancellationToken, onSnapshot })
        ),
      close() {
        if (state === 'closed') return;
        const wasReady = state === 'ready';
        state = 'closed';
        if (wasReady) worker.terminate();
        const error = new CancellationError();
        for (const stage of pending.values()) stage.reject(error);
        pending.clear();
      },
    };
  });
}
