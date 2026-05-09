# Result Schema Reference

This document explains the `NetworkTestResultTestResults` payload in practical terms.
Use it when integrating storage, analytics, or downstream reporting.

The canonical definitions live in the package source: [`src/types/test-results.ts`](../src/types/test-results.ts) and [`src/types/speed-server.ts`](../src/types/speed-server.ts) (for `SpeedTestServer`).

## Shared types

These aliases appear on multiple interfaces:

```ts
type DeviceOS =
  | 'iOS'
  | 'android'
  | 'iPadOS'
  | 'windows'
  | 'mac'
  | 'linux'
  | 'chromeos'
  | 'web';

type TestStatus = 'passed' | 'failed';

type TestTypeSingleMultiple = 'single' | 'multiple';

type LocationTag = 'indoor' | 'outdoor' | 'driving' | 'other';

type LocationType = 'device' | 'ip';

type TestStage =
  | 'latencyStart'
  | 'downloadStart'
  | 'downloadEnd'
  | 'uploadStart'
  | 'uploadEnd';

type ConnectionType = 'wifi' | 'mobile' | 'ethernet' | 'bluetooth' | 'none' | 'unknown';

type RuntimeType = 'browser' | 'node' | 'unknown';

type ApplicationType = 'web' | 'backend' | 'mobile' | 'desktop' | 'cli' | 'serverless' | 'other';
```

## Top-level shape

```ts
interface NetworkTestResultTestResults {
  version: number;
  device: NetworkTestResultDevice;
  testType: NetworkTestResultTestType;
  results: NetworkTestResultResults;
  stages: NetworkTestResultStage[] | null;
}
```

### `version`

- Schema version for compatibility tracking.
- Current value is `1`.
- Consumers should store this and gate parsing logic by version for future-proofing.

## `device`

Device/runtime metadata captured at run time.

```ts
interface NetworkTestResultDevice {
  id: string | null;
  manufacturer: string;
  nameId: string | null;
  name: string;
  os: DeviceOS;
  osVersion: string;
  appName: string | null;
  appVersion: string | null;
  application: NetworkTestResultApplicationInfo;

  browserName: string | null;
  browserVersion: string | null;
  browserEngine: string | null;
  browserEngineVersion: string | null;

  cpuArchitecture: string | null;
  cpuCores: number | null;
  deviceMemoryGb: number | null;
  deviceType: string | null;
  deviceVendor: string | null;
  deviceModel: string | null;
  isMobile: boolean;

  language: string | null;
  timezone: string | null;
  coreSystem: NetworkTestResultCoreSystemInfo | null;
}
```

Important categories:

- app identity (`appName`, `appVersion`, `application`),
- browser/device data when available,
- backend/runtime system data under `coreSystem` (null in environments where it is not collected).

### `device.application` (required)

Captured from `SpeedTestEngineOptions.application`. Shape:

```ts
interface NetworkTestResultApplicationInfo {
  id: string;
  name: string;
  version: string;
  organization: string;
  type: ApplicationType | (string & {});
  website: string | null;
}
```

This object is the canonical application attribution block used for CoverageMap analytics/metrics segmentation.

### `device.coreSystem` (nullable)

Present for runtime/system telemetry and especially valuable outside browsers.

```ts
interface NetworkTestResultCoreSystemInfo {
  runtime: RuntimeType;
  hostName: string | null;
  processId: number | null;
  platform: string | null;
  architecture: string | null;
  runtimeVersion: string | null;
  uptimeSeconds: number | null;
  memoryRssMb: number | null;
}
```

## `testType`

Describes execution mode and test tunables used for this run.

```ts
interface NetworkTestResultTestType {
  id: string;
  sessionId: string;
  type: TestTypeSingleMultiple;
  testIndex: number | null;
  testCount: number | null;
  tag: LocationTag;
  downloadTestDuration: number | null;
  uploadTestDuration: number | null;
  testProtocol: string;
  downloadConnectionCount: number | null;
  uploadConnectionCount: number | null;
  downloadPacketSize: number | null;
  uploadPacketSize: number | null;
}
```

Frequently used fields:

- `id`: unique per test run
- `sessionId`: stable per engine instance/session
- `type`: currently `single`
- `downloadTestDuration` and `uploadTestDuration`
- `testProtocol`: currently `WSS`
- `downloadConnectionCount` and `uploadConnectionCount`
- `downloadPacketSize` and `uploadPacketSize`

## `results`

Contains environmental context and measured outputs.

