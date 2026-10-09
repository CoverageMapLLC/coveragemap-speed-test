// Worker thread entry for throughput lanes. Loaded by `openWorkerLanes` in Node.js only.
import { parentPort, workerData } from 'node:worker_threads';
import { hostWorkerLane, type LanePort, type WorkerLaneData } from './worker-lanes.js';

if (parentPort) {
  void hostWorkerLane(parentPort as unknown as LanePort, workerData as WorkerLaneData);
}
