import {
  openThroughputLane,
  type ThroughputDirection,
  type ThroughputLane,
  type ThroughputLaneCallbacks,
  type ThroughputLaneOptions,
} from './throughput-lanes.js';
import { isNodeRuntime, isTcpUrl, loadTcpTransport } from './sockets.js';

/**
 * Runs throughput lanes on Node.js worker threads so socket I/O, TLS, and WebSocket framing
 * for the throughput stages spread across CPU cores. A single JavaScript thread tops out at a
 * few Gbps, which is below the multi-gigabit links the library measures.
 *
 * Workers use their own global `WebSocket`. They are only used when it is the same
 * implementation as the calling thread's, so a polyfill or custom subclass installed by the
 * application always keeps every socket on the calling thread. Raw TCP lanes (`tcp://` and
 * `tcps://` URLs) load the transport inside the worker and need no global `WebSocket`.
 */

export interface WorkerLaneData extends ThroughputLaneOptions {
  direction: ThroughputDirection;
  /** Shared byte counters, one BigInt64 slot per lane. */
  counters: SharedArrayBuffer;
  slot: number;
  /** Source text of the calling thread's `WebSocket`, compared inside the worker. Unused for raw TCP. */
  webSocketSource: string | null;
}

export type WorkerToHostMessage =
  | { type: 'ready' }
  | { type: 'unsupported' }
  | { type: 'open' }
  | { type: 'error'; message: string };

export type HostToWorkerMessage = { type: 'start' } | { type: 'close' };

export interface LanePort {
  postMessage(message: WorkerToHostMessage): void;
  on(event: 'message', listener: (message: HostToWorkerMessage) => void): void;
}

// Kept in variables so browser bundlers never try to resolve Node-only modules.
const WORKER_THREADS_MODULE = 'node:worker_threads';
const OS_MODULE = 'node:os';
const WORKER_FILE = './throughput-worker.js';
/** A closed worker is terminated if its sockets have not finished closing by then. */
const WORKER_CLOSE_GRACE_MS = 2000;

export function getWebSocketSource(): string | null {
  try {
    return typeof WebSocket === 'function' ? Function.prototype.toString.call(WebSocket) : null;
  } catch {
    return null;
  }
}

