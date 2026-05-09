import type {
  BrowserInfo,
  NetworkTestResultApplicationInfo,
  NetworkTestResultDevice,
} from '../types/test-results.js';
import {
  DefaultDeviceMetadataProvider,
  type CoreSystemOverrides,
  type DeviceMetadataProvider,
  type DeviceMetadataProviderConfig,
  type ParsedBrowserInfo,
  type ParsedOSInfo,
} from './device-metadata-provider.js';

const DEFAULT_DEVICE_INFO_CONFIG = {
  deviceIdStorageKey: 'coveragemap-device-id',
  application: {
    id: 'unknown',
    name: 'CoverageMap Web Speed Test',
    version: '1.0.0',
    organization: 'Unknown',
    type: 'other',
    website: null,
  } as NetworkTestResultApplicationInfo,
  coreSystem: {} as CoreSystemOverrides,
};

export interface DeviceInfoConfigOverrides {
  deviceIdStorageKey?: string;
  application?: Partial<NetworkTestResultApplicationInfo>;
  /** @deprecated Use `application.name` instead. */
  appName?: string;
  /** @deprecated Use `application.version` instead. */
  appVersion?: string;
  coreSystem?: CoreSystemOverrides;
}

let deviceInfoConfig = { ...DEFAULT_DEVICE_INFO_CONFIG };
let deviceMetadataProvider: DeviceMetadataProvider = new DefaultDeviceMetadataProvider();

function getProviderConfig(): DeviceMetadataProviderConfig {
  return {
    deviceIdStorageKey: deviceInfoConfig.deviceIdStorageKey,
    application: { ...deviceInfoConfig.application },
    coreSystem: { ...deviceInfoConfig.coreSystem },
  };
}

export function setDeviceMetadataProvider(provider: DeviceMetadataProvider): void {
  deviceMetadataProvider = provider;
}

export function resetDeviceMetadataProvider(): void {
  deviceMetadataProvider = new DefaultDeviceMetadataProvider();
}

export function configureDeviceInfo(overrides?: DeviceInfoConfigOverrides): void {
  if (!overrides) return;
  const mergedApplication = {
    ...deviceInfoConfig.application,
    ...overrides.application,
    name:
      overrides.appName ??
      overrides.application?.name ??
      deviceInfoConfig.application.name,
    version:
      overrides.appVersion ??
      overrides.application?.version ??
      deviceInfoConfig.application.version,
  };

  deviceInfoConfig = {
    deviceIdStorageKey: overrides.deviceIdStorageKey ?? deviceInfoConfig.deviceIdStorageKey,
    application: mergedApplication,
    coreSystem: { ...deviceInfoConfig.coreSystem, ...overrides.coreSystem },
  };
}

export function resetDeviceInfoConfiguration(): void {
  deviceInfoConfig = { ...DEFAULT_DEVICE_INFO_CONFIG };
  deviceMetadataProvider.reset();
}

export function getDeviceId(): string {
  return deviceMetadataProvider.getDeviceId(getProviderConfig());
}

export function parseBrowserInfo(): ParsedBrowserInfo {
  return deviceMetadataProvider.parseBrowserInfo();
}

export function parseOSInfo(): ParsedOSInfo {
  return deviceMetadataProvider.parseOSInfo();
}

export function getBrowserInfo(): BrowserInfo {
  return deviceMetadataProvider.getBrowserInfo();
}

export function buildDeviceResult(): NetworkTestResultDevice {
  return deviceMetadataProvider.buildDeviceResult(getProviderConfig());
}

export type {
  CoreSystemOverrides,
  DeviceMetadataProvider,
  DeviceMetadataProviderConfig,
  ParsedBrowserInfo,
  ParsedOSInfo,
};
export { DefaultDeviceMetadataProvider };
