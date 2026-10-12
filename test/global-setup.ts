// Builds the embedded browser stage worker before any test imports the library.
// @ts-expect-error plain JavaScript build script without type declarations
import { buildStageWorker } from '../scripts/build-stage-worker.mjs';

export default async function setup(): Promise<void> {
  await buildStageWorker();
}
