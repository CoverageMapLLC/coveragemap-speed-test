import { UAParser } from 'ua-parser-js';
import type {
  BrowserInfo,
  DeviceOS,
  NetworkTestResultApplicationInfo,
  NetworkTestResultCoreSystemInfo,
  NetworkTestResultDevice,
  RuntimeType,
} from '../types/test-results.js';
import { generateUUID } from './uuid.js';

interface NavigatorConnection {
  type?: string;
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

export interface CoreSystemOverrides {
  hostName?: string | null;
  processId?: number | null;
  platform?: string | null;
  architecture?: string | null;
  runtimeVersion?: string | null;
  uptimeSeconds?: number | null;
  memoryRssMb?: number | null;
}

export interface DeviceMetadataProviderConfig {
  deviceIdStorageKey: string;
  application: NetworkTestResultApplicationInfo;
  coreSystem: CoreSystemOverrides;
}

export interface ParsedBrowserInfo {
  browserName: string;
  browserVersion: string;
  browserEngine: string;
}

export interface ParsedOSInfo {
  osName: string;
  osVersion: string;
}

export interface DeviceMetadataProvider {
  reset(): void;
  getDeviceId(config: DeviceMetadataProviderConfig): string;
  parseBrowserInfo(): ParsedBrowserInfo;
  parseOSInfo(): ParsedOSInfo;
  getBrowserInfo(): BrowserInfo;
  buildDeviceResult(config: DeviceMetadataProviderConfig): NetworkTestResultDevice;
}

export class DefaultDeviceMetadataProvider implements DeviceMetadataProvider {
  private inMemoryDeviceId: string | null = null;
  private cachedParser: UAParser | null = null;

  reset(): void {
    this.inMemoryDeviceId = null;
    this.cachedParser = null;
  }

  getDeviceId(config: DeviceMetadataProviderConfig): string {
    const storage = this.getLocalStorageSafe();
    if (!storage) {
      if (!this.inMemoryDeviceId) {
        this.inMemoryDeviceId = generateUUID();
      }
      return this.inMemoryDeviceId;
    }

    try {
      let id = storage.getItem(config.deviceIdStorageKey);
      if (!id) {
        id = generateUUID();
        storage.setItem(config.deviceIdStorageKey, id);
      }
      return id;
    } catch {
      if (!this.inMemoryDeviceId) {
        this.inMemoryDeviceId = generateUUID();
      }
      return this.inMemoryDeviceId;
    }
  }

  parseBrowserInfo(): ParsedBrowserInfo {
    const parser = this.getParser();
    if (!parser) {
      return {
        browserName: 'Unknown',
        browserVersion: 'unknown',
        browserEngine: 'Unknown',
      };
    }

    const browser = parser.getBrowser();
    const engine = parser.getEngine();
    return {
      browserName: browser.name ?? 'Unknown',
      browserVersion: browser.version ?? 'unknown',
      browserEngine: engine.name ?? 'Unknown',
    };
  }

  parseOSInfo(): ParsedOSInfo {
    const parser = this.getParser();
    if (!parser) {
      if (typeof process !== 'undefined' && !!process.versions?.node) {
        return {
          osName: process.platform,
          osVersion: process.version,
        };
      }

      return {
        osName: 'Unknown',
        osVersion: '',
      };
    }

    const os = parser.getOS();
    return {
      osName: os.name ?? 'Unknown',
      osVersion: os.version ?? '',
    };
  }

  getBrowserInfo(): BrowserInfo {
    const nav = this.getNavigatorSafe();
    const { browserName, browserVersion, browserEngine } = this.parseBrowserInfo();
    const parser = this.getParser();
    const device = parser?.getDevice();

    return {
      browserName,
      browserVersion,
      browserEngine,
      platform: parser?.getOS().name ?? nav?.platform ?? 'Unknown',
      language: nav?.language ?? 'unknown',
      languages: nav?.languages ? [...nav.languages] : [],
      hardwareConcurrency: nav?.hardwareConcurrency ?? 0,
      deviceMemory: nav?.deviceMemory ?? null,
      maxTouchPoints: nav?.maxTouchPoints ?? 0,
      cookieEnabled: nav?.cookieEnabled ?? false,
      vendor: nav?.vendor ?? '',
      isMobile: device?.type === 'mobile' || device?.type === 'tablet',
    };
  }

