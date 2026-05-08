import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetworkTestResultTestResults } from '../src/types/test-results.js';
import { CancellationError } from '../src/utils/cancellation.js';

const mocks = vi.hoisted(() => ({
  latencyMock: vi.fn(),
  downloadEstimationMock: vi.fn(),
  uploadEstimationMock: vi.fn(),
  downloadSpeedMock: vi.fn(),
  uploadSpeedMock: vi.fn(),
  getServerListMock: vi.fn(),
  getConnectionInfoMock: vi.fn(),
  uploadResultsMock: vi.fn(),
  speedApiCtorArgs: [] as unknown[],
  coverageMapApiCtorArgs: [] as unknown[],
}));

const applicationMetadata = {
  id: '9f8e7d6c-5b4a-4321-9fed-cba987654321',
  name: 'Engine Regression Harness',
  version: '1.0.0',
  organization: 'CoverageMap',
  type: 'backend',
};

vi.mock('../src/tests/latency-test.js', () => ({
  runLatencyTest: mocks.latencyMock,
}));
vi.mock('../src/tests/download-estimation-test.js', () => ({
  runDownloadEstimationTest: mocks.downloadEstimationMock,
}));
vi.mock('../src/tests/upload-estimation-test.js', () => ({
  runUploadEstimationTest: mocks.uploadEstimationMock,
}));
vi.mock('../src/tests/download-speed-test.js', () => ({
  runDownloadSpeedTest: mocks.downloadSpeedMock,
}));
vi.mock('../src/tests/upload-speed-test.js', () => ({
  runUploadSpeedTest: mocks.uploadSpeedMock,
}));
vi.mock('../src/api/speed-api.js', () => ({
  SpeedTestApiClient: class {
    constructor(...args: unknown[]) {
      mocks.speedApiCtorArgs.push(args);
    }
    getServers = mocks.getServerListMock;
    getConnectionInfo = mocks.getConnectionInfoMock;
  },
}));
vi.mock('../src/api/coveragemap-api.js', () => ({
  CoverageMapApiClient: class {
    constructor(...args: unknown[]) {
      mocks.coverageMapApiCtorArgs.push(args);
    }
    uploadSpeedTestResults = mocks.uploadResultsMock;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.speedApiCtorArgs.length = 0;
  mocks.coverageMapApiCtorArgs.length = 0;

  mocks.getServerListMock.mockResolvedValue([]);
  mocks.getConnectionInfoMock.mockResolvedValue({
    client: {
      ip: '1.1.1.1',
      latitude: 40,
      longitude: -74,
      asOrg: 'CoverageMap ISP',
    },
  });
  mocks.latencyMock.mockResolvedValue({
    latencies: [10, 11, 12],
    minLatency: 10,
    averageLatency: 11,
    medianLatency: 11,
    minJitter: 1,
    averageJitter: 1,
    medianJitter: 1,
  });
  mocks.downloadEstimationMock.mockResolvedValue({
    durationMs: 120,
    bytes: 400_000,
    speedMbps: 26.6,
  });
  mocks.uploadEstimationMock.mockResolvedValue({
    durationMs: 130,
    bytes: 300_000,
    speedMbps: 18.4,
  });
  mocks.downloadSpeedMock.mockResolvedValue({
    durationMs: 2000,
    bytes: 4_000_000,
    speedMbps: 120,
    snapshots: [{ timeOffsetMs: 100, speedMbps: 100, bytes: 1_000_000 }],
  });
  mocks.uploadSpeedMock.mockResolvedValue({
    durationMs: 2000,
    bytes: 2_000_000,
    speedMbps: 60,
    snapshots: [{ timeOffsetMs: 100, speedMbps: 50, bytes: 500_000 }],
  });
  mocks.uploadResultsMock.mockResolvedValue(undefined);
});

describe('engine regression', () => {
  it('runs stages in order and assembles final result payload', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');

    const stageEvents: string[] = [];
    const engine = new SpeedTestEngine({
      application: applicationMetadata,
      callbacks: {
        onStageChange: (stage) => stageEvents.push(stage),
      },
    });

    const result = await engine.run({
      id: 'srv-1',
      domain: 'speed.example.com',
      port: 443,
      provider: null,
      city: null,
      region: null,
      country: 'US',
      location: 'US',
      latitude: null,
      longitude: null,
      distance: null,
      isCDN: null,
    });

    expect(stageEvents).toEqual([
      'latency',
      'downloadEstimation',
      'download',
      'uploadEstimation',
      'upload',
      'complete',
    ]);
    expect(result.results.measurements.downloadSpeed).toBe(120);
    expect(result.results.measurements.uploadSpeed).toBe(60);
    expect(result.results.measurements.failedReason).toBeNull();
    expect(mocks.uploadResultsMock).toHaveBeenCalledTimes(1);
  });

  it('selects the first available server when none is provided', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    mocks.getServerListMock.mockResolvedValueOnce([
      {
        id: 'srv-auto-1',
        domain: 'first.speed.example.com',
        port: 443,
        provider: null,
        city: null,
        region: null,
        country: 'US',
        location: 'US East',
        latitude: null,
        longitude: null,
        distance: null,
        isCDN: null,
      },
      {
        id: 'srv-auto-2',
        domain: 'second.speed.example.com',
        port: 443,
        provider: null,
        city: null,
        region: null,
        country: 'US',
        location: 'US West',
        latitude: null,
        longitude: null,
        distance: null,
        isCDN: null,
      },
    ]);

    const engine = new SpeedTestEngine({
      application: applicationMetadata,
    });

    const result = await engine.run();

    expect(mocks.getServerListMock).toHaveBeenCalled();
    expect(mocks.latencyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: 'wss://first.speed.example.com:443/v1/ws',
      })
    );
    expect(result.results.server).not.toBeNull();
    expect(result.results.server?.id).toBe('srv-auto-1');
  });

  it('throws when no speed servers are available for auto-selection', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    mocks.getServerListMock.mockResolvedValueOnce([]);

    const engine = new SpeedTestEngine({
      application: applicationMetadata,
    });

    await expect(engine.run()).rejects.toThrow('No speed servers available');
    expect(engine.isRunning).toBe(false);
  });

  it('queues results when upload fails and retries queued uploads', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');

    mocks.uploadResultsMock.mockRejectedValueOnce(new Error('temporary upload failure'));
    mocks.uploadResultsMock.mockResolvedValueOnce(undefined);

    const engine = new SpeedTestEngine({
      application: applicationMetadata,
    });

    const result = await engine.run({
      id: 'srv-1',
      domain: 'speed.example.com',
      port: 443,
      provider: null,
      city: null,
      region: null,
      country: 'US',
      location: 'US',
      latitude: null,
      longitude: null,
      distance: null,
      isCDN: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const queueRaw = localStorage.getItem('coveragemap-test-results-queue');
    expect(queueRaw).toBeTruthy();
    const queue = JSON.parse(queueRaw ?? '[]') as NetworkTestResultTestResults[];
    expect(queue).toHaveLength(1);
    expect(queue[0]?.testType?.id).toBe(result.testType.id);

    await engine.retryQueuedUploads();
    expect(localStorage.getItem('coveragemap-test-results-queue')).toBeNull();
    expect(mocks.uploadResultsMock).toHaveBeenCalledTimes(2);
  });

  it('passes config overrides to stage runners and result metadata', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({
      application: applicationMetadata,
      config: {
        pingCount: 7,
        downloadDurationMs: 3210,
        uploadDurationMs: 6540,
        snapshotIntervalMs: 250,
        latencyTimeoutMs: 7777,
        estimationTimeoutMs: 8888,
      },
    });

    const result = await engine.run({
      id: 'srv-1',
      domain: 'speed.example.com',
      port: 443,
      provider: null,
      city: null,
      region: null,
      country: 'US',
      location: 'US',
      latitude: null,
      longitude: null,
      distance: null,
      isCDN: null,
    });

    expect(mocks.latencyMock).toHaveBeenCalledWith(
      expect.objectContaining({ pingCount: 7, timeoutMs: 7777 })
    );
    expect(mocks.downloadEstimationMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 8888 })
    );
    expect(mocks.uploadEstimationMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 8888 })
    );
    expect(mocks.downloadSpeedMock).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 3210, snapshotIntervalMs: 250 })
    );
    expect(mocks.uploadSpeedMock).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 6540, snapshotIntervalMs: 250 })
    );
    expect(result.testType.downloadTestDuration).toBe(3210);
    expect(result.testType.uploadTestDuration).toBe(6540);
  });

  it('runs only latency when tests selection disables download/upload', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({
      application: applicationMetadata,
      tests: {
        latency: true,
        download: false,
        upload: false,
      },
    });

    const result = await engine.run({
      id: 'srv-1',
      domain: 'speed.example.com',
      port: 443,
      provider: null,
      city: null,
      region: null,
      country: 'US',
      location: 'US',
      latitude: null,
      longitude: null,
      distance: null,
      isCDN: null,
    });

    expect(mocks.downloadEstimationMock).not.toHaveBeenCalled();
    expect(mocks.downloadSpeedMock).not.toHaveBeenCalled();
    expect(mocks.uploadEstimationMock).not.toHaveBeenCalled();
    expect(mocks.uploadSpeedMock).not.toHaveBeenCalled();
    expect(result.results.measurements.latency).toBe(10);
    expect(result.results.measurements.downloadSpeed).toBeNull();
    expect(result.results.measurements.uploadSpeed).toBeNull();
    expect(mocks.uploadResultsMock).toHaveBeenCalledTimes(1);
  });

  it('runs only upload when tests selection disables latency/download', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({
      application: applicationMetadata,
      tests: {
        latency: false,
        download: false,
        upload: true,
      },
    });

    const result = await engine.run({
      id: 'srv-1',
      domain: 'speed.example.com',
      port: 443,
      provider: null,
      city: null,
      region: null,
      country: 'US',
      location: 'US',
      latitude: null,
      longitude: null,
      distance: null,
      isCDN: null,
    });

    expect(mocks.latencyMock).toHaveBeenCalledTimes(1);
    expect(mocks.latencyMock).toHaveBeenCalledWith(
      expect.objectContaining({ pingCount: 1 })
    );
    expect(mocks.downloadEstimationMock).not.toHaveBeenCalled();
    expect(mocks.downloadSpeedMock).not.toHaveBeenCalled();
    expect(mocks.uploadEstimationMock).toHaveBeenCalledTimes(1);
    expect(mocks.uploadSpeedMock).toHaveBeenCalledTimes(1);
    expect(result.results.measurements.latency).toBe(10);
    expect(result.results.measurements.downloadSpeed).toBeNull();
    expect(result.results.measurements.uploadSpeed).toBe(60);
  });

  it('rejects application id that is not a UUID', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');

    expect(
      () =>
        new SpeedTestEngine({
          application: { ...applicationMetadata, id: 'not-a-uuid' },
        })
    ).toThrow(
      'SpeedTestEngineOptions.application.id must be a UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx, hexadecimal)'
    );
  });

  it('rejects the documentation demo application id', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');

    expect(
      () =>
        new SpeedTestEngine({
          application: {
            ...applicationMetadata,
            id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          },
        })
    ).toThrow(
      'SpeedTestEngineOptions.application.id must be your own static UUID for this integration, not the documentation example'
    );
  });

  it('rejects invalid tests selection with no enabled tests', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');

    expect(
      () =>
        new SpeedTestEngine({
          application: applicationMetadata,
          tests: {
            latency: false,
            download: false,
            upload: false,
          },
        })
    ).toThrow('SpeedTestEngineOptions.tests must enable at least one test');
  });

  it('constructs API clients with production defaults', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    new SpeedTestEngine({
      application: applicationMetadata,
    });

    expect(mocks.speedApiCtorArgs[0]).toEqual([undefined, null]);
    expect(mocks.coverageMapApiCtorArgs[0]).toEqual([undefined]);
  });

  it('passes API base URL overrides to API clients when provided', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    new SpeedTestEngine({
      application: applicationMetadata,
      api: {
        speedApiBaseUrl: 'https://speed.internal.example',
        coverageMapApiBaseUrl: 'https://map.internal.example',
      },
    });

    expect(mocks.speedApiCtorArgs[0]).toEqual([
      {
        speedApiBaseUrl: 'https://speed.internal.example',
        coverageMapApiBaseUrl: 'https://map.internal.example',
      },
      null,
    ]);
    expect(mocks.coverageMapApiCtorArgs[0]).toEqual([
      {
        speedApiBaseUrl: 'https://speed.internal.example',
        coverageMapApiBaseUrl: 'https://map.internal.example',
      },
    ]);
  });

  it('maps non-cancellation stage errors and emits onError callback', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const stageError = new Error('download stage exploded');
    mocks.downloadSpeedMock.mockRejectedValueOnce(stageError);
    const onError = vi.fn();

    const engine = new SpeedTestEngine({
      application: applicationMetadata,
      callbacks: { onError },
    });

    const result = await engine.run({
      id: 'srv-1',
      domain: 'speed.example.com',
      port: 443,
      provider: null,
      city: null,
      region: null,
      country: 'US',
      location: 'US',
      latitude: null,
      longitude: null,
      distance: null,
      isCDN: null,
    });

    expect(onError).toHaveBeenCalledWith(stageError, 'download');
    expect(result.results.measurements.failedReason).toBe('download stage exploded');
    expect(result.results.measurements.failedStage).toBe('downloadStart');
  });

  it('marks cancellation failures without calling onError', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    mocks.latencyMock.mockRejectedValueOnce(new CancellationError());
    const onError = vi.fn();

    const engine = new SpeedTestEngine({
      application: applicationMetadata,
      callbacks: { onError },
    });

    const result = await engine.run({
      id: 'srv-1',
      domain: 'speed.example.com',
      port: 443,
      provider: null,
      city: null,
      region: null,
      country: 'US',
      location: 'US',
      latitude: null,
      longitude: null,
      distance: null,
      isCDN: null,
    });

    expect(result.results.measurements.failedReason).toBe('Cancelled');
    expect(result.results.measurements.failedStage).toBe('latency');
    expect(onError).not.toHaveBeenCalled();
  });

  it('prevents concurrent runs while a test is already active', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');

    let releaseLatency: () => void = () => {};
    mocks.latencyMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseLatency = () =>
            resolve({
              latencies: [10, 11, 12],
              minLatency: 10,
              averageLatency: 11,
              medianLatency: 11,
              minJitter: 1,
              averageJitter: 1,
              medianJitter: 1,
            });
        })
    );

    const engine = new SpeedTestEngine({
      application: applicationMetadata,
    });
    const server = {
      id: 'srv-1',
      domain: 'speed.example.com',
      port: 443,
      provider: null,
      city: null,
      region: null,
      country: 'US',
      location: 'US',
      latitude: null,
      longitude: null,
      distance: null,
      isCDN: null,
    };

    const runPromise = engine.run(server);
    await expect(engine.run(server)).rejects.toThrow('Speed test is already running');

    releaseLatency();
    await runPromise;
  });

  it('throws when required application metadata is missing', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');

    expect(
      () =>
        new SpeedTestEngine({
          application: {
            ...applicationMetadata,
            name: '   ',
          },
        })
    ).toThrow('SpeedTestEngineOptions.application.name is required');
  });

  it('saves required application metadata into result payload', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({
      application: {
        ...applicationMetadata,
        website: 'https://coveragemap.com',
      },
    });

    const result = await engine.run({
      id: 'srv-1',
      domain: 'speed.example.com',
      port: 443,
      provider: null,
      city: null,
      region: null,
      country: 'US',
      location: 'US',
      latitude: null,
      longitude: null,
      distance: null,
      isCDN: null,
    });

    expect(result.device.appName).toBe(applicationMetadata.name);
    expect(result.device.appVersion).toBe(applicationMetadata.version);
    expect(result.device.application).toMatchObject({
      id: applicationMetadata.id,
      name: applicationMetadata.name,
      version: applicationMetadata.version,
      organization: applicationMetadata.organization,
      type: applicationMetadata.type,
      website: 'https://coveragemap.com',
    });
  });
});
