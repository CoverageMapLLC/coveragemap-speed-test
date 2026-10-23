// Entry of the browser stage worker. scripts/build-stage-worker.mjs bundles this file into
// one script that the library embeds and starts from a `blob:` URL; it is never imported.
import { serveStages, type StagePort } from './stage-worker.js';

serveStages(self as unknown as StagePort);
