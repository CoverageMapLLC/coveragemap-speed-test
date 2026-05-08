# Library API Reference

Complete reference for `@coveragemap/speed-test`. Covers every exported class, interface, type, method, property, and utility function.

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';
```

---

## Table of contents

- [SpeedTestEngine](#speedtestengine)
  - [Constructor](#constructor)
  - [SpeedTestEngineOptions](#speedtestengineoptions)
  - [SpeedTestEngineApplicationInfo](#speedtestengineapplicationinfo)
  - [Properties](#properties)
  - [Methods](#methods)
- [Configuration](#configuration)
  - [SpeedTestConfig](#speedtestconfig)
  - [DEFAULT\_CONFIG](#default_config)
  - [SpeedTestSelection](#speedtestselection)
  - [SpeedTestLocation](#speedtestlocation)
  - [SpeedTestLocationProvider](#speedtestlocationprovider)
- [Callbacks](#callbacks)
  - [SpeedTestCallbacks](#speedtestcallbacks)
  - [SpeedTestStage](#speedteststage)
  - [Callback timing and order](#callback-timing-and-order)
- [Data types](#data-types)
  - [SpeedTestServer](#speedtestserver)
  - [ConnectionInfo](#connectioninfo)
  - [ConnectionClientInfo](#connectionclientinfo)
  - [ConnectionServerInfo](#connectionserverinfo)
  - [LatencyTestData](#latencytestdata)
  - [SpeedSnapshot](#speedsnapshot)
  - [SpeedTestData](#speedtestdata)
- [Result payload](#result-payload)
  - [NetworkTestResultTestResults](#networktestresulttestresults)
  - [NetworkTestResultDevice](#networktestresultdevice)
  - [NetworkTestResultApplicationInfo](#networktestresultapplicationinfo)
  - [NetworkTestResultCoreSystemInfo](#networktestresultcoresysteminfo)
  - [NetworkTestResultTestType](#networktestresulttesttype)
  - [NetworkTestResultResults](#networktestresultresults)
  - [NetworkTestResultLocation](#networktestresultlocation)
  - [NetworkTestResultMeasurements](#networktestresultmeasurements)
  - [NetworkTestResultSpeedTimePair](#networktestresultspeedtimepair)
  - [NetworkTestResultStage](#networktestresultstage)
  - [NetworkTestResultWiFiInfo](#networktestresultwifiinfo)
  - [NetworkTestResultWiredInfo](#networktestresultwiredinfo)
  - [BrowserInfo](#browserinfo)
  - [Type aliases](#type-aliases)
- [API clients](#api-clients)
  - [SpeedTestApiClient](#speedtestapiclient)
  - [API base URLs](#api-base-urls)
- [Device metadata](#device-metadata)
  - [DeviceMetadataProvider](#devicemetadataprovider)
  - [DefaultDeviceMetadataProvider](#defaultdevicemetadataprovider)
  - [DeviceInfoConfigOverrides](#deviceinfoconfigoverrides)
  - [CoreSystemOverrides](#coresystemoverrides)
  - [setDeviceMetadataProvider](#setdevicemetadataprovider)
  - [resetDeviceMetadataProvider](#resetdevicemetadataprovider)
- [Utilities](#utilities)
  - [CancellationToken](#cancellationtoken)
  - [CancellationError](#cancellationerror)
  - [calculateSpeedMbps](#calculatespeedmbps)
  - [formatSpeed](#formatspeed)
  - [formatBytes](#formatbytes)
  - [formatLatency](#formatlatency)
  - [generateUUID](#generateuuid)

---

## SpeedTestEngine

The primary class. Orchestrates latency measurement, download/upload estimation, and sustained throughput tests; assembles result payloads; and uploads them to the CoverageMap ingestion API.

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';
```

### Constructor

```ts
new SpeedTestEngine(options: SpeedTestEngineOptions)
```

Constructs an engine instance and validates required options. Throws synchronously if `application` fields are missing or if no test stages are enabled.

---

### SpeedTestEngineOptions

Passed to the `SpeedTestEngine` constructor.

