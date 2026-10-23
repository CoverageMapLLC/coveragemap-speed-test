import type { SpeedSnapshot } from '../types/speed-test.js';
import { CancellationToken } from '../utils/cancellation.js';
import { getWebSocketSource } from '../tests/worker-lanes.js';
import { localStageRunner } from './stage-runner.js';
import {
  serializeError,
  type StageCommand,
  type StageEvent,
  type StageRequest,
} from './stage-protocol.js';

/**
 * The worker side of the browser stage worker: runs the stages the engine asks for with the
 * same code the engine would run on its own thread, and reports pings, snapshots, results,
 * and errors back. Exported apart from the worker entry so it can be driven through any
 * message port in tests.
 */

/** The parts of a worker global scope or `MessagePort` the stage worker uses. */
export interface StagePort {
  postMessage(message: StageEvent): void;
  addEventListener(type: 'message', listener: (event: { data: StageCommand }) => void): void;
  start?(): void;
}

export function serveStages(port: StagePort): void {
  if (typeof WebSocket !== 'function') {
    port.postMessage({ type: 'unsupported', reason: 'WebSocket is not available in workers' });
    return;
  }

  const running = new Map<number, CancellationToken>();

  const run = (id: number, request: StageRequest, cancellationToken: CancellationToken) => {
    const onPing = (latencyMs: number, index: number) => port.postMessage({ type: 'ping', id, latencyMs, index });
    const onSnapshot = (snapshot: SpeedSnapshot) => port.postMessage({ type: 'snapshot', id, snapshot });
    switch (request.stage) {
      case 'latency':
        return localStageRunner.runLatencyTest({ ...request.options, cancellationToken, onPing });
      case 'downloadEstimation':
        return localStageRunner.runDownloadEstimationTest({ ...request.options, cancellationToken });
      case 'uploadEstimation':
        return localStageRunner.runUploadEstimationTest({ ...request.options, cancellationToken });
      case 'download':
        return localStageRunner.runDownloadSpeedTest({ ...request.options, cancellationToken, onSnapshot });
      case 'upload':
        return localStageRunner.runUploadSpeedTest({ ...request.options, cancellationToken, onSnapshot });
      default:
        return Promise.reject(new Error(`Unknown stage: ${(request as { stage: string }).stage}`));
    }
  };

  port.addEventListener('message', (event) => {
    const command = event.data;
    if (command.type === 'cancel') {
      running.get(command.id)?.cancel();
      return;
    }
    if (command.type !== 'run') return;

    const { id } = command;
    const cancellationToken = new CancellationToken();
    running.set(id, cancellationToken);
    let stage: Promise<unknown>;
    try {
      stage = run(id, command as StageRequest, cancellationToken);
    } catch (error) {
      stage = Promise.reject(error);
    }
    stage.then(
      (value) => port.postMessage({ type: 'result', id, value } as StageEvent),
      (error: unknown) => port.postMessage({ type: 'error', id, error: serializeError(error) })
    ).finally(() => running.delete(id));
  });
  port.start?.();
  port.postMessage({ type: 'ready', webSocketSource: getWebSocketSource() });
}
