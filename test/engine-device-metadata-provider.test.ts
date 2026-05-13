import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetDeviceMetadataProvider,
  resetDeviceInfoConfiguration,
  type DeviceMetadataProvider,
  type DeviceMetadataProviderConfig,
} from '../src/utils/device-info.js';
import type { NetworkTestResultDevice } from '../src/types/test-results.js';

const mocks = vi.hoisted(() => ({
  latencyMock: vi.fn(),
  downloadEstimationMock: vi.fn(),
  uploadEstimationMock: vi.fn(),
  downloadSpeedMock: vi.fn(),
  uploadSpeedMock: vi.fn(),
  getServerListMock: vi.fn(),
  getConnectionInfoMock: vi.fn(),
  uploadResultsMock: vi.fn(),
}));

const applicationMetadata = {
  id: '9f8e7d6c-5b4a-4321-9fed-cba987654321',
  name: 'Device Metadata Provider Engine Tests',
  version: '1.0.0',
  organization: 'CoverageMap',
  type: 'backend',
};

const testServer = {
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

vi.mock('../src/tests/latency-test.js', () => ({ runLatencyTest: mocks.latencyMock }));
vi.mock('../src/tests/download-estimation-test.js', () => ({ runDownloadEstimationTest: mocks.downloadEstimationMock }));
vi.mock('../src/tests/upload-estimation-test.js', () => ({ runUploadEstimationTest: mocks.uploadEstimationMock }));
vi.mock('../src/tests/download-speed-test.js', () => ({ runDownloadSpeedTest: mocks.downloadSpeedMock }));
vi.mock('../src/tests/upload-speed-test.js', () => ({ runUploadSpeedTest: mocks.uploadSpeedMock }));
vi.mock('../src/api/speed-api.js', () => ({
  SpeedTestApiClient: class {
    getServers = mocks.getServerListMock;
    getConnectionInfo = mocks.getConnectionInfoMock;
    setLocationProvider = vi.fn();
  },
}));
vi.mock('../src/api/coveragemap-api.js', () => ({
  CoverageMapApiClient: class {
    uploadSpeedTestResults = mocks.uploadResultsMock;
  },
}));

function makeProvider(deviceId = 'provider-device-id'): DeviceMetadataProvider {
  return {
    reset: vi.fn(),
    getDeviceId: vi.fn().mockReturnValue(deviceId),
    parseBrowserInfo: vi.fn().mockReturnValue({
      browserName: 'ProviderBrowser',
      browserVersion: '9.0',
      browserEngine: 'ProviderEngine',
    }),
    parseOSInfo: vi.fn().mockReturnValue({ osName: 'ProviderOS', osVersion: '1.0' }),
    getBrowserInfo: vi.fn().mockReturnValue({
      browserName: 'ProviderBrowser',
      browserVersion: '9.0',
      browserEngine: 'ProviderEngine',
      platform: 'linux',
      language: 'en-US',
      languages: ['en-US'],
      hardwareConcurrency: 4,
      deviceMemory: 8,
      maxTouchPoints: 0,
      screenWidth: 1920,
      screenHeight: 1080,
      devicePixelRatio: 1,
      cookieEnabled: false,
      doNotTrack: null,
      vendor: 'ProviderVendor',
      isMobile: false,
    }),
    buildDeviceResult: vi.fn((config: DeviceMetadataProviderConfig): NetworkTestResultDevice => ({
      id: deviceId,
      manufacturer: 'ProviderManufacturer',
      nameId: 'provider-name-id',
      name: 'Provider Device',
      os: 'linux',
      osVersion: '5.15',
      appName: config.application.name,
      appVersion: config.application.version,
      application: { ...config.application },
      browserName: 'ProviderBrowser',
      browserVersion: '9.0',
      browserEngine: 'ProviderEngine',
      browserEngineVersion: '9.0',
      cpuArchitecture: 'x64',
      cpuCores: 4,
      deviceMemoryGb: 8,
      deviceType: 'server',
      deviceVendor: 'ProviderVendor',
      deviceModel: 'ProviderModel',
      isMobile: false,
      language: 'en-US',
      timezone: 'UTC',
      coreSystem: null,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();

  mocks.getServerListMock.mockResolvedValue([]);
  mocks.getConnectionInfoMock.mockResolvedValue({
    client: { ip: '1.1.1.1', latitude: 40, longitude: -74, asOrg: 'CoverageMap ISP' },
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
  mocks.downloadEstimationMock.mockResolvedValue({ durationMs: 120, bytes: 400_000, speedMbps: 26.6 });
  mocks.uploadEstimationMock.mockResolvedValue({ durationMs: 130, bytes: 300_000, speedMbps: 18.4 });
  mocks.downloadSpeedMock.mockResolvedValue({
    durationMs: 2000, bytes: 4_000_000, speedMbps: 120,
    snapshots: [{ timeOffsetMs: 100, speedMbps: 100, bytes: 1_000_000 }],
  });
  mocks.uploadSpeedMock.mockResolvedValue({
    durationMs: 2000, bytes: 2_000_000, speedMbps: 60,
    snapshots: [{ timeOffsetMs: 100, speedMbps: 50, bytes: 500_000 }],
  });
  mocks.uploadResultsMock.mockResolvedValue(undefined);
});

afterEach(() => {
  resetDeviceMetadataProvider();
  resetDeviceInfoConfiguration();
});

describe('engine.setDeviceMetadataProvider', () => {
  it('routes device result through the injected provider', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });
    const provider = makeProvider('injected-device-id');

    engine.setDeviceMetadataProvider(provider);
    const result = await engine.run(testServer);

    expect(result.device.id).toBe('injected-device-id');
    expect(provider.buildDeviceResult).toHaveBeenCalled();
  });

  it('provider receives the application config set on the engine', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });
    const provider = makeProvider();

    engine.setDeviceMetadataProvider(provider);
    await engine.run(testServer);

    expect(provider.buildDeviceResult).toHaveBeenCalledWith(
      expect.objectContaining({
        application: expect.objectContaining({
          name: applicationMetadata.name,
          version: applicationMetadata.version,
        }),
      })
    );
  });

  it('replacing the provider switches to the new one for subsequent runs', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });

    const firstProvider = makeProvider('first-device-id');
    const secondProvider = makeProvider('second-device-id');

    engine.setDeviceMetadataProvider(firstProvider);
    const firstResult = await engine.run(testServer);
    expect(firstResult.device.id).toBe('first-device-id');

    engine.setDeviceMetadataProvider(secondProvider);
    const secondResult = await engine.run(testServer);
    expect(secondResult.device.id).toBe('second-device-id');

    expect(firstProvider.buildDeviceResult).toHaveBeenCalledTimes(1);
    expect(secondProvider.buildDeviceResult).toHaveBeenCalledTimes(1);
  });

  it('passing null restores the default provider', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });
    const provider = makeProvider('custom-id');

    engine.setDeviceMetadataProvider(provider);
    const customResult = await engine.run(testServer);
    expect(customResult.device.id).toBe('custom-id');

    engine.setDeviceMetadataProvider(null);
    const defaultResult = await engine.run(testServer);
    expect(defaultResult.device.id).not.toBe('custom-id');
    expect(provider.buildDeviceResult).toHaveBeenCalledTimes(1);
  });

  it('provider buildDeviceResult is called exactly once per run', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });
    const provider = makeProvider();

    engine.setDeviceMetadataProvider(provider);
    await engine.run(testServer);
    await engine.run(testServer);

    expect(provider.buildDeviceResult).toHaveBeenCalledTimes(2);
  });
});
