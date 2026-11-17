// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageRunner } from '../src/browser/stage-runner.js';
import type { SpeedTestServer } from '../src/types/speed-server.js';
import { mockLoadedLatency } from './fixtures/speed-test-data.js';

// The engine's choice of stage runner, with a scripted runner standing in for the worker.
const mocks = vi.hoisted(() => ({ createStageRunner: vi.fn() }));
vi.mock('../src/browser/stage-worker-client.js', () => ({ createStageRunner: mocks.createStageRunner }));
vi.mock('../src/api/speed-api.js', () => ({
  SpeedTestApiClient: class {
    getServers = vi.fn().mockResolvedValue([]);
    getConnectionInfo = vi.fn().mockResolvedValue({ client: { ip: '127.0.0.1', asOrg: 'Loopback' } });
    setLocationProvider = vi.fn();
  },
}));
vi.mock('../src/api/coveragemap-api.js', () => ({
  CoverageMapApiClient: class {
    uploadSpeedTestResults = vi.fn().mockResolvedValue(undefined);
  },
}));

const { SpeedTestEngine } = await import('../src/engine.js');

const application = {
  id: '9f8e7d6c-5b4a-4321-9fed-cba987654321',
  name: 'Engine Stage Runner Harness',
  version: '1.0.0',
  organization: 'CoverageMap',
  type: 'web',
};

const server: SpeedTestServer = {
  id: 'abc',
  domain: 'speed.example.com',
  port: 443,
  provider: null,
  city: null,
  region: null,
  country: 'US',
  location: 'Example',
  latitude: null,
  longitude: null,
  distance: null,
  isCDN: false,
};

const latency = {
  latencies: [10, 11],
  minLatency: 10,
  averageLatency: 10.5,
  medianLatency: 10.5,
  maxLatency: 11,
  minJitter: 1,
  averageJitter: 1,
  medianJitter: 1,
  maxJitter: 1,
};

function scriptedRunner(): StageRunner & { close: ReturnType<typeof vi.fn> } {
  const throughput = (direction: string) =>
    vi.fn(async (options: { onSnapshot?: (snapshot: unknown) => void; serverUrl: string }) => {
      const snapshot = { timeOffsetMs: 100, speedMbps: direction === 'download' ? 900 : 800, bytes: 1000 };
      options.onSnapshot?.(snapshot);
      return { durationMs: 1000, speedMbps: snapshot.speedMbps, bytes: 1000, snapshots: [snapshot], loadedLatency: mockLoadedLatency };
    });
  return {
    mode: 'worker',
    runLatencyTest: vi.fn(async (options: { onPing?: (ms: number, index: number) => void }) => {
      options.onPing?.(10, 0);
      options.onPing?.(11, 1);
      return latency;
    }),
    runDownloadEstimationTest: vi.fn(async () => ({ durationMs: 100, bytes: 1e6, speedMbps: 900 })),
    runUploadEstimationTest: vi.fn(async () => ({ durationMs: 100, bytes: 1e6, speedMbps: 800 })),
    runDownloadSpeedTest: throughput('download'),
    runUploadSpeedTest: throughput('upload'),
    close: vi.fn(),
  } as unknown as StageRunner & { close: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  mocks.createStageRunner.mockReset();
});