/** Splits `connectionCount` sockets across `threads` lanes as evenly as possible. */
export function splitConnections(connectionCount: number, threads: number): number[] {
  const laneCount = Math.max(1, Math.min(threads, connectionCount));
  const base = Math.floor(connectionCount / laneCount);
  const extra = connectionCount % laneCount;
  return Array.from({ length: laneCount }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Hosts one lane inside a worker. Exported separately from the worker entry so it can be
 * exercised with an in-process message port.
 */
export async function hostWorkerLane(port: LanePort, data: WorkerLaneData): Promise<void> {
  const supported = isTcpUrl(data.serverUrl)
    ? (await loadTcpTransport()) !== null
    : getWebSocketSource() === data.webSocketSource;
  if (!supported) {
    port.postMessage({ type: 'unsupported' });
    return;
  }

  const counters = new BigInt64Array(data.counters);
  let lane: ThroughputLane;
  try {
    lane = openThroughputLane(data.direction, data, {
      onOpen: () => port.postMessage({ type: 'open' }),
      onError: (error) => port.postMessage({ type: 'error', message: error.message }),
      onBytes: (bytes) => Atomics.store(counters, data.slot, BigInt(bytes)),
    });
  } catch (error) {
    port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    return;
  }

  port.on('message', (message) => {
    if (message.type === 'start') lane.start();
    else if (message.type === 'close') lane.close();
  });
  port.postMessage({ type: 'ready' });
}

interface NodeWorker {
  postMessage(message: HostToWorkerMessage): void;
  on(event: 'message', listener: (message: WorkerToHostMessage) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  terminate(): Promise<number>;
  unref(): void;
}

type NodeWorkerConstructor = new (
  filename: URL,
  options: { workerData: WorkerLaneData }
) => NodeWorker;

async function loadWorkerSupport(): Promise<{ Worker: NodeWorkerConstructor; cores: number } | null> {
  if (!isNodeRuntime() || typeof SharedArrayBuffer === 'undefined') return null;
  try {
    const workerThreads = await import(/* webpackIgnore: true */ /* @vite-ignore */ WORKER_THREADS_MODULE);
    const os = await import(/* webpackIgnore: true */ /* @vite-ignore */ OS_MODULE);
    const cores =
      typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return { Worker: workerThreads.Worker as NodeWorkerConstructor, cores };
  } catch {
    return null;
  }
}

/**
 * Opens lanes on worker threads, splitting `connectionCount` sockets across up to `threads`
 * workers. Uses at most half of the available cores. Resolves null when worker threads are
 * unavailable or would use a different socket implementation, so the caller can fall back
 * to a lane on the calling thread.
 */
export async function openWorkerLanes(
  direction: ThroughputDirection,
  options: ThroughputLaneOptions & { threads: number },
  callbacks: ThroughputLaneCallbacks
): Promise<ThroughputLane[] | null> {
  const webSocketSource = getWebSocketSource();
  if (!webSocketSource && !isTcpUrl(options.serverUrl)) return null;
  const support = await loadWorkerSupport();
  if (!support) return null;

  const threads = Math.min(options.threads, Math.max(1, Math.floor(support.cores / 2)));
  const shares = splitConnections(options.connectionCount, threads);
  if (shares.length < 2) return null;

  const counters = new SharedArrayBuffer(8 * shares.length);
  const counterView = new BigInt64Array(counters);
  const workers: NodeWorker[] = [];

  return new Promise<ThroughputLane[] | null>((resolve) => {
    let state: 'pending' | 'resolved' | 'abandoned' = 'pending';
    let readyCount = 0;
    // Lanes that open before every worker is ready are reported once the lanes are handed over.
    let pendingOpens = 0;

    const abandon = () => {
      if (state !== 'pending') return;
      state = 'abandoned';
      for (const worker of workers) void worker.terminate();
      resolve(null);
    };

    let firstSocketIndex = 0;
    shares.forEach((connectionCount, slot) => {
      if (state !== 'pending') return;
      let worker: NodeWorker;
      try {
        worker = new support.Worker(new URL(WORKER_FILE, import.meta.url), {
          workerData: {
            direction,
            serverUrl: options.serverUrl,
            messageSizeKb: options.messageSizeKb,
            connectionCount,
            firstSocketIndex,
            counters,
            slot,
            webSocketSource,
          },
        });
      } catch {
        abandon();
        return;
      }
      firstSocketIndex += connectionCount;
      workers.push(worker);

      worker.on('message', (message) => {
        if (state === 'abandoned') return;
        switch (message.type) {
          case 'ready':
            readyCount++;
            if (readyCount === shares.length && state === 'pending') {
              state = 'resolved';
              for (; pendingOpens > 0; pendingOpens--) callbacks.onOpen();
              resolve(workers.map((w, i) => createWorkerLane(w, counterView, i)));
            }
            break;
          case 'unsupported':
            abandon();
            break;
          case 'open':
            if (state === 'resolved') callbacks.onOpen();
            else pendingOpens++;
            break;
          case 'error':
            if (state === 'resolved') callbacks.onError(new Error(message.message));
            else abandon();
            break;
        }
      });
      worker.on('error', (error) => {
        if (state === 'resolved') callbacks.onError(error);
        else abandon();
      });
    });
  });
}

function createWorkerLane(worker: NodeWorker, counters: BigInt64Array, slot: number): ThroughputLane {
  let closed = false;
  return {
    start() {
      worker.postMessage({ type: 'start' });
    },
    close() {
      if (closed) return;
      closed = true;
      worker.postMessage({ type: 'close' });
      worker.unref();
      setTimeout(() => void worker.terminate(), WORKER_CLOSE_GRACE_MS).unref?.();
    },
    get bytes() {
      return Number(Atomics.load(counters, slot));
    },
  };
}
