# Providers Guide

The engine exposes three provider hooks that let you supply context it cannot derive on its own: **where the device is**, **what kind of network it is on**, and **what the device is**. Each provider is optional — the engine has a default for all three — but they are the primary integration point when your platform or SDK has access to richer signal data than the default runtime detection can provide.

---

## Table of contents

- [Location provider](#location-provider)
- [Network provider](#network-provider)
- [Device metadata provider](#device-metadata-provider)

---

## Location provider

### What it is

The location provider tells the engine where the test device is. The engine uses those coordinates for two things: picking the nearest test server and stamping `results.location` in the result payload.

### Why it matters

Without a location provider the engine falls back to IP geolocation — the coordinates associated with the device's public IP address. That is often a city or region level approximation. If your app has access to GPS or a fine-grained location signal, wiring it through the location provider gives the engine a more accurate server selection and a more useful location record in results.

### When to use it

- Your app already requests device location (GPS, `navigator.geolocation`, a native SDK).
- You are running a field survey or a mobility test where precise coordinates matter.
- You want `results.location.locationType` to be `'device'` rather than `'ip'`.

### How to use it

Call `setLocationProvider()` on the engine after construction. Pass an async function that returns a `{ latitude, longitude }` object when coordinates are available, or `null` to let the engine fall back to IP geolocation.

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';

const engine = new SpeedTestEngine({ application: { /* ... */ } });

engine.setLocationProvider(async (_context) => {
  if (!navigator.geolocation) return null;

  try {
    const position = await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 });
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

const result = await engine.run();
console.log(result.results.location);      // coordinates from GPS
console.log(result.results.location?.locationType); // 'device'
```

The provider receives a `context` argument with `connectionInfo` — the IP connection metadata fetched at the start of the run — which you can inspect if needed but are not required to use.

### Fallback behavior

If the provider returns `null`, throws, or returns coordinates that are not finite numbers, the engine silently falls back to `connectionInfo.client` coordinates (IP geolocation). No error is emitted. `results.location.locationType` will be `'ip'` in that case.

### Updating at runtime

```ts
engine.setLocationProvider(async (_context) => {
  // new implementation
  return { latitude: 37.7749, longitude: -122.4194 };
});

// remove the provider entirely and revert to IP geolocation
engine.setLocationProvider(null);
```

---

## Network provider

### What it is

The network provider lets you tell the engine what kind of network the device is on and supply detailed signal metrics for that connection — carrier identity, band configuration, Wi-Fi SSID and signal strength, or wired link speed. This data is written into the `cellular`, `wifi`, and `wired` blocks of the result payload.

### Why it matters

The Network Information API has a limited view of the network. It can tell you the connection type (`wifi`, `mobile`, etc.) and a rough downlink estimate, but it cannot tell you the carrier name, radio band, SSID, or signal strength. If your app has access to a native SDK or modem APIs — a common pattern in mobile apps, IoT devices, or field measurement tools — the network provider is how you get that richer data into the result payload.

### When to use it

- Your app bridges to a native SDK that exposes cellular signal metrics (RSRP, RSRQ, carrier, band).
- You want to record the Wi-Fi SSID, BSSID, or channel alongside the speed result.
- The default connection type detection is wrong or unavailable in your runtime.
- You need to populate the `wired` block with interface MAC address or link speed.

### How to use it

`SpeedTestNetworkProvider` is an interface with four optional methods. Implement only the ones you need — the engine calls each one independently and falls back to its default for any method you leave out.

```ts
interface SpeedTestNetworkProvider {
  getConnectionType?(context): ConnectionType | null | Promise<ConnectionType | null>;
  getCellularMetadata?(context): Partial<NetworkTestResultCellularInfo> | null | Promise<...>;
  getWifiMetadata?(context): Partial<NetworkTestResultWiFiInfo> | null | Promise<...>;
  getWiredMetadata?(context): Partial<NetworkTestResultWiredInfo> | null | Promise<...>;
}
```

Call `setNetworkProvider()` on the engine after construction, passing an object that implements this interface:

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';
import type {
  SpeedTestNetworkProvider,
  SpeedTestNetworkProviderContext,
  NetworkTestResultCellularInfo,
  NetworkTestResultWiFiInfo,
  NetworkTestResultWiredInfo,
} from '@coveragemap/speed-test';

const engine = new SpeedTestEngine({ application: { /* ... */ } });

engine.setNetworkProvider({
  getConnectionType(context: SpeedTestNetworkProviderContext) {
    // return null to let the engine use its own detection
    return context.connectionType;
  },

  async getCellularMetadata(_context): Promise<Partial<NetworkTestResultCellularInfo> | null> {
    // pull from your native SDK or modem API
    return {
      technology: '5g',
      carrierName: 'My Carrier',
      provider: 'My MNO',
      isRoaming: false,
      rsrp: -95,
      rssi: -70,
      primaryBand: { bandNumber: 41, bandwidth: 80000, technology: '5g' },
    };
  },

  async getWifiMetadata(_context): Promise<Partial<NetworkTestResultWiFiInfo> | null> {
    return {
      ssidName: 'Office-WiFi',
      bssid: 'AA:BB:CC:DD:EE:FF',
      wifiStandard: '802.11ax',
      rssi: -48,
      channelNumber: 149,
    };
  },

  async getWiredMetadata(_context): Promise<Partial<NetworkTestResultWiredInfo> | null> {
    return {
      ispName: 'Datacenter Fiber',
      macAddress: 'AA:BB:CC:DD:EE:FF',
      dataLink: 10000,
    };
  },
});

const result = await engine.run();
console.log(result.results.connectionType);
console.log(result.results.cellular);
console.log(result.results.wifi);
console.log(result.results.wired);
```

Each method receives a `context` argument with:

- `connectionType` — what the engine detected from the runtime (`'wifi'`, `'mobile'`, `'ethernet'`, `'bluetooth'`, `'none'`, `'unknown'`)
- `connectionInfo` — the full IP connection metadata from `/v1/connection`

### Override semantics

Each method is independent:

- **Method absent** — the engine uses its default for that block.
- **Method returns `null`** — that block is forced to `null` in the payload.
- **Method returns a partial object** — your fields win, missing fields keep their defaults.

For example, implementing only `getWifiMetadata` leaves `getConnectionType`, `getCellularMetadata`, and `getWiredMetadata` at their defaults. The engine still detects the connection type and populates the cellular/wired blocks as normal for those.

### Fallback behavior

If any method throws, the engine discards the entire provider result for that run and falls back to its default network snapshot. No error is emitted.

### Updating at runtime

Swap in a new provider at any point — for example when your native SDK reports a connection change:

```ts
engine.setNetworkProvider({
  getConnectionType: () => 'wifi',
  getWifiMetadata: () => ({ ssidName: 'FieldKit-5G', channelNumber: 44 }),
});

// remove the provider and revert to default detection
engine.setNetworkProvider(null);
```

For a complete reference of all fields available on `cellular`, `wifi`, and `wired` blocks, see the [Result Schema](./result-schema.md#resultscellular-resultswifi-and-resultswired).

---

## Device metadata provider

### What it is

The device metadata provider controls how the engine identifies the device and assembles the `device` block in the result payload — things like device ID, browser name, OS, connection type, and host telemetry.

### Why it matters

The built-in provider (`DefaultDeviceMetadataProvider`) reads from the available runtime APIs — `navigator.userAgent`, `localStorage`, and the Network Information API where present, and Node.js `process` fields in server environments. That works for standard web and Node.js runtimes. It does not work well in Electron's main process, React Native, Capacitor, a WebView without `localStorage`, or any other hybrid or embedded environment where those APIs are absent, restricted, or report incorrect values.

### When to use it

- Your app runs in Electron and `navigator` or `localStorage` are not available in your context.
- You are integrating in React Native or a native WebView bridge.
- You have a stable device identifier from your own persistence layer and want to use it instead of the auto-generated UUID.
- The default OS or runtime detection reports wrong values for your environment.

### How to use it

Implement the `DeviceMetadataProvider` interface and register it with `setDeviceMetadataProvider()` before calling `run()`.

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';
import type {
  DeviceMetadataProvider,
  DeviceMetadataProviderConfig,
  ParsedBrowserInfo,
  ParsedOSInfo,
  BrowserInfo,
  NetworkTestResultDevice,
} from '@coveragemap/speed-test';

class MyRuntimeProvider implements DeviceMetadataProvider {
  reset(): void {}

  getDeviceId(_config: DeviceMetadataProviderConfig): string {
    // use your own stable identifier — from a keychain, config file, etc.
    return 'my-stable-device-id';
  }

  parseBrowserInfo(): ParsedBrowserInfo {
    return {
      browserName: 'MyApp',
      browserVersion: '2.0.0',
      browserEngine: 'Unknown',
    };
  }

  parseOSInfo(): ParsedOSInfo {
    return {
      osName: process.platform,
      osVersion: process.version,
    };
  }

  getBrowserInfo(): BrowserInfo {
    return {
      browserName: 'MyApp',
      browserVersion: '2.0.0',
      browserEngine: 'Unknown',
      platform: process.platform,
      language: 'en',
      languages: ['en'],
      hardwareConcurrency: 0,
      deviceMemory: null,
      maxTouchPoints: 0,
      cookieEnabled: false,
      vendor: '',
      isMobile: false,
    };
  }

  buildDeviceResult(config: DeviceMetadataProviderConfig): NetworkTestResultDevice {
    const { browserName, browserVersion, browserEngine } = this.parseBrowserInfo();
    const { osName, osVersion } = this.parseOSInfo();
    return {
      id: this.getDeviceId(config),
      manufacturer: 'Unknown',
      nameId: null,
      name: `MyApp ${config.application.version}`,
      os: osName as any,
      osVersion,
      appName: config.application.name,
      appVersion: config.application.version,
      application: { ...config.application },
      browserName,
      browserVersion,
      browserEngine,
      browserEngineVersion: null,
      cpuArchitecture: process.arch ?? null,
      cpuCores: null,
      deviceMemoryGb: null,
      deviceType: 'desktop',
      deviceVendor: null,
      deviceModel: null,
      isMobile: false,
      language: null,
      timezone: Intl?.DateTimeFormat?.()?.resolvedOptions?.()?.timeZone ?? null,
      coreSystem: null,
    };
  }
}

const engine = new SpeedTestEngine({
  application: {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'My App',
    version: '2.0.0',
    organization: 'My Org',
    type: 'desktop',
  },
});

engine.setDeviceMetadataProvider(new MyRuntimeProvider());

const result = await engine.run();
```

### Lighter-weight alternative: coreSystem overrides

If you only need to annotate host-level fields (hostname, platform, process ID) without replacing the full provider — a common need in Node.js workers and backend agents — use `options.deviceInfo.coreSystem` instead:

```ts
const engine = new SpeedTestEngine({
  application: { /* ... */ },
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
```

These values are merged onto the auto-detected `device.coreSystem` block. You do not need to implement the full interface for this use case.

### Restoring the default provider

```ts
engine.resetDeviceMetadataProvider();
```

Discards any custom provider and re-registers the built-in `DefaultDeviceMetadataProvider` for all subsequent `run()` calls.

---

## See also

- [Library API](./library-api.md) — Full type reference for all provider interfaces and engine methods
- [Result Schema](./result-schema.md) — Complete result payload field reference including `cellular`, `wifi`, and `wired` block schemas
- [Examples](./examples.md) — Runnable examples for location binding, network metadata overrides, and custom device providers
- [Backend Integration](./backend-integration.md) — Guidance for running the engine in Node.js server contexts