  buildDeviceResult(config: DeviceMetadataProviderConfig): NetworkTestResultDevice {
    const runtime = this.getRuntimeType();
    const nav = this.getNavigatorSafe();
    const parser = this.getParser();
    const browser = parser?.getBrowser();
    const engine = parser?.getEngine();
    const os = parser?.getOS();
    const cpu = parser?.getCPU();
    const device = parser?.getDevice();
    const isMobile = device?.type === 'mobile' || device?.type === 'tablet';
    const coreSystem = this.buildCoreSystemInfo(runtime, config.coreSystem);

    const browserName = browser?.name ?? (runtime === 'node' ? 'Node.js' : null);
    const browserVersion = browser?.version ?? (runtime === 'node' ? process.version : null);
    const browserEngine = engine?.name ?? (runtime === 'node' ? 'V8' : null);
    const browserEngineVersion = engine?.version ?? null;
    const osName = os?.name ?? (runtime === 'node' ? process.platform : 'Unknown');
    const osVersion = os?.version ?? (runtime === 'node' ? process.version : '');

    return {
      id: this.getDeviceId(config),
      manufacturer: engine?.name ?? (runtime === 'node' ? 'Node.js' : 'Unknown'),
      nameId: nav?.userAgent ?? coreSystem?.hostName ?? null,
      name:
        runtime === 'node'
          ? `Node ${process.version}`
          : `${browser?.name ?? 'Unknown'} ${browser?.version ?? 'unknown'}`,
      os: this.mapDeviceOS(osName),
      osVersion,
      appName: config.application.name,
      appVersion: config.application.version,
      application: { ...config.application },

      browserName,
      browserVersion,
      browserEngine,
      browserEngineVersion,

      cpuArchitecture: cpu?.architecture ?? coreSystem?.architecture ?? null,
      cpuCores: nav?.hardwareConcurrency ?? null,
      deviceMemoryGb: nav?.deviceMemory ?? null,
      deviceType: isMobile ? (device?.type ?? 'mobile') : runtime === 'node' ? 'server' : 'desktop',
      deviceVendor: device?.vendor ?? null,
      deviceModel: device?.model ?? null,
      isMobile,

      language: nav?.language ?? null,
      timezone: Intl?.DateTimeFormat?.()?.resolvedOptions?.()?.timeZone ?? null,
      coreSystem,
    };
  }

  private getRuntimeType(): RuntimeType {
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      return 'browser';
    }

    if (typeof process !== 'undefined' && !!process.versions?.node) {
      return 'node';
    }

    return 'unknown';
  }

  private getNavigatorSafe():
    | (Navigator & {
        connection?: NavigatorConnection;
        deviceMemory?: number;
      })
    | null {
    if (typeof navigator === 'undefined') return null;
    return navigator as Navigator & {
      connection?: NavigatorConnection;
      deviceMemory?: number;
    };
  }

  private getNavigatorConnection(): NavigatorConnection | undefined {
    return this.getNavigatorSafe()?.connection;
  }

  private getLocalStorageSafe(): Storage | null {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  }

  private getParser(): UAParser | null {
    if (this.getRuntimeType() !== 'browser') {
      return null;
    }

    const nav = this.getNavigatorSafe();
    if (!nav?.userAgent) {
      return null;
    }

    if (!this.cachedParser) {
      this.cachedParser = new UAParser(nav.userAgent);
    }
    return this.cachedParser;
  }

  private mapDeviceOS(osName: string): DeviceOS {
    const lower = osName.toLowerCase();
    if (lower === 'windows' || lower === 'win32') return 'windows';
    if (lower === 'mac os' || lower === 'macos' || lower === 'darwin') return 'mac';
    if (lower.includes('linux') && !lower.includes('android')) return 'linux';
    if (lower === 'chromium os' || lower === 'chrome os') return 'chromeos';
    if (lower === 'ios') return 'iOS';
    if (lower === 'android') return 'android';
    return 'web';
  }

  private buildCoreSystemInfo(
    runtime: RuntimeType,
    overrides: CoreSystemOverrides
  ): NetworkTestResultCoreSystemInfo | null {
    const processObj = typeof process !== 'undefined' ? process : undefined;

    const defaultInfo: NetworkTestResultCoreSystemInfo = {
      runtime,
      hostName: processObj?.env?.HOSTNAME ?? processObj?.env?.COMPUTERNAME ?? null,
      processId: typeof processObj?.pid === 'number' ? processObj.pid : null,
      platform: processObj?.platform ?? null,
      architecture: processObj?.arch ?? null,
      runtimeVersion: processObj?.version ?? null,
      uptimeSeconds: typeof processObj?.uptime === 'function' ? processObj.uptime() : null,
      memoryRssMb: null,
    };

    if (typeof processObj?.memoryUsage === 'function') {
      try {
        defaultInfo.memoryRssMb = Math.round(processObj.memoryUsage().rss / (1024 * 1024));
      } catch {
        defaultInfo.memoryRssMb = null;
      }
    }

    return {
      ...defaultInfo,
      ...overrides,
    };
  }
}
