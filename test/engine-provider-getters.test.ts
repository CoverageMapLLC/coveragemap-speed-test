import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetDeviceMetadataProvider,
  resetDeviceInfoConfiguration,
  type DeviceMetadataProvider,
  type DeviceMetadataProviderConfig,
} from '../src/utils/device-info.js';
import type { NetworkTestResultDevice } from '../src/types/test-results.js';
import type { SpeedTestLocationProvider } from '../src/types/location-provider.js';
import type { SpeedTestNetworkProvider } from '../src/types/network-provider.js';

const mocks = vi.hoisted(() => ({
  getConnectionInfoMock: vi.fn(),
}));

const applicationMetadata = {
  id: '9f8e7d6c-5b4a-4321-9fed-cba987654321',
  name: 'Provider Getter Engine Tests',
  version: '1.0.0',
  organization: 'CoverageMap',
  type: 'backend',
};

vi.mock('../src/api/speed-api.js', () => ({
  SpeedTestApiClient: class {
    getServers = vi.fn();
    getConnectionInfo = mocks.getConnectionInfoMock;
    setLocationProvider = vi.fn();
  },
}));
vi.mock('../src/api/coveragemap-api.js', () => ({
  CoverageMapApiClient: class {
    uploadSpeedTestResults = vi.fn();
  },
}));

function makeDeviceProvider(deviceId = 'provider-device-id'): DeviceMetadataProvider {
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

  mocks.getConnectionInfoMock.mockResolvedValue({
    client: { ip: '1.1.1.1', latitude: 40, longitude: -74, asOrg: 'CoverageMap ISP' },
  });
});

afterEach(() => {
  resetDeviceMetadataProvider();
  resetDeviceInfoConfiguration();
});

describe('engine provider getters', () => {
  it('getDevice resolves through the injected device metadata provider', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });
    const provider = makeDeviceProvider('getter-device-id');

    engine.setDeviceMetadataProvider(provider);
    const device = engine.getDevice();

    expect(device.id).toBe('getter-device-id');
    expect(provider.buildDeviceResult).toHaveBeenCalledTimes(1);
  });

  it('getLocation resolves through the injected location provider', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });
    const locationProvider: SpeedTestLocationProvider = vi.fn().mockResolvedValue({
      latitude: 37.7749,
      longitude: -122.4194,
      elevation: 10,
    });

    engine.setLocationProvider(locationProvider);
    const location = await engine.getLocation();

    expect(location).toEqual({
      latitude: 37.7749,
      longitude: -122.4194,
      elevation: 10,
      heading: null,
      speed: null,
      locationType: 'device',
    });
    expect(locationProvider).toHaveBeenCalledWith({
      connectionInfo: {
        client: { ip: '1.1.1.1', latitude: 40, longitude: -74, asOrg: 'CoverageMap ISP' },
      },
    });
  });

  it('getLocation falls back to connection info when no provider is set', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });

    const location = await engine.getLocation();

    expect(location).toEqual({
      latitude: 40,
      longitude: -74,
      elevation: null,
      heading: null,
      speed: null,
      locationType: 'ip',
    });
  });

  it('getNetwork resolves through the injected network provider', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });
    const networkProvider: SpeedTestNetworkProvider = {
      getConnectionType: vi.fn().mockResolvedValue('mobile'),
      getCellularMetadata: vi.fn().mockResolvedValue({
        carrierName: 'Provider Carrier',
        rsrp: -95,
      }),
    };

    engine.setNetworkProvider(networkProvider);
    const network = await engine.getNetwork();

    expect(network.source).toBe('provider');
    expect(network.connectionType).toBe('mobile');
    expect(network.cellular).toEqual(
      expect.objectContaining({
        carrierName: 'Provider Carrier',
        rsrp: -95,
      })
    );
    expect(networkProvider.getCellularMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionInfo: {
          client: { ip: '1.1.1.1', latitude: 40, longitude: -74, asOrg: 'CoverageMap ISP' },
        },
        connectionType: expect.any(String),
      })
    );
  });

  it('getNetwork uses default detection when no provider is set', async () => {
    const { SpeedTestEngine } = await import('../src/engine.js');
    const engine = new SpeedTestEngine({ application: applicationMetadata });

    const network = await engine.getNetwork();

    expect(network.source).toBe('deviceMetadata');
    expect(network.connectionType).toBe('unknown');
    expect(network.cellular).toBeNull();
    expect(network.wifi).toBeNull();
    expect(network.wired).toBeNull();
  });
});
