// jsdom: a browser-like global scope, without a real Worker.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canUseStageWorker,
  createBlobStageWorker,
  createStageRunner,
} from '../src/browser/stage-worker-client.js';
import { localStageRunner } from '../src/browser/stage-runner.js';
import { STAGE_WORKER_SOURCE } from '../src/browser/stage-worker-source.generated.js';

/** Records how the library creates and tears down its worker. */
class RecordingWorker {
  static created: RecordingWorker[] = [];
  static throwOnCreate: Error | null = null;
  terminated = false;
  constructor(
    readonly url: string,
    readonly options: { name?: string }
  ) {
    if (RecordingWorker.throwOnCreate) throw RecordingWorker.throwOnCreate;
    RecordingWorker.created.push(this);
  }
  postMessage() {}
  addEventListener() {}
  terminate() {
    this.terminated = true;
  }
}

afterEach(() => {
  RecordingWorker.created = [];
  RecordingWorker.throwOnCreate = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** jsdom's Blob has no text(). */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function stubBlobUrls() {
  const blobs: Blob[] = [];
  const create = vi.fn((blob: Blob) => {
    blobs.push(blob);
    return `blob:test/${blobs.length}`;
  });
  const revoke = vi.fn();
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
  return { blobs, create, revoke };
}

describe('stage worker in browsers', () => {
  it('is available where Worker, Blob, and blob URLs exist', () => {
    stubBlobUrls();
    vi.stubGlobal('Worker', RecordingWorker);
    expect(canUseStageWorker()).toBe(true);
  });

  it('is not available without Worker', () => {
    stubBlobUrls();
    vi.stubGlobal('Worker', undefined);
    expect(canUseStageWorker()).toBe(false);
  });

  it('is not available without blob URLs', () => {
    vi.stubGlobal('Worker', RecordingWorker);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: undefined }));
    expect(canUseStageWorker()).toBe(false);
  });

  it('starts the embedded script from a blob URL and revokes it when the worker ends', async () => {
    const { blobs, revoke } = stubBlobUrls();
    vi.stubGlobal('Worker', RecordingWorker);

    const handle = createBlobStageWorker();
    expect(RecordingWorker.created).toHaveLength(1);
    const [worker] = RecordingWorker.created;
    expect(worker.url).toBe('blob:test/1');
    expect(worker.options.name).toBe('coveragemap-speed-test');
    expect(blobs[0].type).toBe('text/javascript');
    expect(await readBlob(blobs[0])).toBe(STAGE_WORKER_SOURCE);
    expect(revoke).not.toHaveBeenCalled();

    handle.terminate();
    expect(worker.terminated).toBe(true);
    expect(revoke).toHaveBeenCalledWith('blob:test/1');
  });

  it('revokes the blob URL when the worker cannot be created', () => {
    const { revoke } = stubBlobUrls();
    vi.stubGlobal('Worker', RecordingWorker);
    RecordingWorker.throwOnCreate = new Error('SecurityError: blocked by Content Security Policy');
    expect(() => createBlobStageWorker()).toThrow('SecurityError');
    expect(revoke).toHaveBeenCalledWith('blob:test/1');
  });

  it('falls back to the calling thread when the browser refuses the worker', async () => {
    stubBlobUrls();
    vi.stubGlobal('Worker', RecordingWorker);
    RecordingWorker.throwOnCreate = new Error('SecurityError');
    expect(await createStageRunner(true)).toBe(localStageRunner);
  });

  it('falls back to the calling thread when the worker never answers', async () => {
    stubBlobUrls();
    vi.stubGlobal('Worker', RecordingWorker);
    const runner = await createStageRunner(true, { readyTimeoutMs: 50 });
    expect(runner).toBe(localStageRunner);
    expect(RecordingWorker.created[0].terminated).toBe(true);
  });

  it('never creates a worker when it is turned off', async () => {
    stubBlobUrls();
    vi.stubGlobal('Worker', RecordingWorker);
    expect(await createStageRunner(false)).toBe(localStageRunner);
    expect(RecordingWorker.created).toHaveLength(0);
  });
});
