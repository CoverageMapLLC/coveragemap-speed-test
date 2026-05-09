# Examples

Practical, production-oriented code for common integration patterns. Each section covers a specific concern — start with [Basic usage](#basic-usage) if you're new to the library.

---

## Table of contents

- [Basic usage](#basic-usage)
  - [Minimal run](#minimal-run)
  - [Live progress callbacks](#live-progress-callbacks)
  - [Run with location binding](#run-with-location-binding)
  - [Run with network metadata overrides](#run-with-network-metadata-overrides)
- [Server selection](#server-selection)
  - [Nearest server via IP location](#nearest-server-via-ip-location)
  - [Nearest server via geolocation](#nearest-server-via-geolocation)
  - [Server list without SpeedTestEngine](#server-list-without-speedtestengine)
- [Test configuration](#test-configuration)
  - [Latency only](#latency-only)
  - [Upload only](#upload-only)
- [Device metadata](#device-metadata)
  - [Custom device identity key](#custom-device-identity-key)
  - [Custom DeviceMetadataProvider](#custom-devicemetadataprovider)
  - [Backend runner with runtime overrides](#backend-runner-with-runtime-overrides)
- [Runtime environment](#runtime-environment)
  - [Node.js WebSocket bootstrap](#nodejs-websocket-bootstrap)
- [Full runnable app](#full-runnable-app)

---

## Basic usage

### Minimal run

The simplest setup — create an engine, run it, read the results.

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';
import type { NetworkTestResultTestResults } from '@coveragemap/speed-test';

async function runSingleTest(): Promise<void> {
  const engine = new SpeedTestEngine({
    application: {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      name: 'CoverageMap Web Console',
      version: '2.8.0',
      organization: 'CoverageMap',
      type: 'web',
    },
  });

  const result: NetworkTestResultTestResults = await engine.run();
  console.log('download Mbps', result.results.measurements.downloadSpeed);
  console.log('upload Mbps', result.results.measurements.uploadSpeed);
  console.log('latency ms', result.results.measurements.latency);
}

runSingleTest().catch((error: Error) => {
  console.error('Speed test failed', error.message);
});
```

---

### Live progress callbacks

Wire callbacks at construction time to receive per-ping latency, mid-run throughput snapshots, and per-stage final results — useful for driving a real-time UI.

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';
import type {
  SpeedTestStage,
  LatencyTestData,
  SpeedSnapshot,
  SpeedTestData,
  NetworkTestResultTestResults,
} from '@coveragemap/speed-test';

const engine = new SpeedTestEngine({
  application: {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'CoverageMap Web Console',
    version: '2.8.0',
    organization: 'CoverageMap',
    type: 'web',
  },
  callbacks: {
    onStageChange: (stage: SpeedTestStage) => {
      console.log('stage →', stage);
    },

    // fires for each individual ping during the latency stage
    onLatencyPing: (latencyMs: number, index: number) => {
      console.log(`ping ${index}: ${latencyMs} ms`);
    },
    // fires once with the full aggregated latency result
    onLatencyResult: (latency: LatencyTestData) => {
      console.log('avg latency', latency.avgLatency, 'ms / jitter', latency.avgJitter, 'ms');
    },

    // fires periodically during the download stage
    onDownloadProgress: (snapshot: SpeedSnapshot) => {
      console.log('download', snapshot.speedMbps, 'Mbps');
    },
    // fires once when the download stage finishes
    onDownloadResult: (data: SpeedTestData) => {
      console.log('download complete:', data.speedMbps, 'Mbps');
    },

    // fires periodically during the upload stage
    onUploadProgress: (snapshot: SpeedSnapshot) => {
      console.log('upload', snapshot.speedMbps, 'Mbps');
    },
    // fires once when the upload stage finishes
    onUploadResult: (data: SpeedTestData) => {
      console.log('upload complete:', data.speedMbps, 'Mbps');
    },

    onError: (error: Error, stage: SpeedTestStage) => {
      console.error(`error in ${stage}:`, error.message);
    },
    onComplete: (download: number, upload: number, latency: number) => {
      console.log('all stages done', { download, upload, latency });
    },
  },
});

const result: NetworkTestResultTestResults = await engine.run();
```

---

### Run with location binding

Register a location provider via `setLocationProvider()` so `run()` resolves coordinates as needed and **binds** them to the payload: `results.location`, each `stages[]` row, and the uploaded result. Values from the provider use `locationType: 'device'`. If the provider returns `null` or throws, the engine uses IP geolocation from `getConnectionInfo()` instead (`locationType: 'ip'`). The same resolved position is also used to pick the nearest server when you call `run()` with no server argument.

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';
import type { NetworkTestResultTestResults } from '@coveragemap/speed-test';

async function runWithBoundLocation(): Promise<void> {
  const engine = new SpeedTestEngine({
    application: {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      name: 'CoverageMap Web Console',
      version: '2.8.0',
      organization: 'CoverageMap',
      type: 'web',
    },
  });

  engine.setLocationProvider(async (_context) => {
    if (!navigator.geolocation) return null;

    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: 5000,
          maximumAge: 0,
        });
      });

      return {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        elevation: position.coords.altitude,
        heading: position.coords.heading,
        speed: position.coords.speed,
      };
    } catch {
      return null;
    }
  });

  const result: NetworkTestResultTestResults = await engine.run();

  console.log('results.location', result.results.location);
  console.log('first stage location', result.stages?.[0]?.location);
}

runWithBoundLocation().catch((error: Error) => {
  console.error('Speed test failed', error.message);
});
```

To prefetch the server list or pass a chosen server to `run()`, see [Server selection](#server-selection).

---

### Run with network metadata overrides

Use `setNetworkProvider()` to override network determination and populate custom `cellular`, `wifi`, and `wired` payload blocks. `SpeedTestNetworkProvider` is an interface with four optional methods — implement only the ones relevant to your platform SDK.

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';
import type {
  NetworkTestResultTestResults,
  SpeedTestNetworkProvider,
  NetworkTestResultCellularInfo,
  NetworkTestResultWiFiInfo,
  NetworkTestResultWiredInfo,
} from '@coveragemap/speed-test';

const engine = new SpeedTestEngine({
  application: {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'CoverageMap Native Bridge',
    version: '3.2.1',
    organization: 'CoverageMap',
    type: 'mobile',
  },
});

const networkProvider: SpeedTestNetworkProvider = {
  getConnectionType(context) {
    // return null to let the engine use its own detection
    return context.connectionType;
  },

  async getCellularMetadata(): Promise<Partial<NetworkTestResultCellularInfo> | null> {
    // map metrics from your native SDK / modem API
    return {
      technology: '5g',
      mccCode: '310',
      mncCode: '260',
      countryIso: 'us',
      carrierName: 'MVNO A',
      provider: 'MNO A',
      isRoaming: false,
      rsrp: -95,
      rsrq: -12,
      rssi: -70,
      sinr: 18,
      primaryBand: { bandNumber: 12, bandwidth: 100000, technology: '4g' },
      secondaryBands: [
        { bandNumber: 41, bandwidth: 80000, technology: '5g' },
        { bandNumber: 78, bandwidth: 60000, technology: '5g' },
      ],
    };
  },

  async getWifiMetadata(): Promise<Partial<NetworkTestResultWiFiInfo> | null> {
    return {
      ssidName: 'Office-WiFi',
      bssid: 'AA:BB:CC:DD:EE:FF',
      ispName: 'Fiber ISP',
      wifiStandard: '802.11ax',
      txRate: 1200,
      rxRate: 960,
      rssi: -48,
      sinr: 34,
      noise: -90,
      channelNumber: 149,
    };
  },

  async getWiredMetadata(): Promise<Partial<NetworkTestResultWiredInfo> | null> {
    return {
      ispName: 'Datacenter Ethernet',
      macAddress: 'AA:BB:CC:DD:EE:FF',
      dataLink: 10000,
    };
  },
};

engine.setNetworkProvider(networkProvider);

const result: NetworkTestResultTestResults = await engine.run();

console.log(result.results.connectionType);
console.log(result.results.cellular);
console.log(result.results.wifi);
console.log(result.results.wired);
```

Swap implementations at runtime — for example when your native SDK reports a connection change:

```ts
engine.setNetworkProvider({
  getConnectionType: () => 'wifi',
  getWifiMetadata: () => ({ ssidName: 'FieldKit', channelNumber: 44 }),
});
```

---

## Server selection

### Nearest server via IP location

By defatul (without a `locationProvider`), `getServers()` ranks endpoints using coordinates from `getConnectionInfo()` (IP-based client location from the Speed API). Fetch the ordered list, then pass the first entry to `run()` (or call `run()` with no arguments — the engine uses the same list ordering internally).

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';
import type {
  SpeedTestServer,
  NetworkTestResultTestResults,
} from '@coveragemap/speed-test';

const engine = new SpeedTestEngine({
  application: {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'CoverageMap Web Console',
    version: '2.8.0',
    organization: 'CoverageMap',
    type: 'web',
  },
});

const servers: SpeedTestServer[] = await engine.getServers();

// servers[0] is nearest for IP-derived coordinates
const result: NetworkTestResultTestResults = await engine.run(servers[0]);
```

---

### Nearest server via geolocation

Call `setLocationProvider()` so server ranking and result `locationType` use device coordinates. When the provider returns `null` or throws, behavior matches [Nearest server via IP location](#nearest-server-via-ip-location).

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';
import type {
  SpeedTestServer,
  NetworkTestResultTestResults,
} from '@coveragemap/speed-test';

const engine = new SpeedTestEngine({
  application: {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'CoverageMap Web Console',
    version: '2.8.0',
    organization: 'CoverageMap',
    type: 'web',
  },
});

engine.setLocationProvider(async (_context) => {
  if (!navigator.geolocation) return null;

  try {
    const position = await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        timeout: 5000,
        maximumAge: 0,
      });
    });

    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      elevation: position.coords.altitude,
      heading: position.coords.heading,
      speed: position.coords.speed,
    };
  } catch {
    return null;
  }
});

const servers: SpeedTestServer[] = await engine.getServers();

// servers[0] is nearest based on GPS when available, else IP coordinates
const result: NetworkTestResultTestResults = await engine.run(servers[0]);
```

---

### Speed Test Server List

Use [`SpeedTestApiClient`](library-api.md#speedtestapiclient) when you only need discovery data (or connection metadata) and do not want to configure `SpeedTestEngine` application metadata. It calls the same Speed HTTP endpoints, applies the same 30‑minute server cache, and resolves location the same way: `setLocationProvider()` for device coordinates, otherwise IP coordinates via `getConnectionInfo()`.

```ts
import { SpeedTestApiClient } from '@coveragemap/speed-test';
import type { SpeedTestServer } from '@coveragemap/speed-test';

const speedApi = new SpeedTestApiClient();
const servers: SpeedTestServer[] = await speedApi.getServers();

console.log('nearest id', servers[0]?.id, servers[0]?.name);
```

Pass optional base URL overrides as the constructor argument. The same override object is accepted on `SpeedTestEngine` via `api`. For `refreshServers()`, `getConnectionInfo()`, and lookup by id, see [SpeedTestApiClient](library-api.md#speedtestapiclient).

---

## Test configuration

### Latency only

Disable the throughput stages when you only need RTT and jitter measurements.

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';
import type { NetworkTestResultTestResults } from '@coveragemap/speed-test';

const engine = new SpeedTestEngine({
  application: {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'CoverageMap Web Console',
    version: '2.8.0',
    organization: 'CoverageMap',
    type: 'web',
  },
  tests: {
    latency: true,
    download: false,
    upload: false,
  },
});

const result: NetworkTestResultTestResults = await engine.run();
```

---

### Upload only

Measure upstream throughput without a download or latency stage. A single baseline ping is still performed automatically to condition the upload stage.

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';
import type { NetworkTestResultTestResults } from '@coveragemap/speed-test';

const engine = new SpeedTestEngine({
  application: {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'CoverageMap Web Console',
    version: '2.8.0',
    organization: 'CoverageMap',
    type: 'web',
  },
  tests: {
    latency: false,
    download: false,
    upload: true,
  },
});

const result: NetworkTestResultTestResults = await engine.run();
```

---

## Device metadata

### Custom device identity key

By default the engine stores the persistent device ID under an internal `localStorage` key. Override it when multiple speed-test products share the same origin and need separate identities.

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';

const engine = new SpeedTestEngine({
  application: {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'CoverageMap Enterprise Console',
    version: '2.3.0',
    organization: 'CoverageMap',
    type: 'web',
  },
  deviceInfo: {
    deviceIdStorageKey: 'cm-enterprise-device-id',
  },
});
```

---

### Custom DeviceMetadataProvider

The built-in provider uses browser APIs (`navigator`, `localStorage`, Network Information API). Replace it when those APIs are unavailable or misleading — common in Electron, React Native, or server-side runners.

Implement the `DeviceMetadataProvider` interface and call `setDeviceMetadataProvider()` before `run()`.

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';
import type {
  DeviceMetadataProvider,
  DeviceMetadataProviderConfig,
  ParsedBrowserInfo,
  ParsedOSInfo,
  BrowserInfo,
  NetworkTestResultDevice,
  NetworkTestResultTestResults,
} from '@coveragemap/speed-test';

class ElectronDeviceProvider implements DeviceMetadataProvider {
  reset(): void {}

  getDeviceId(_config: DeviceMetadataProviderConfig): string {
    // Read or generate a stable ID from a config file / keychain
    return 'my-stable-device-id';
  }

  parseBrowserInfo(): ParsedBrowserInfo {
    return { name: 'Electron', version: process.versions.electron ?? null };
  }

  parseOSInfo(): ParsedOSInfo {
    return { name: process.platform, version: null };
  }

  getBrowserInfo(): BrowserInfo {
    return {
      userAgent: navigator.userAgent,
      language: navigator.language,
      cookiesEnabled: false,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  buildDeviceResult(config: DeviceMetadataProviderConfig): NetworkTestResultDevice {
    return {
      deviceId: this.getDeviceId(config),
      browser: this.parseBrowserInfo(),
      os: this.parseOSInfo(),
    };
  }
}

const engine = new SpeedTestEngine({
  application: {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'CoverageMap Desktop',
    version: '1.0.0',
    organization: 'CoverageMap',
    type: 'desktop',
  },
});

engine.setDeviceMetadataProvider(new ElectronDeviceProvider());

const result: NetworkTestResultTestResults = await engine.run();

// Revert to the built-in browser provider at any point
engine.resetDeviceMetadataProvider();
```

---

### Backend runner with runtime overrides

For Node workers and agents, use `deviceInfo.coreSystem` to supply host-level fields without implementing the full `DeviceMetadataProvider` interface.

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';
import type { NetworkTestResultTestResults } from '@coveragemap/speed-test';

const engine = new SpeedTestEngine({
  application: {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'CoverageMap Backend Speed Agent',
    version: '1.0.0',
    organization: 'CoverageMap',
    type: 'backend',
    website: 'https://coveragemap.com',
  },
  deviceInfo: {
    coreSystem: {
      hostName: process.env.HOSTNAME ?? null,
      processId: process.pid,
      platform: process.platform,
      architecture: process.arch,
      runtimeVersion: process.version,
    },
  },
});

const result: NetworkTestResultTestResults = await engine.run();
```

---

## Runtime environment

### Node.js WebSocket bootstrap

The protocol runners rely on `globalThis.WebSocket`. Node 22+ ships it natively; for older runtimes, polyfill it once at app startup before importing the engine.

```ts
import { WebSocket } from 'ws';

// must run before any SpeedTestEngine usage
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
```

---

## Full runnable app

A complete React + Vite integration lives in [`demos/react-vite`](../demos/react-vite).