```ts
interface SpeedTestEngineOptions {
  application: SpeedTestEngineApplicationInfo;
  config?: Partial<SpeedTestConfig>;
  tests?: SpeedTestSelection;
  callbacks?: SpeedTestCallbacks;
  api?: ApiBaseUrlOverrides;
  deviceInfo?: DeviceInfoConfigOverrides;
  locationProvider?: SpeedTestLocationProvider | null;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `application` | `SpeedTestEngineApplicationInfo` | Yes | Identity metadata for the integrating application. Persisted with every result payload. |
| `config` | `Partial<SpeedTestConfig>` | No | Overrides for protocol timings and probe counts. Unspecified fields fall back to `DEFAULT_CONFIG`. |
| `tests` | `SpeedTestSelection` | No | Selects which test stages run. Defaults to all three enabled. |
| `callbacks` | `SpeedTestCallbacks` | No | Event handlers for stage changes, measurement progress, and completion. |
| `api` | `ApiBaseUrlOverrides` | No | Optional Speed API and CoverageMap ingestion base URLs. Omitted properties use the library’s default hosts. |
| `deviceInfo` | `DeviceInfoConfigOverrides` | No | Controls how device identity and host telemetry are populated in the result payload. |
| `locationProvider` | `SpeedTestLocationProvider \| null` | No | Callback used to fetch current coordinates for server discovery and result location. If omitted or if it returns `null`, the engine falls back to `getConnectionInfo()` coordinates. |

---

### SpeedTestEngineApplicationInfo

Describes the application that is embedding the speed test. You are required to fill these properties out with your information.

```ts
interface SpeedTestEngineApplicationInfo {
  id: string;
  name: string;
  version: string;
  organization: string;
  type: ApplicationType;
  website?: string | null;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Stable UUID that uniquely identifies your application. Hard-code this value — it is persisted with every result payload and used to associate results with your integration. |
| `name` | `string` | Yes | Product or service name. |
| `version` | `string` | Yes | Build or release version string. |
| `organization` | `string` | Yes | Company or business unit. |
| `type` | `ApplicationType` | Yes | Runtime category. Use a value from `ApplicationType` or any descriptive string. |
| `website` | `string \| null` | No | Canonical URL for the integration. |

All required fields are validated as non-empty strings during construction. `application.id` must be a canonical UUID (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, hexadecimal). Examples in this documentation use a fixed demo UUID; `SpeedTestEngine` throws during construction if you pass that value — replace it with your own static UUID for your product (generate once and hard-code it). Invalid metadata fails fast before any network operation starts.

**`ApplicationType`** values: `'web'`, `'backend'`, `'mobile'`, `'desktop'`, `'cli'`, `'serverless'`, `'other'`.

---

### Properties

#### `stage`

```ts
get stage(): SpeedTestStage
```

The current lifecycle state of the engine. Reflects the stage most recently entered. See [`SpeedTestStage`](#speedteststage) for all possible values.

#### `isRunning`

```ts
get isRunning(): boolean
```

`true` while a run is active. Returns to `false` after the run finishes, fails, or is cancelled.

---

### Methods

#### `run(server?)`

```ts
run(server?: SpeedTestServer | string): Promise<NetworkTestResultTestResults>
```

Executes the enabled test stages in sequence and returns an assembled result payload.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server` | `SpeedTestServer \| string` | No | The server to test against. Pass a `SpeedTestServer` object, a server UUID string, or omit to auto-select. |

When `server` is a UUID string, the engine resolves it against the server list (using the cache when available) and throws if no server with that ID is found. When `server` is omitted, the engine selects the first result returned by `getServers()`.

When each stage completes, the corresponding callback is fired. The returned payload is also asynchronously uploaded to CoverageMap; if upload fails, the payload is queued locally and flushed automatically at the start of the next `run()` call.

Returns a `NetworkTestResultTestResults` payload for both successful and stage-failed runs. Throws only for unrecoverable precondition errors (e.g. server ID not found, no servers available).

---

#### `cancel()`

```ts
cancel(): void
```

Requests cooperative cancellation of the active run. The in-progress protocol stage is interrupted via `CancellationToken`, the active stage rejects with `CancellationError`, and the result payload reflects cancellation. Does not emit `onError`.

---

#### `getServers()`

```ts
getServers(): Promise<SpeedTestServer[]>
```

Returns the server inventory from the CoverageMap Speed API. Results are cached in memory for 30 minutes. Subsequent calls within that window return the cached list immediately without a network request. The engine resolves location using `locationProvider` first and falls back to `getConnectionInfo()` when needed.

Throws if the HTTP response is not successful or if the response format is invalid.

---

#### `refreshServers()`

```ts
refreshServers(): Promise<SpeedTestServer[]>
```

Clears the server list cache and fetches a fresh list from the API immediately, regardless of when the last fetch occurred. Returns the updated list using the latest location from `locationProvider` (or `getConnectionInfo()` fallback).

Throws if the HTTP response is not successful or if the response format is invalid.

---

#### `getServer(id)`

```ts
getServer(id: string): Promise<SpeedTestServer | null>
```

Looks up a single server by its UUID. Fetches the server list first if it has not been loaded yet, otherwise uses the in-memory cache. Returns `null` if no server with that ID exists.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | `string` | Yes | UUID of the server to retrieve. |

---

#### `getConnectionInfo()`

```ts
getConnectionInfo(): Promise<ConnectionInfo | null>
```

Fetches client and server connection metadata from `/v1/connection`. Returns `null` if the request fails, times out, or returns a non-success response. Never throws so callers can continue with reduced context.

---

#### `updateCallbacks(callbacks)`

```ts
updateCallbacks(callbacks: Partial<SpeedTestCallbacks>): void
```

Merges new callback handlers into the existing set. Handlers not present in `callbacks` are preserved. Useful for attaching listeners across UI lifecycle events or layering telemetry at runtime.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `callbacks` | `Partial<SpeedTestCallbacks>` | Yes | Partial set of handlers to merge in. |

---

#### `setLocationProvider(provider)`

```ts
setLocationProvider(provider: SpeedTestLocationProvider | null): void
```

Updates the active location provider at runtime. Pass `null` to disable custom coordinates and use `getConnectionInfo()` fallback only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `provider` | `SpeedTestLocationProvider \| null` | Yes | Provider callback used for subsequent `getServers()`, `refreshServers()`, and `run()` calls. |

---

## Configuration

### SpeedTestConfig

Controls protocol timings and probe behavior. Passed as `Partial<SpeedTestConfig>` via `options.config`; omitted fields use `DEFAULT_CONFIG`.

```ts
interface SpeedTestConfig {
  pingCount: number;
  downloadDurationMs: number;
  uploadDurationMs: number;
  snapshotIntervalMs: number;
  latencyTimeoutMs: number;
  estimationTimeoutMs: number;
}
```

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `pingCount` | `number` | `10` | 5 – 50 | Number of RTT probes collected during the latency stage. Higher values produce a more stable baseline; lower values shorten total run time. |
| `downloadDurationMs` | `number` | `10000` | 3000 – 30000 | Duration of the sustained download throughput stage in milliseconds. Longer durations improve smoothing on unstable links. |
| `uploadDurationMs` | `number` | `10000` | 3000 – 30000 | Duration of the sustained upload throughput stage in milliseconds. Behaves like `downloadDurationMs` for upstream. |
| `snapshotIntervalMs` | `number` | `100` | 50 – 5000 | Interval between progress snapshots emitted during sustained throughput stages. Lower values increase callback frequency. |
| `latencyTimeoutMs` | `number` | `10000` | 3000 – 30000 | Maximum time allowed for the latency stage to collect sufficient probe responses. The stage fails if this window is exceeded. |
| `estimationTimeoutMs` | `number` | `15000` | 3000 – 30000 | Maximum time allowed for download and upload estimation phases. Prevents the run from hanging during pre-throughput sizing. |

---

### DEFAULT_CONFIG

```ts
const DEFAULT_CONFIG: SpeedTestConfig
```

Built-in defaults tuned for production-grade measurements. Used automatically when `options.config` is omitted or partially specified.

---

### SpeedTestSelection

Controls which test stages are executed when `run()` is called.

```ts
interface SpeedTestSelection {
  latency?: boolean;
  download?: boolean;
  upload?: boolean;
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `latency` | `boolean` | `true` | Enables the RTT/jitter latency stage. When disabled with `download` or `upload` enabled, throughput stages run without latency normalization. |
| `download` | `boolean` | `true` | Enables the download estimation and sustained download throughput stages. |
| `upload` | `boolean` | `true` | Enables the upload estimation and sustained upload throughput stages. |

At least one stage must be enabled. Constructing an engine with all three set to `false` throws immediately.

---

### SpeedTestLocation

Coordinates returned by a location provider.

```ts
interface SpeedTestLocation {
  latitude: number;
  longitude: number;
  elevation?: number | null;
  heading?: number | null;
  speed?: number | null;
}
```

---

### SpeedTestLocationProvider

Callback type used by `SpeedTestEngineOptions.locationProvider` and `setLocationProvider()`.

```ts
interface SpeedTestLocationProviderContext {
  connectionInfo: ConnectionInfo | null;
}

type SpeedTestLocationProvider = (context: SpeedTestLocationProviderContext) =>
  | SpeedTestLocation
  | null
  | Promise<SpeedTestLocation | null>;
```

Return `null` when live location is unavailable so the engine can fall back to the default provider (IP lookup from `connectionInfo`).

---

## Callbacks

### SpeedTestCallbacks

Lifecycle and measurement event handlers. All fields are optional.

```ts
interface SpeedTestCallbacks {
  onStageChange?: (stage: SpeedTestStage) => void;
  onLatencyPing?: (latencyMs: number, index: number) => void;
  onLatencyResult?: (data: LatencyTestData) => void;
  onDownloadProgress?: (snapshot: SpeedSnapshot) => void;
  onDownloadResult?: (data: SpeedTestData) => void;
  onUploadProgress?: (snapshot: SpeedSnapshot) => void;
  onUploadResult?: (data: SpeedTestData) => void;
  onComplete?: (downloadMbps: number, uploadMbps: number, latencyMs: number) => void;
  onError?: (error: Error, stage: SpeedTestStage) => void;
}
```

| Handler | Parameters | Description |
|---------|------------|-------------|
| `onStageChange` | `stage: SpeedTestStage` | Fired whenever the engine transitions to a new stage. |
| `onLatencyPing` | `latencyMs: number, index: number` | Fired after each individual ping response is received. `index` is 0-based. Only fires during the full latency stage; not fired for the silent single-ping fallback. |
| `onLatencyResult` | `data: LatencyTestData` | Fired once when the full latency stage aggregation completes. |
| `onDownloadProgress` | `snapshot: SpeedSnapshot` | Fired repeatedly during the sustained download stage at `snapshotIntervalMs` intervals. |
| `onDownloadResult` | `data: SpeedTestData` | Fired once when the sustained download stage completes with the final aggregated result. |
| `onUploadProgress` | `snapshot: SpeedSnapshot` | Fired repeatedly during the sustained upload stage. |
| `onUploadResult` | `data: SpeedTestData` | Fired once when the sustained upload stage completes with the final aggregated result. |
| `onComplete` | `downloadMbps, uploadMbps, latencyMs` | Fired after the run assembles final measurements. |
| `onError` | `error: Error, stage: SpeedTestStage` | Fired for non-cancellation stage failures. Cancellation does not emit this. |

---

### SpeedTestStage

```ts
type SpeedTestStage =
  | 'idle'
  | 'latency'
  | 'downloadEstimation'
  | 'download'
  | 'uploadEstimation'
  | 'upload'
  | 'complete'
  | 'error';
```

| Value | Description |
|-------|-------------|
| `'idle'` | Engine is constructed but `run()` has not been called or has finished. |
| `'latency'` | RTT and jitter probes are being collected. |
| `'downloadEstimation'` | Short download to determine optimal message size and connection count. |
| `'download'` | Sustained multi-connection download throughput measurement. |
| `'uploadEstimation'` | Short ACK-based upload to determine optimal sizing. |
| `'upload'` | Sustained multi-connection upload throughput measurement. |
| `'complete'` | All enabled stages finished; result payload assembled. |
| `'error'` | A non-cancellation failure occurred in a stage. |

---

### Callback timing and order

Typical successful progression for a full run:

1. `onStageChange('latency')`
2. `onLatencyPing(latencyMs, index)` — repeated, once per probe
3. `onLatencyResult(data)`
4. `onStageChange('downloadEstimation')`
5. `onStageChange('download')`
6. `onDownloadProgress(snapshot)` — repeated
7. `onDownloadResult(data)`
8. `onStageChange('uploadEstimation')`
9. `onStageChange('upload')`
10. `onUploadProgress(snapshot)` — repeated
11. `onUploadResult(data)`
12. `onStageChange('complete')`
13. `onComplete(downloadMbps, uploadMbps, latencyMs)`

On failure: `onError(error, stage)` is emitted; subsequent stages do not run.

On cancellation: no `onError` is emitted; the result payload records the cancellation.

---

## Data types

### SpeedTestServer

Represents a CoverageMap speed test server node.

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

Premium servers are automatically filtered out by the client before the list is returned. All `SpeedTestServer` objects exposed through this library are non-premium.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique server identifier. |
| `domain` | `string` | Hostname used to construct WebSocket URLs. |
| `port` | `number \| null` | Port override. `null` uses the default for the protocol. |
| `provider` | `string \| null` | Infrastructure provider name. |
| `city` | `string \| null` | City where the server is located. |
| `region` | `string \| null` | Region or state. |
| `country` | `string` | ISO country code. |
| `location` | `string` | Human-readable location label. |
| `latitude` | `number \| null` | Geographic latitude. |
| `longitude` | `number \| null` | Geographic longitude. |
| `distance` | `number \| null` | Distance from the requesting client in kilometers, when available. |
| `isCDN` | `boolean \| null` | Whether the server is CDN-backed. |

#### `getServerWsUrl(server)`

```ts
getServerWsUrl(server: SpeedTestServer): string
```

Returns the WebSocket URL for a given server, constructed from its `domain` and `port`.

---

### ConnectionInfo

Returned by `getConnectionInfo()`. Contains metadata about the client's network connection and the responding API server.

```ts
interface ConnectionInfo {
  client: ConnectionClientInfo | null;
  server: ConnectionServerInfo | null;
}
```

---

### ConnectionClientInfo

```ts
interface ConnectionClientInfo {
  ip: string | null;
  city: string | null;
  region: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  continent: string | null;
  timezone: string | null;
  latitude: number;
  longitude: number;
  asn: number | null;
  asOrg: string;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ip` | `string \| null` | Client public IP address. |
| `city` | `string \| null` | City derived from IP geolocation. |
| `region` | `string \| null` | Region derived from IP geolocation. |
| `state` | `string \| null` | State derived from IP geolocation. |
| `postalCode` | `string \| null` | Postal code derived from IP geolocation. |
| `country` | `string \| null` | Country code. |
| `continent` | `string \| null` | Continent code. |
| `timezone` | `string \| null` | IANA timezone string. |
| `latitude` | `number` | Geographic latitude from IP geolocation. |
| `longitude` | `number` | Geographic longitude from IP geolocation. |
| `asn` | `number \| null` | Autonomous system number of the client's ISP. |
| `asOrg` | `string` | Autonomous system organization name. |

---

### ConnectionServerInfo

```ts
interface ConnectionServerInfo {
  provider: string;
  dataCenter: string;
  city: string;
  country: string;
  region: string | null;
  continent: string | null;
  latitude: number | null;
  longitude: number | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `string` | Infrastructure provider. |
| `dataCenter` | `string` | Data center identifier. |
| `city` | `string` | City where the API server is hosted. |
| `country` | `string` | Country where the API server is hosted. |
| `region` | `string \| null` | Region where the API server is hosted. |
| `continent` | `string \| null` | Continent code. |
| `latitude` | `number \| null` | Geographic latitude of the server. |
| `longitude` | `number \| null` | Geographic longitude of the server. |

---

### LatencyTestData

Aggregated latency and jitter measurements from the probe stage.

```ts
interface LatencyTestData {
  latencies: number[];
  minLatency: number;
  averageLatency: number;
  medianLatency: number;
  maxLatency: number;
  minJitter: number;
  averageJitter: number;
  medianJitter: number;
  maxJitter: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `latencies` | `number[]` | Individual RTT measurements in milliseconds. |
| `minLatency` | `number` | Minimum observed RTT in milliseconds. |
| `averageLatency` | `number` | Mean RTT across all probes. |
| `medianLatency` | `number` | Median RTT across all probes. |
| `maxLatency` | `number` | Maximum observed RTT in milliseconds. |
| `minJitter` | `number` | Minimum observed jitter in milliseconds. |
| `averageJitter` | `number` | Mean jitter across all probes. |
| `medianJitter` | `number` | Median jitter across all probes. |
| `maxJitter` | `number` | Maximum observed jitter in milliseconds. |

---

### SpeedSnapshot

A single throughput sample emitted during a sustained test stage.

```ts
interface SpeedSnapshot {
  timeOffsetMs: number;
  speedMbps: number;
  bytes: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `timeOffsetMs` | `number` | Time elapsed since the stage started, in milliseconds. |
| `speedMbps` | `number` | Instantaneous throughput at this snapshot. |
| `bytes` | `number` | Cumulative bytes transferred at this snapshot. |

---

### SpeedTestData

Aggregated result from a sustained download or upload throughput stage.

```ts
interface SpeedTestData {
  durationMs: number;
  speedMbps: number;
  bytes: number;
  snapshots: SpeedSnapshot[];
}
```

| Field | Type | Description |
|-------|------|-------------|
| `durationMs` | `number` | Total stage duration in milliseconds. |
| `speedMbps` | `number` | Final throughput result in Mbps. |
| `bytes` | `number` | Total bytes transferred during the stage. |
| `snapshots` | `SpeedSnapshot[]` | All progress snapshots collected during the stage. |

---

## Result payload

The complete payload produced by `run()` and uploaded to CoverageMap.

### NetworkTestResultTestResults

Top-level container for a single test run.

```ts
interface NetworkTestResultTestResults {
  version: number;
  device: NetworkTestResultDevice;
  testType: NetworkTestResultTestType;
  results: NetworkTestResultResults;
  stages: NetworkTestResultStage[] | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `version` | `number` | Payload schema version. |
| `device` | `NetworkTestResultDevice` | Device and application metadata at the time of the test. |
| `testType` | `NetworkTestResultTestType` | Test session configuration and sizing parameters. |
| `results` | `NetworkTestResultResults` | All measurement outcomes and connection context. |
| `stages` | `NetworkTestResultStage[] \| null` | Per-stage timing records, or `null` if not collected. |

---

### NetworkTestResultDevice

Device, browser, OS, and application metadata.

```ts
interface NetworkTestResultDevice {
  id: string;
  nameId: string;
  appName: string;
  appVersion: string;
  manufacturer: string | null;
  name: string | null;
  os: DeviceOS | null;
  osVersion: string | null;
  isMobile: boolean;
  application: NetworkTestResultApplicationInfo;
  coreSystem: NetworkTestResultCoreSystemInfo;
  // browser fields
  browserName: string | null;
  browserVersion: string | null;
  browserEngine: string | null;
  // hardware/environment
  cpuCores: number | null;
  deviceMemoryGb: number | null;
  language: string | null;
  timezone: string | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Persistent device identifier (UUID, stored in local storage by default). |
| `nameId` | `string` | Human-readable device name identifier. |
| `appName` | `string` | From `application.name`. |
| `appVersion` | `string` | From `application.version`. |
| `manufacturer` | `string \| null` | Device manufacturer. |
| `name` | `string \| null` | Device model name. |
| `os` | `DeviceOS \| null` | Operating system. |
| `osVersion` | `string \| null` | OS version string. |
| `isMobile` | `boolean` | Whether the device is classified as mobile. |
| `application` | `NetworkTestResultApplicationInfo` | Full application metadata from constructor options. |
| `coreSystem` | `NetworkTestResultCoreSystemInfo` | Host-level runtime telemetry. |
| `browserName` | `string \| null` | Browser name (browser runtimes). |
| `browserVersion` | `string \| null` | Browser version. |
| `browserEngine` | `string \| null` | Browser engine (e.g. `Blink`, `WebKit`). |
| `cpuCores` | `number \| null` | Logical CPU core count. |
| `deviceMemoryGb` | `number \| null` | Device memory reported by the browser. |
| `language` | `string \| null` | Navigator language string. |
| `timezone` | `string \| null` | IANA timezone string. |

---

### NetworkTestResultApplicationInfo

Application metadata embedded in the result payload. Mirrors `SpeedTestEngineApplicationInfo`.

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

---

### NetworkTestResultCoreSystemInfo

Host-level telemetry for non-browser (backend, CLI, serverless) runtimes.

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

| Field | Type | Description |
|-------|------|-------------|
| `runtime` | `RuntimeType` | Runtime environment (e.g. `'browser'`, `'node'`). |
| `hostName` | `string \| null` | Machine hostname. |
| `processId` | `number \| null` | OS process identifier. |
| `platform` | `string \| null` | OS platform label. |
| `architecture` | `string \| null` | CPU architecture string. |
| `runtimeVersion` | `string \| null` | Runtime version (e.g. Node.js version). |
| `uptimeSeconds` | `number \| null` | Process uptime in seconds. |
| `memoryRssMb` | `number \| null` | Resident set size memory in MB. |

---

### NetworkTestResultTestType

Session configuration and protocol sizing parameters recorded at run time.

```ts
interface NetworkTestResultTestType {
  id: string;
  sessionId: string;
  type: TestTypeSingleMultiple;
  tag: LocationTag;
  testProtocol: string;
  testIndex: number | null;
  testCount: number | null;
  downloadDurationMs: number | null;
  uploadDurationMs: number | null;
  downloadConnectionCount: number | null;
  uploadConnectionCount: number | null;
  downloadPacketSizeKb: number | null;
  uploadPacketSizeKb: number | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique test run identifier. |
| `sessionId` | `string` | Session identifier grouping related runs. |
| `type` | `TestTypeSingleMultiple` | Whether this is a single or multi-connection test. |
| `tag` | `LocationTag` | Location context tag. |
| `testProtocol` | `string` | Protocol used (e.g. `'websocket'`). |
| `testIndex` | `number \| null` | Index within a sequence of runs. |
| `testCount` | `number \| null` | Total number of runs in the sequence. |
| `downloadDurationMs` | `number \| null` | Configured download duration. |
| `uploadDurationMs` | `number \| null` | Configured upload duration. |
| `downloadConnectionCount` | `number \| null` | Number of parallel download connections used. |
| `uploadConnectionCount` | `number \| null` | Number of parallel upload connections used. |
| `downloadPacketSizeKb` | `number \| null` | Download message size in KB. |
| `uploadPacketSizeKb` | `number \| null` | Upload message size in KB. |

---

### NetworkTestResultResults

All measurement outcomes and network context.

```ts
interface NetworkTestResultResults {
  dateTime: string;
  testStatus: TestStatus;
  connectionType: ConnectionType | null;
  clientIp: string | null;
  serverIp: string | null;
  isVpn: boolean | null;
  location: NetworkTestResultLocation | null;
  serverId: string | null;
  serverDomain: string | null;
  wifi: NetworkTestResultWiFiInfo | null;
  wired: NetworkTestResultWiredInfo | null;
  measurements: NetworkTestResultMeasurements | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `dateTime` | `string` | ISO 8601 timestamp when the test completed. |
| `testStatus` | `TestStatus` | Overall test outcome (`'complete'`, `'failed'`, `'cancelled'`, etc.). |
| `connectionType` | `ConnectionType \| null` | Detected connection type (e.g. `'wifi'`, `'mobile'`, `'ethernet'`). |
| `clientIp` | `string \| null` | Client IP address at test time. |
| `serverIp` | `string \| null` | Speed server IP address. |
| `isVpn` | `boolean \| null` | VPN detection result when available. |
| `location` | `NetworkTestResultLocation \| null` | Client geographic coordinates, when provided. |
| `serverId` | `string \| null` | Identifier of the server tested against. |
| `serverDomain` | `string \| null` | Domain of the server tested against. |
| `wifi` | `NetworkTestResultWiFiInfo \| null` | Present when connection type is Wi-Fi. Contains ISP name. |
| `wired` | `NetworkTestResultWiredInfo \| null` | Present when connection type is not Wi-Fi. Contains ISP name. |
| `measurements` | `NetworkTestResultMeasurements \| null` | Final numeric measurements. |

---

### NetworkTestResultLocation

Client geographic coordinates.

```ts
interface NetworkTestResultLocation {
  latitude: number;
  longitude: number;
  locationType: LocationType;
  elevation: number | null;
  heading: number | null;
  speed: number | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `latitude` | `number` | Geographic latitude. |
| `longitude` | `number` | Geographic longitude. |
| `locationType` | `LocationType` | How coordinates were determined (e.g. `'gps'`, `'ip'`). |
| `elevation` | `number \| null` | Elevation in meters. |
| `heading` | `number \| null` | Compass heading in degrees. |
| `speed` | `number \| null` | Movement speed in m/s. |

---

### NetworkTestResultMeasurements

Final numeric results from all enabled stages.

```ts
interface NetworkTestResultMeasurements {
  downloadMbps: number | null;
  uploadMbps: number | null;
  latencyMs: number | null;
  jitterMs: number | null;
  downloadBytes: number | null;
  uploadBytes: number | null;
  downloadDurationMs: number | null;
  uploadDurationMs: number | null;
  downloadSnapshots: NetworkTestResultSpeedTimePair[] | null;
  uploadSnapshots: NetworkTestResultSpeedTimePair[] | null;
  failedStage: TestStage | null;
  failedReason: string | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `downloadMbps` | `number \| null` | Final download throughput. |
| `uploadMbps` | `number \| null` | Final upload throughput. |
| `latencyMs` | `number \| null` | Median RTT. |
| `jitterMs` | `number \| null` | Median jitter. |
| `downloadBytes` | `number \| null` | Total download bytes transferred. |
| `uploadBytes` | `number \| null` | Total upload bytes transferred. |
| `downloadDurationMs` | `number \| null` | Actual download stage duration. |
| `uploadDurationMs` | `number \| null` | Actual upload stage duration. |
| `downloadSnapshots` | `NetworkTestResultSpeedTimePair[] \| null` | Time-series download samples. |
| `uploadSnapshots` | `NetworkTestResultSpeedTimePair[] \| null` | Time-series upload samples. |
| `failedStage` | `TestStage \| null` | Stage that failed, if any. |
| `failedReason` | `string \| null` | Error message if a stage failed. |

---

### NetworkTestResultSpeedTimePair

A single time-stamped throughput sample in the result payload.

```ts
interface NetworkTestResultSpeedTimePair {
  time: number;
  speed: number;
  data: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `time` | `number` | Elapsed milliseconds since stage start. |
| `speed` | `number` | Throughput in Mbps at this moment. |
| `data` | `number` | Cumulative bytes at this moment. |

---

### NetworkTestResultStage

Per-stage timing record.

```ts
interface NetworkTestResultStage {
  testStage: string;
  dateTime: string;
  durationMs: number | null;
  status: string | null;
  failedReason: string | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `testStage` | `string` | Stage name. |
| `dateTime` | `string` | ISO 8601 timestamp when the stage started. |
| `durationMs` | `number \| null` | Stage duration in milliseconds. |
| `status` | `string \| null` | Stage completion status. |
| `failedReason` | `string \| null` | Error message if the stage failed. |

---

### NetworkTestResultWiFiInfo

Present when the detected connection type is Wi-Fi.

```ts
interface NetworkTestResultWiFiInfo {
  ispName: string | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ispName` | `string \| null` | ISP or AS organization name from connection info. |

---

### NetworkTestResultWiredInfo

Present when the detected connection type is not Wi-Fi (ethernet, cellular, or unknown).

```ts
interface NetworkTestResultWiredInfo {
  ispName: string | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ispName` | `string \| null` | ISP or AS organization name from connection info. |

---

### BrowserInfo

Browser capabilities and environment fingerprint.

```ts
interface BrowserInfo {
  browserName: string;
  browserVersion: string;
  browserEngine: string;
  platform: string;
  language: string;
  languages: string[];
  hardwareConcurrency: number;
  deviceMemory: number | null;
  maxTouchPoints: number;
  cookieEnabled: boolean;
  vendor: string;
  isMobile: boolean;
}
```

---

### Type aliases

```ts
type DeviceOS = 'iOS' | 'Android' | 'Windows' | 'macOS' | 'Linux' | 'ChromeOS' | 'Other' | string;

type TestStatus = 'complete' | 'failed' | 'cancelled' | 'partial';

type TestTypeSingleMultiple = 'single' | 'multiple';

type LocationTag = 'client' | 'server' | 'unknown';

type LocationType = 'gps' | 'ip' | 'manual' | 'unknown';

type TestStage = 'latency' | 'download' | 'upload';

type ConnectionType = 'wifi' | 'mobile' | 'ethernet' | 'bluetooth' | 'none' | 'unknown';

type RuntimeType = 'browser' | 'node' | 'bun' | 'deno' | 'worker' | 'other';

type ApplicationType = 'web' | 'backend' | 'mobile' | 'desktop' | 'cli' | 'serverless' | 'other';
```

---

## API clients

### SpeedTestApiClient

Standalone HTTP client for the CoverageMap Speed API. Used internally by `SpeedTestEngine`; also exported for custom orchestration when you need server discovery or connection info without running a full test.

```ts
import { SpeedTestApiClient } from '@coveragemap/speed-test';

const client = new SpeedTestApiClient();
```

**Constructor**

```ts
new SpeedTestApiClient(
  overrides?: ApiBaseUrlOverrides,
  locationProvider?: SpeedTestLocationProvider | null
)
```

Omitted `overrides` properties fall back to the library’s default production base URLs. Pass a `locationProvider` when coordinates should not be inferred from `getConnectionInfo()`.

#### `getServers()`

```ts
getServers(): Promise<SpeedTestServer[]>
```

Returns the filtered server inventory (premium servers excluded). Results are cached for 30 minutes; subsequent calls within that window return the cached list when location has not changed. Location is resolved from the configured `locationProvider`, then falls back to `getConnectionInfo()` coordinates. Throws on HTTP errors or malformed responses.

#### `refreshServers()`

```ts
refreshServers(): Promise<SpeedTestServer[]>
```

Clears the cached server list and forces a fresh fetch. Useful when you need an up-to-date list after a long idle period.

#### `getServer(id)`

```ts
getServer(id: string): Promise<SpeedTestServer | null>
```

Looks up a single server by its UUID. Fetches the server list first if it has not been loaded yet, otherwise uses the in-memory cache. Returns `null` if no server with that ID exists.

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string` | UUID of the server to retrieve. |

#### `getConnectionInfo()`

```ts
getConnectionInfo(): Promise<ConnectionInfo | null>
```

Returns client/server connection metadata (IP address, ISP name, ASN). Returns `null` on any network or server failure.

---

### API base URLs

```ts
interface ApiBaseUrlOverrides {
  speedApiBaseUrl?: string;
  coverageMapApiBaseUrl?: string;
}

function getSpeedApiBaseUrl(overrides?: ApiBaseUrlOverrides): string;
function getCoverageMapApiBaseUrl(overrides?: ApiBaseUrlOverrides): string;
```

`SpeedTestEngineOptions.api`, `SpeedTestApiClient`, and `CoverageMapApiClient` all accept the same optional override shape. Helpers return the resolved HTTPS base URL (trailing slashes stripped), using CoverageMap production hosts when a field is omitted.

`CoverageMapApiClient` constructor: `new CoverageMapApiClient(overrides?: ApiBaseUrlOverrides)`.

---

## Device metadata

### DeviceMetadataProvider

Interface for custom device metadata implementations. Replace the default browser-based provider when running in non-standard runtimes (serverless, embedded, host-bridged environments).

```ts
interface DeviceMetadataProvider {
  reset(): void;
  getDeviceId(config: DeviceMetadataProviderConfig): string;
  parseBrowserInfo(): ParsedBrowserInfo;
  parseOSInfo(): ParsedOSInfo;
  getConnectionType(): ConnectionType;
  getNetworkInfo(): NetworkInfo;
  getBrowserInfo(): BrowserInfo;
  buildDeviceResult(config: DeviceMetadataProviderConfig): NetworkTestResultDevice;
}
```

| Method | Return type | Description |
|--------|-------------|-------------|
| `reset()` | `void` | Clears any cached state in the provider. |
| `getDeviceId(config)` | `string` | Returns a persistent device identifier. |
| `parseBrowserInfo()` | `ParsedBrowserInfo` | Parses browser name, version, and engine. |
| `parseOSInfo()` | `ParsedOSInfo` | Parses OS name and version. |
| `getConnectionType()` | `ConnectionType` | Detects connection type. |
| `getNetworkInfo()` | `NetworkInfo` | Returns network quality indicators. |
| `getBrowserInfo()` | `BrowserInfo` | Returns full browser fingerprint. |
| `buildDeviceResult(config)` | `NetworkTestResultDevice` | Assembles the complete device metadata payload. |

**`DeviceMetadataProviderConfig`**

```ts
interface DeviceMetadataProviderConfig {
  deviceIdStorageKey: string;
  application: NetworkTestResultApplicationInfo;
  coreSystem: CoreSystemOverrides;
}
```

---

### DefaultDeviceMetadataProvider

The built-in implementation using `ua-parser-js` and browser APIs. Registered automatically when using `SpeedTestEngine`.

```ts
import { DefaultDeviceMetadataProvider } from '@coveragemap/speed-test';

const provider = new DefaultDeviceMetadataProvider();
```

Implements all methods of `DeviceMetadataProvider`. Replace it via `setDeviceMetadataProvider()` when the default browser-based detection is insufficient.

---

### DeviceInfoConfigOverrides

Passed as `options.deviceInfo` to the engine constructor.

```ts
interface DeviceInfoConfigOverrides {
  deviceIdStorageKey?: string;
  coreSystem?: CoreSystemOverrides;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `deviceIdStorageKey` | `string` | Local storage key used to persist the device identifier across sessions. Defaults to an internal key. |
| `coreSystem` | `CoreSystemOverrides` | Overrides for host-level telemetry fields. |

---

### CoreSystemOverrides

Optional overrides for host-level telemetry. Useful for backend and worker contexts where runtime-derived values are incomplete.

```ts
interface CoreSystemOverrides {
  hostName?: string | null;
  processId?: number | null;
  platform?: string | null;
  architecture?: string | null;
  runtimeVersion?: string | null;
  uptimeSeconds?: number | null;
  memoryRssMb?: number | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `hostName` | `string \| null` | Hostname to emit in the result payload. |
| `processId` | `number \| null` | OS process identifier. |
| `platform` | `string \| null` | Runtime platform label (e.g. `'linux'`). |
| `architecture` | `string \| null` | CPU architecture (e.g. `'x64'`). |
| `runtimeVersion` | `string \| null` | Runtime version string (e.g. Node.js version). |
| `uptimeSeconds` | `number \| null` | Process uptime in seconds. |
| `memoryRssMb` | `number \| null` | Resident set size memory in MB. |

---

### setDeviceMetadataProvider

```ts
setDeviceMetadataProvider(provider: DeviceMetadataProvider): void
```

Replaces the active device metadata provider with a custom implementation. Must be called before `run()` to take effect. Implement the `DeviceMetadataProvider` interface to control how device identity, browser, OS, and connection telemetry are collected — useful in server-side, React Native, or Electron environments where the default browser-based detection is unavailable or inaccurate.

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';
import type { DeviceMetadataProvider } from '@coveragemap/speed-test';

class MyProvider implements DeviceMetadataProvider {
  // implement all required methods ...
}

const engine = new SpeedTestEngine({ application: { ... } });
engine.setDeviceMetadataProvider(new MyProvider());

await engine.run();
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `provider` | `DeviceMetadataProvider` | Custom provider instance to use for all subsequent runs. |

---

### resetDeviceMetadataProvider

```ts
resetDeviceMetadataProvider(): void
```

Restores the built-in `DefaultDeviceMetadataProvider`, discarding any custom provider previously set via `setDeviceMetadataProvider()`.

---

## Utilities

### CancellationToken

Cooperative cancellation primitive used internally by the engine.

```ts
import { CancellationToken } from '@coveragemap/speed-test';

const token = new CancellationToken();
```

**Constructor**

```ts
new CancellationToken()
```

**Properties**

| Property | Type | Description |
|----------|------|-------------|
| `isCancelled` | `boolean` | `true` after `cancel()` has been called. |
| `signal` | `AbortSignal` | The underlying `AbortSignal` for use with fetch or other Web APIs. |

**Methods**

| Method | Signature | Description |
|--------|-----------|-------------|
| `cancel()` | `() => void` | Triggers cancellation and fires all registered callbacks. |
| `throwIfCancelled()` | `() => void` | Throws `CancellationError` if the token is already cancelled. Call at checkpoints inside long-running loops. |
| `onCancel(callback)` | `(callback: () => void) => void` | Registers a callback to fire immediately when the token is cancelled. |

---

### CancellationError

Thrown by `CancellationToken.throwIfCancelled()` when cancellation is requested mid-stage.

```ts
import { CancellationError } from '@coveragemap/speed-test';
```

Extends `Error`. Use `instanceof CancellationError` to distinguish cooperative cancellation from other failures.

---

### calculateSpeedMbps

```ts
calculateSpeedMbps(bytes: number, durationMs: number): number
```

Converts a byte count and duration to megabits per second.

| Parameter | Type | Description |
|-----------|------|-------------|
| `bytes` | `number` | Total bytes transferred. |
| `durationMs` | `number` | Duration in milliseconds. |

---

### formatSpeed

```ts
formatSpeed(mbps: number): string
```

Returns a human-readable throughput string (e.g. `"94.3 Mbps"` or `"1.2 Gbps"`).

---

### formatBytes

```ts
formatBytes(bytes: number): string
```

Returns a human-readable byte count string (e.g. `"12.4 MB"`).

---

### formatLatency

```ts
formatLatency(ms: number): string
```

Returns a human-readable latency string (e.g. `"14 ms"`).

---

### generateUUID

```ts
generateUUID(): string
```

Generates a UUID v4 string using `crypto.randomUUID()` when available, with a fallback for environments that do not support it.

---

## See also

- [Protocol](./protocol.md) — WebSocket message framing and stage wire protocol
- [Result Schema](./result-schema.md) — Full result payload field reference
- [Examples](./examples.md) — Integration examples for browser, Node.js, and serverless