describe('engine stage runner', () => {
  it('asks for the browser worker by default and runs every stage through it', async () => {
    const runner = scriptedRunner();
    const uploadRunner = scriptedRunner();
    mocks.createStageRunner.mockResolvedValueOnce(runner).mockResolvedValueOnce(uploadRunner);
    const pings: number[] = [];
    const downloads: number[] = [];
    const uploads: number[] = [];
    const engine = new SpeedTestEngine({
      application,
      config: { transport: 'wss' },
      callbacks: {
        onLatencyPing: (ms) => pings.push(ms),
        onDownloadProgress: (snapshot) => downloads.push(snapshot.speedMbps),
        onUploadProgress: (snapshot) => uploads.push(snapshot.speedMbps),
      },
    });

    const result = await engine.run(server);

    expect(mocks.createStageRunner).toHaveBeenCalledTimes(2);
    expect(mocks.createStageRunner).toHaveBeenNthCalledWith(1, true);
    expect(mocks.createStageRunner).toHaveBeenNthCalledWith(2, true);
    expect(result.results.testStatus).toBe('passed');
    expect(result.results.measurements.downloadSpeed).toBe(900);
    expect(result.results.measurements.uploadSpeed).toBe(800);
    expect(pings).toEqual([10, 11]);
    expect(downloads).toEqual([900]);
    expect(uploads).toEqual([800]);
    for (const stage of [
      runner.runLatencyTest,
      runner.runDownloadEstimationTest,
      runner.runDownloadSpeedTest,
      uploadRunner.runUploadEstimationTest,
      uploadRunner.runUploadSpeedTest,
    ]) {
      expect(stage).toHaveBeenCalledTimes(1);
      expect((stage as ReturnType<typeof vi.fn>).mock.calls[0][0].serverUrl).toBe('wss://speed.example.com:443/v1/ws');
    }
    expect(runner.runUploadEstimationTest).not.toHaveBeenCalled();
    expect(uploadRunner.runDownloadSpeedTest).not.toHaveBeenCalled();
    expect(runner.close).toHaveBeenCalledTimes(1);
    expect(uploadRunner.close).toHaveBeenCalledTimes(1);
  });

  it('terminates the download worker before the upload phase, so its sockets stop receiving', async () => {
    const order: string[] = [];
    const runner = scriptedRunner();
    const uploadRunner = scriptedRunner();
    runner.close.mockImplementation(() => order.push('close download worker'));
    (uploadRunner.runUploadEstimationTest as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('upload estimation');
      return { durationMs: 100, bytes: 1e6, speedMbps: 800 };
    });
    mocks.createStageRunner.mockResolvedValueOnce(runner).mockResolvedValueOnce(uploadRunner);
    await new SpeedTestEngine({ application, config: { transport: 'wss' } }).run(server);
    expect(order).toEqual(['close download worker', 'upload estimation']);
  });

  it('terminates the upload worker when the run is cancelled while it is still starting', async () => {
    const runner = scriptedRunner();
    const uploadRunner = scriptedRunner();
    const engine = new SpeedTestEngine({ application, config: { transport: 'wss' } });
    let readyAfterCancel = false;
    mocks.createStageRunner.mockResolvedValueOnce(runner).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          // Cancel in the cooldown, then report the new worker ready only afterwards.
          setTimeout(() => engine.cancel(), 10);
          setTimeout(() => {
            readyAfterCancel = true;
            resolve(uploadRunner);
          }, 100);
        })
    );

    const result = await engine.run(server);

    expect(readyAfterCancel).toBe(true);
    expect(result.results.measurements.failedReason).toBe('Cancelled');
    expect(runner.close).toHaveBeenCalledTimes(1);
    expect(uploadRunner.close).toHaveBeenCalledTimes(1);
    expect(uploadRunner.runUploadEstimationTest).not.toHaveBeenCalled();
  });

  it('keeps one runner on the calling thread, which has no worker to terminate', async () => {
    const runner = Object.assign(scriptedRunner(), { mode: 'local' as const });
    mocks.createStageRunner.mockResolvedValue(runner);
    const result = await new SpeedTestEngine({ application, config: { transport: 'wss' } }).run(server);
    expect(result.results.testStatus).toBe('passed');
    expect(mocks.createStageRunner).toHaveBeenCalledTimes(1);
    expect(runner.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the worker when there is no download phase before the upload', async () => {
    const runner = scriptedRunner();
    mocks.createStageRunner.mockResolvedValue(runner);
    await new SpeedTestEngine({ application, config: { transport: 'wss' }, tests: { download: false } }).run(server);
    expect(mocks.createStageRunner).toHaveBeenCalledTimes(1);
    expect(runner.runUploadSpeedTest).toHaveBeenCalledTimes(1);
  });

  it('asks for the calling thread when browserWorker is false', async () => {
    mocks.createStageRunner.mockResolvedValue(scriptedRunner());
    const engine = new SpeedTestEngine({ application, config: { transport: 'wss', browserWorker: false } });
    await engine.run(server);
    expect(mocks.createStageRunner).toHaveBeenCalledWith(false);
  });

  it('closes the runner when a stage fails', async () => {
    const downloadRunner = scriptedRunner();
    const runner = scriptedRunner();
    (runner.runUploadSpeedTest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('The speed test worker failed: crashed'));
    mocks.createStageRunner.mockResolvedValueOnce(downloadRunner).mockResolvedValueOnce(runner);
    const engine = new SpeedTestEngine({ application, config: { transport: 'wss' } });

    const result = await engine.run(server);

    expect(result.results.testStatus).toBe('failed');
    expect(result.results.measurements.failedReason).toBe('unknown: The speed test worker failed: crashed');
    expect(result.results.measurements.failedStage).toBe('uploadStart');
    expect(downloadRunner.close).toHaveBeenCalledTimes(1);
    expect(runner.close).toHaveBeenCalledTimes(1);
  });

  it('closes the runner when the run is cancelled', async () => {
    const runner = scriptedRunner();
    mocks.createStageRunner.mockResolvedValue(runner);
    const engine = new SpeedTestEngine({ application, config: { transport: 'wss' } });
    (runner.runDownloadSpeedTest as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      engine.cancel();
      const { CancellationError } = await import('../src/utils/cancellation.js');
      throw new CancellationError();
    });

    const result = await engine.run(server);

    expect(result.results.measurements.failedReason).toBe('Cancelled');
    expect(runner.close).toHaveBeenCalledTimes(1);
  });

  it('starts a new runner for every run', async () => {
    const runners = [scriptedRunner(), scriptedRunner(), scriptedRunner(), scriptedRunner()];
    for (const runner of runners) mocks.createStageRunner.mockResolvedValueOnce(runner);
    const engine = new SpeedTestEngine({ application, config: { transport: 'wss' } });
    await engine.run(server);
    await engine.run(server);
    for (const runner of runners) expect(runner.close).toHaveBeenCalledTimes(1);
    expect(runners[2].runLatencyTest).toHaveBeenCalledTimes(1);
  });
});

