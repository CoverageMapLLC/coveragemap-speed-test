import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDeviceResult,
  configureDeviceInfo,
  getDeviceId,
  resetDeviceMetadataProvider,
  resetDeviceInfoConfiguration,
} from '../src/utils/device-info.js';

describe('device info runtime support', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetDeviceMetadataProvider();
    resetDeviceInfoConfiguration();
  });

  it('builds backend-safe device payload when browser globals are unavailable', () => {
    vi.stubGlobal('window', undefined as unknown as Window);
    vi.stubGlobal('document', undefined as unknown as Document);
    vi.stubGlobal('navigator', undefined as unknown as Navigator);
    vi.stubGlobal('screen', undefined as unknown as Screen);
    vi.stubGlobal('localStorage', undefined as unknown as Storage);

    configureDeviceInfo({
      application: {
        name: 'Backend Speed Runner',
      },
      coreSystem: {
        hostName: 'backend-node-1',
      },
    });

    const result = buildDeviceResult();

    expect(result.appName).toBe('Backend Speed Runner');
    expect(result.browserName).toBe('Node.js');
    expect(result.deviceType).toBe('server');
    expect(result.coreSystem?.runtime).toBe('node');
    expect(result.coreSystem?.hostName).toBe('backend-node-1');
  });

  it('captures core system override fields in result payload', () => {
    configureDeviceInfo({
      coreSystem: {
        hostName: 'speed-runner-2',
        processId: 999,
      },
    });

    const result = buildDeviceResult();
    expect(result.coreSystem?.hostName).toBe('speed-runner-2');
    expect(result.coreSystem?.processId).toBe(999);
  });

  it('keeps a stable in-memory device id when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined as unknown as Storage);

    const first = getDeviceId();
    const second = getDeviceId();
    expect(first).toBe(second);
  });

  it('resets runtime overrides with resetDeviceInfoConfiguration', () => {
    configureDeviceInfo({
      application: {
        name: 'Custom App',
      },
      coreSystem: { hostName: 'custom-host' },
    });
    expect(buildDeviceResult().appName).toBe('Custom App');

    resetDeviceInfoConfiguration();
    const result = buildDeviceResult();
    expect(result.appName).toBe('CoverageMap Web Speed Test');
    expect(result.coreSystem?.hostName).not.toBe('custom-host');
  });
});