```ts
interface NetworkTestResultResults {
  dateTime: string;
  connectionType: string | null;
  localIpAddress: string | null;
  externalIpAddress: string | null;
  vpnEnabled: boolean | null;
  testStatus: TestStatus;
  location: NetworkTestResultLocation | null;
  server: SpeedTestServer | null;
  cellular: NetworkTestResultCellularInfo | null;
  wifi: NetworkTestResultWiFiInfo | null;
  wired: NetworkTestResultWiredInfo | null;
  measurements: NetworkTestResultMeasurements;
}
```

### `results.server`

```ts
interface SpeedTestServer {
  id: string;
  domain: string;
  port: number | null;
  provider: string | null;
  city: string | null;
  region: string | null;
  country: string;
  location: string;
  latitude: number | null;
  longitude: number | null;
  distance: number | null;
  isCDN: boolean | null;
}
```

### `results.location`

```ts
interface NetworkTestResultLocation {
  latitude: number;
  longitude: number;
  elevation: number | null;
  heading: number | null;
  speed: number | null;
  locationType: LocationType;
}
```

### `results.cellular`, `results.wifi`, and `results.wired`

```ts
interface NetworkTestResultCellularInfo {
  technology: string | null;
  mccCode: string | null;
  mncCode: string | null;
  countryIso: string | null;
  carrierName: string | null;
  provider: string | null;
  isRoaming: boolean | null;
  rsrp: number | null;
  rsrq: number | null;
  rssi: number | null;
  sinr: number | null;
  primaryBand: NetworkTestResultBandInfo | null;
  secondaryBands: NetworkTestResultBandInfo[] | null;
}

interface NetworkTestResultBandInfo {
  bandNumber: number;
  bandwidth: number;
  technology: string | null;
}

interface NetworkTestResultWiFiInfo {
  ssidName: string | null;
  bssid: string | null;
  ispName: string | null;
  wifiStandard: string | null;
  txRate: number | null;
  rxRate: number | null;
  rsrp: number | null;
  rsrq: number | null;
  rssi: number | null;
  sinr: number | null;
  noise: number | null;
  channelNumber: number | null;
}

interface NetworkTestResultWiredInfo {
  ispName: string | null;
  macAddress: string | null;
  dataLink: number | null;
}
```

`cellular`, `wifi`, and `wired` are mutually exclusive in default resolution (`mobile`, `wifi`, or non-wireless fallback), but a custom `networkProvider` can override this behavior and set whichever blocks are needed.

### `results.measurements`

```ts
interface NetworkTestResultMeasurements {
  dateTime: string | null;
  downloadSpeed: number | null;
  totalDownload: number | null;
  uploadSpeed: number | null;
  totalUpload: number | null;
  latency: number | null;
  jitter: number | null;
  latenciesList: number[] | null;
  downloadList: NetworkTestResultSpeedTimePair[] | null;
  uploadList: NetworkTestResultSpeedTimePair[] | null;
  failedReason: string | null;
  failedStage: TestStage | null;
}

interface NetworkTestResultSpeedTimePair {
  time: number;
  speed: number;
  data: number;
}
```

`downloadList` and `uploadList` are time-series samples (time offset, speed, bytes). `failedReason` / `failedStage` are set when the run does not complete successfully.

## `stages`

Chronological stage records with timestamps and network context snapshots.

```ts
interface NetworkTestResultStage {
  testStage: string;
  dateTime: string;
  connectionType: string | null;
  localIpAddress: string | null;
  externalIpAddress: string | null;
  vpnEnabled: boolean | null;
  location: NetworkTestResultLocation | null;
  cellular: NetworkTestResultCellularInfo | null;
  wifi: NetworkTestResultWiFiInfo | null;
  wired: NetworkTestResultWiredInfo | null;
}
```

`testStage` is typed as `string` in the schema; emitted values align with `TestStage` (`latencyStart`, `downloadStart`, etc.).

## Nullability expectations

Many fields are nullable by design. Common reasons:

- runtime lacks a specific signal (browser privacy/platform constraints),
- stage failed before all metrics were produced,
- backend environment does not expose browser-specific data.

Consumers should treat null as "not available", not as zero.

## Recommended storage guidance

For analytics/storage systems:

- store payload as JSON blob plus indexed key fields (timestamp, server id, status),
- index `testType.id`, `testType.sessionId`, and `results.dateTime`,
- avoid flattening every nested field unless your query model requires it.

## Schema evolution guidance

When new fields are added:

- keep backward compatibility for existing required fields,
- bump `version` for structural or semantic breaking changes,
- document migration handling in release notes.

See also:

- [Library API](./library-api.md)
- [Providers](./providers.md) — How `cellular`, `wifi`, and `wired` blocks are populated and overridden
- [Protocol](./protocol.md)
