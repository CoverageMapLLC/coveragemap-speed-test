import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NetworkTestResultDevice } from '../src/types/test-results.js';
import {
  buildDeviceResult,
  configureDeviceInfo,
  getBrowserInfo,
  getDeviceId,
  parseBrowserInfo,
  parseOSInfo,
  resetDeviceMetadataProvider,
  resetDeviceInfoConfiguration,
  setDeviceMetadataProvider,
  type DeviceMetadataProvider,
  type DeviceMetadataProviderConfig,
} from '../src/utils/device-info.js';

function createDeviceResult(config: DeviceMetadataProviderConfig): NetworkTestResultDevice {
  return {
    id: 'provider-device-id',
    manufacturer: 'Provider',
    nameId: 'provider-name-id',
    name: 'Provider Device',
    os: 'web',
    osVersion: '1.0.0',
    appName: config.application.name,
    appVersion: config.application.version,
    application: { ...config.application },
    browserName: 'ProviderBrowser',
    browserVersion: '9.9.9',
    browserEngine: 'ProviderEngine',
    browserEngineVersion: '1.2.3',
    cpuArchitecture: 'x64',
    cpuCores: 4,
    deviceMemoryGb: 8,
    deviceType: 'server',
    deviceVendor: 'CoverageMap',
    deviceModel: 'ProviderModel',
    isMobile: false,
    language: 'en-US',
    timezone: 'UTC',
    coreSystem: {
      runtime: 'node',
      hostName: config.coreSystem.hostName ?? 'provider-host',
      processId: config.coreSystem.processId ?? 100,
      platform: config.coreSystem.platform ?? 'linux',
      architecture: config.coreSystem.architecture ?? 'x64',
      runtimeVersion: config.coreSystem.runtimeVersion ?? 'v22.0.0',
      uptimeSeconds: config.coreSystem.uptimeSeconds ?? 5,
      memoryRssMb: config.coreSystem.memoryRssMb ?? 256,
    },
  };
}

describe('device metadata abstraction', () => {
  afterEach(() => {
    resetDeviceMetadataProvider();
    resetDeviceInfoConfiguration();
    vi.restoreAllMocks();
  });

  it('routes metadata retrieval through injected provider', () => {
    const provider: DeviceMetadataProvider = {
      reset: vi.fn(),
      getDeviceId: vi.fn().mockReturnValue('custom-id'),
      parseBrowserInfo: vi.fn().mockReturnValue({
        browserName: 'InjectedBrowser',
        browserVersion: '1.0',
        browserEngine: 'InjectedEngine',
      }),
      parseOSInfo: vi.fn().mockReturnValue({
        osName: 'InjectedOS',
        osVersion: '1.0',
      }),
      getBrowserInfo: vi.fn().mockReturnValue({
        browserName: 'InjectedBrowser',
        browserVersion: '1.0',
        browserEngine: 'InjectedEngine',
        platform: 'linux',
        language: 'en-US',
        languages: ['en-US'],
        hardwareConcurrency: 4,
        deviceMemory: 8,
        maxTouchPoints: 0,
        screenWidth: 0,
        screenHeight: 0,
        devicePixelRatio: 1,
        cookieEnabled: false,
        doNotTrack: null,
        vendor: 'CoverageMap',
        isMobile: false,
      }),
      buildDeviceResult: vi.fn((config) => createDeviceResult(config)),
    };

    setDeviceMetadataProvider(provider);
    configureDeviceInfo({
      deviceIdStorageKey: 'custom-device-key',
      application: {
        name: 'Custom Runtime Agent',
        version: '2.0.0',
      },
      coreSystem: {
        hostName: 'runtime-host-1',
      },
    });

    expect(getDeviceId()).toBe('custom-id');
    expect(parseBrowserInfo().browserName).toBe('InjectedBrowser');
    expect(parseOSInfo().osName).toBe('InjectedOS');
    expect(getBrowserInfo().vendor).toBe('CoverageMap');
    expect(buildDeviceResult().appName).toBe('Custom Runtime Agent');

    expect(provider.getDeviceId).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceIdStorageKey: 'custom-device-key',
        application: expect.objectContaining({
          name: 'Custom Runtime Agent',
          version: '2.0.0',
        }),
      })
    );
    expect(provider.buildDeviceResult).toHaveBeenCalledWith(
      expect.objectContaining({
        application: expect.objectContaining({
          name: 'Custom Runtime Agent',
          version: '2.0.0',
        }),
      })
    );
  });

  it('resets config while keeping provider abstraction active', () => {
    const provider: DeviceMetadataProvider = {
      reset: vi.fn(),
      getDeviceId: vi.fn().mockReturnValue('id'),
      parseBrowserInfo: vi.fn().mockReturnValue({
        browserName: 'Browser',
        browserVersion: '1.0',
        browserEngine: 'Engine',
      }),
      parseOSInfo: vi.fn().mockReturnValue({ osName: 'OS', osVersion: '1.0' }),
      getBrowserInfo: vi.fn().mockReturnValue({
        browserName: 'Browser',
        browserVersion: '1.0',
        browserEngine: 'Engine',
        platform: 'Unknown',
        language: 'unknown',
        languages: [],
        hardwareConcurrency: 0,
        deviceMemory: null,
        maxTouchPoints: 0,
        screenWidth: 0,
        screenHeight: 0,
        devicePixelRatio: 1,
        cookieEnabled: false,
        doNotTrack: null,
        vendor: '',
        isMobile: false,
      }),
      buildDeviceResult: vi.fn((config) => createDeviceResult(config)),
    };

    setDeviceMetadataProvider(provider);
    configureDeviceInfo({
      application: {
        name: 'Before Reset',
      },
    });
    expect(buildDeviceResult().appName).toBe('Before Reset');

    resetDeviceInfoConfiguration();
    expect(provider.reset).toHaveBeenCalledTimes(1);
    expect(buildDeviceResult().appName).toBe('CoverageMap Web Speed Test');
  });

  it('restores default provider after resetDeviceMetadataProvider', () => {
    const provider: DeviceMetadataProvider = {
      reset: vi.fn(),
      getDeviceId: vi.fn().mockReturnValue('id'),
      parseBrowserInfo: vi.fn().mockReturnValue({
        browserName: 'SentinelBrowser',
        browserVersion: '1.0',
        browserEngine: 'SentinelEngine',
      }),
      parseOSInfo: vi.fn().mockReturnValue({ osName: 'SentinelOS', osVersion: '1.0' }),
      getBrowserInfo: vi.fn().mockReturnValue({
        browserName: 'SentinelBrowser',
        browserVersion: '1.0',
        browserEngine: 'SentinelEngine',
        platform: 'Sentinel',
        language: 'unknown',
        languages: [],
        hardwareConcurrency: 0,
        deviceMemory: null,
        maxTouchPoints: 0,
        screenWidth: 0,
        screenHeight: 0,
        devicePixelRatio: 1,
        cookieEnabled: false,
        doNotTrack: null,
        vendor: '',
        isMobile: false,
      }),
      buildDeviceResult: vi.fn((config) => createDeviceResult(config)),
    };

    setDeviceMetadataProvider(provider);
    expect(parseBrowserInfo().browserName).toBe('SentinelBrowser');

    resetDeviceMetadataProvider();
    const restored = parseBrowserInfo().browserName;
    expect(restored).not.toBe('SentinelBrowser');
  });
});