describe('nodeWebSocket config', () => {
  const stages = (runner: StageRunner) => [
    runner.runLatencyTest,
    runner.runDownloadEstimationTest,
    runner.runUploadEstimationTest,
    runner.runDownloadSpeedTest,
    runner.runUploadSpeedTest,
  ];

  it('asks every stage for the Node.js WebSocket client by default', async () => {
    const runner = scriptedRunner();
    mocks.createStageRunner.mockResolvedValue(runner);
    await new SpeedTestEngine({ application, config: { transport: 'wss' } }).run(server);
    for (const stage of stages(runner)) {
      expect((stage as ReturnType<typeof vi.fn>).mock.calls[0][0].nodeWebSocket).toBe(true);
    }
  });

  it('asks every stage for the global WebSocket when false', async () => {
    const runner = scriptedRunner();
    mocks.createStageRunner.mockResolvedValue(runner);
    await new SpeedTestEngine({ application, config: { transport: 'wss', nodeWebSocket: false } }).run(server);
    for (const stage of stages(runner)) {
      expect((stage as ReturnType<typeof vi.fn>).mock.calls[0][0].nodeWebSocket).toBe(false);
    }
  });

  it('rejects values that are not booleans', () => {
    expect(() => new SpeedTestEngine({ application, config: { nodeWebSocket: undefined } })).not.toThrow();
    expect(
      () => new SpeedTestEngine({ application, config: { nodeWebSocket: 1 as unknown as boolean } })
    ).toThrow('SpeedTestEngineOptions.config.nodeWebSocket must be a boolean');
  });
});

describe('browserWorker config', () => {
  it('defaults to true', () => {
    expect(() => new SpeedTestEngine({ application })).not.toThrow();
    expect(() => new SpeedTestEngine({ application, config: { browserWorker: undefined } })).not.toThrow();
  });

  it('rejects values that are not booleans', () => {
    expect(
      () => new SpeedTestEngine({ application, config: { browserWorker: 'yes' as unknown as boolean } })
    ).toThrow('SpeedTestEngineOptions.config.browserWorker must be a boolean');
  });
});
