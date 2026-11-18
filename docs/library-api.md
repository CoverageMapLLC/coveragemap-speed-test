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
- [Callbacks](#callbacks)
  - [SpeedTestCallbacks](#speedtestcallbacks)
  - [SpeedTestStage](#speedteststage)
  - [Callback timing and order](#callback-timing-and-order)
- [Providers](#providers)
  - [Location provider](#location-provider)
    - [SpeedTestLocation](#speedtestlocation)
    - [SpeedTestLocationProvider](#speedtestlocationprovider)
  - [Network provider](#network-provider)
    - [SpeedTestNetworkProvider](#speedtestnetworkprovider)
    - [SpeedTestNetworkProviderContext](#speedtestnetworkprovidercontext)
    - [SpeedTestNetworkSnapshot](#speedtestnetworksnapshot)
  - [Device metadata provider](#device-metadata-provider)
    - [DeviceMetadataProvider](#devicemetadataprovider)
    - [DefaultDeviceMetadataProvider](#defaultdevicemetadataprovider)
    - [DeviceInfoConfigOverrides](#deviceinfoconfigoverrides)
    - [CoreSystemOverrides](#coresystemoverrides)
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
  - [NetworkTestResultCellularInfo](#networktestresultcellularinfo)
  - [NetworkTestResultMeasurements](#networktestresultmeasurements)
  - [NetworkTestResultSpeedTimePair](#networktestresultspeedtimepair)
  - [NetworkTestResultStage](#networktestresultstage)
  - [NetworkTestResultBandInfo](#networktestresultbandinfo)
  - [NetworkTestResultWiFiInfo](#networktestresultwifiinfo)
  - [NetworkTestResultWiredInfo](#networktestresultwiredinfo)
  - [BrowserInfo](#browserinfo)
  - [Type aliases](#type-aliases)
- [API clients](#api-clients)
  - [SpeedTestApiClient](#speedtestapiclient)
  - [API base URLs](#api-base-urls)
- [Utilities](#utilities)
  - [CancellationToken](#cancellationtoken)
  - [CancellationError](#cancellationerror)
  - [SpeedTestError](#speedtesterror)
  - [calculateSpeedMbps](#calculatespeedmbps)
  - [formatSpeed](#formatspeed)
  - [formatBytes](#formatbytes)
  - [formatLatency](#formatlatency)
  - [formatDeviceOS](#formatdeviceos)
  - [formatDeviceType](#formatdevicetype)
  - [formatBrowserDisplay](#formatbrowserdisplay)
  - [formatOSDisplay](#formatosdisplay)
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

Providers are registered after construction via dedicated methods: [`setLocationProvider()`](#setlocationprovider), [`setNetworkProvider()`](#setnetworkprovider), and [`setDeviceMetadataProvider()`](#setdevicemetadataprovider).

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

When each stage completes, the corresponding callback is fired. The returned payload is also asynchronously uploaded to CoverageMap; if upload fails, the payload is queued locally and retried in the background, alongside the test, when the next `run()` starts. Failed runs are uploaded too; cancelled runs are not.

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

#### `getDevice()`

```ts
getDevice(): NetworkTestResultDevice
```

Builds the `device` block that would be included in a result payload, using the active [`DeviceMetadataProvider`](#devicemetadataprovider). Does not run a speed test or make network requests. Useful for previewing device identity before a run or for UI that displays device context independently of testing.

---

#### `getLocation()`

```ts
getLocation(): Promise<NetworkTestResultLocation | null>
```

Resolves location using the same logic as `run()`: the active [`SpeedTestLocationProvider`](#speedtestlocationprovider) first, then IP geolocation from [`getConnectionInfo()`](#getconnectioninfo). Fetches connection info internally. Returns `null` when no coordinates are available from either source.

The returned `locationType` is `'device'` when coordinates come from the provider and `'ip'` when they come from connection info.

---

#### `getNetwork()`

```ts
getNetwork(): Promise<ResolvedSpeedTestNetwork>
```

Resolves network metadata using the same logic as `run()`: the active [`SpeedTestNetworkProvider`](#speedtestnetworkprovider) merged with runtime connection-type detection and connection-info defaults. Fetches connection info internally. Returns `connectionType`, `cellular`, `wifi`, `wired`, and a `source` field indicating whether the snapshot came from `'provider'` or `'deviceMetadata'`.

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
| `provider` | `SpeedTestLocationProvider \| null` | Yes | Provider callback used for subsequent `getServers()`, `refreshServers()`, `getLocation()`, and `run()` calls. |

---

#### `setNetworkProvider(provider)`

```ts
setNetworkProvider(provider: SpeedTestNetworkProvider | null): void
```

Updates the active network provider at runtime. Pass `null` to use default runtime-derived network metadata only.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `provider` | `SpeedTestNetworkProvider \| null` | Yes | Provider object applied to subsequent `getNetwork()` and `run()` calls for `connectionType`, `cellular`, `wifi`, and `wired` payload fields. |

---

#### `setDeviceMetadataProvider(provider)`

```ts
setDeviceMetadataProvider(provider: DeviceMetadataProvider | null): void
```

Updates the active device metadata provider at runtime. Pass `null` to restore the built-in `DefaultDeviceMetadataProvider`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `provider` | `DeviceMetadataProvider \| null` | Yes | Provider instance applied to subsequent `getDevice()` and `run()` calls for the `device` block in the result payload. |

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
  throughputThreads?: number;
  transport?: 'auto' | 'tcp' | 'ws' | 'wss';
  browserWorker?: boolean;
  nodeWebSocket?: boolean;
}
```

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `pingCount` | `number` | `15` | 5 – 50 | Number of RTT probes collected during the latency stage. Higher values produce a more stable baseline; lower values shorten total run time. |
| `downloadDurationMs` | `number` | `7000` | 3000 – 30000 | Duration of the sustained download throughput stage in milliseconds. Longer durations improve smoothing on unstable links. |
| `uploadDurationMs` | `number` | `7000` | 3000 – 30000 | Duration of the sustained upload throughput stage in milliseconds. Behaves like `downloadDurationMs` for upstream. |
| `snapshotIntervalMs` | `number` | `100` | 50 – 5000 | Interval between progress snapshots emitted during sustained throughput stages. Lower values increase callback frequency. |
| `latencyTimeoutMs` | `number` | `10000` | 3000 – 30000 | Maximum time allowed for the latency stage to collect sufficient probe responses. The stage fails if this window is exceeded. |
| `estimationTimeoutMs` | `number` | `15000` | 3000 – 30000 | Maximum time allowed for download and upload estimation phases. Prevents the run from hanging during pre-throughput sizing. |
| `throughputThreads` | `number` | `0` | 0 – 64 | Threads the download and upload stages spread their sockets across when the estimate is 1 Gbps or more. `0` picks automatically (6), `1` keeps every socket on the calling thread. Extra threads are Node.js worker threads, at most one per CPU core; browsers ignore it. |
| `transport` | `string` | `'auto'` | `auto`, `tcp`, `ws`, `wss` | How sockets connect. The speed test carries no private data, so `auto` uses the fastest transport the server's `protocols` list and only encrypts where it must: [raw TCP](./protocol.md#raw-tcp-transport) in Node.js, then plain WebSocket, then secure WebSocket, which browsers need on HTTPS pages. If the first connection cannot open within 3 seconds, the run moves on to the next one. Raw TCP needs far less client CPU at multi-gigabit speeds. `tcp`, `ws`, and `wss` always use that one transport; `tcp` fails in browsers and `ws` fails on HTTPS pages. |
| `browserWorker` | `boolean` | `true` | `true`, `false` | In browsers, runs every stage's sockets and timing in a dedicated Web Worker, so the page's own work (rendering progress, for example) cannot lower the measured speeds or inflate latency. The worker is embedded in the library and started from a `blob:` URL, so no bundler setup is needed. Where it cannot start (a Content Security Policy without `worker-src blob:`, no `Worker` support) or the page installed its own `WebSocket`, the test runs on the main thread. `false` always uses the main thread. Ignored outside browsers. See [Browser Worker](./protocol.md#browser-worker). |
| `nodeWebSocket` | `boolean` | `true` | `true`, `false` | In Node.js, opens `ws://` and `wss://` sockets with the library's own WebSocket client, which counts download data without copying it and does not mask upload data byte by byte. `false` uses `globalThis.WebSocket` for every socket instead, for applications that need their own implementation (an HTTP proxy, extra headers, custom TLS options); a polyfill then keeps every socket on one thread. Raw TCP is unaffected. Ignored outside Node.js. See [Node.js WebSocket client](./protocol.md#nodejs-websocket-client). |

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
| `latency` | `boolean` | `true` | Enables the latency stage. When it is disabled, the first download or upload phase still sends one silent `PING` to measure the latency its timing subtracts, but that ping is not reported: the result's `latency`, `jitter`, and `latenciesList` are `null` and `onComplete` receives `null` latency data. |
| `download` | `boolean` | `true` | Enables the download estimation and sustained download throughput stages. |
| `upload` | `boolean` | `true` | Enables the upload estimation and sustained upload throughput stages. |

At least one stage must be enabled. Constructing an engine with all three set to `false` throws immediately.

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
  onComplete?: (
    latencyData: LatencyTestData | null,
    downloadData: SpeedTestData | null,
    uploadData: SpeedTestData | null,
    result: NetworkTestResultTestResults
  ) => void;
  onError?: (error: Error, stage: SpeedTestStage) => void;
}
```

| Handler | Parameters | Description |
|---------|------------|-------------|
| `onStageChange` | `stage: SpeedTestStage` | Fired whenever the engine transitions to a new stage. |
| `onLatencyPing` | `latencyMs: number, index: number` | Fired after each individual ping response is received. `index` is 0-based. Only fires during the full latency stage; not fired for the silent single-ping fallback. |
| `onLatencyResult` | `data: LatencyTestData` | Fired once when the full latency stage aggregation completes. |
| `onDownloadProgress` | `snapshot: SpeedSnapshot` | Fired repeatedly during the sustained download stage at `snapshotIntervalMs` intervals. Its `speedMbps` is the live speed, which eases into the measured speed over the first second of the measurement (see [`SpeedSnapshot`](#speedsnapshot)). |
| `onDownloadResult` | `data: SpeedTestData` | Fired once when the sustained download stage completes with the final aggregated result. `data.loadedLatency` contains under-load latency measurements collected concurrently during the stage. |
| `onUploadProgress` | `snapshot: SpeedSnapshot` | Fired repeatedly during the sustained upload stage, with the live speed like `onDownloadProgress`. |
| `onUploadResult` | `data: SpeedTestData` | Fired once when the sustained upload stage completes with the final aggregated result. `data.loadedLatency` contains under-load latency measurements collected concurrently during the stage. |
| `onComplete` | `latencyData, downloadData, uploadData, result` | Fired after the run assembles final measurements. The first three arguments are the aggregated stage results (`null` if that stage was not run or did not complete). `result` is the complete `NetworkTestResultTestResults` payload — the same object returned by `run()`. A copy is uploaded to CoverageMap before this callback runs, so changing `result` doesn't change the upload. |
| `onError` | `error: Error, stage: SpeedTestStage` | Fired for non-cancellation stage failures. Cancellation does not emit this. Errors the library raises carry a `reason` (`SpeedTestFailureReason`, see [`SpeedTestError`](#speedtesterror)). |

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
13. `onComplete(latencyData, downloadData, uploadData, result)`

On failure: `onError(error, stage)` is emitted; subsequent stages do not run.

On cancellation: no `onError` is emitted; the result payload records the cancellation.

---

## Providers

The engine exposes three optional provider hooks for supplying context it cannot derive on its own. Each provider is registered via a dedicated engine method and can be swapped at runtime between runs.

---

### Location provider

The location provider tells the engine where the test device is. Coordinates are used for server selection and stamped into `results.location` in the result payload. Registered via `setLocationProvider()`.

#### SpeedTestLocation

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

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `latitude` | `number` | Yes | Geographic latitude in decimal degrees. |
| `longitude` | `number` | Yes | Geographic longitude in decimal degrees. |
| `elevation` | `number \| null` | No | Altitude in meters above sea level. |
| `heading` | `number \| null` | No | Compass heading in degrees (0–360). |
| `speed` | `number \| null` | No | Movement speed in m/s. |

---

#### SpeedTestLocationProvider

Callback type used by `setLocationProvider()`. The provider receives connection metadata and returns coordinates or `null`.

```ts
interface SpeedTestLocationProviderContext {
  connectionInfo: ConnectionInfo | null;
}

type SpeedTestLocationProvider = (context: SpeedTestLocationProviderContext) =>
  | SpeedTestLocation
  | null
  | Promise<SpeedTestLocation | null>;
```

| Field | Type | Description |
|-------|------|-------------|
| `connectionInfo` | `ConnectionInfo \| null` | IP connection metadata fetched at run start. Available as a fallback source for coordinates. |

Return `null` when live location is unavailable. The engine silently falls back to IP geolocation from `connectionInfo`. `results.location.locationType` will be `'ip'` in that case; when coordinates are provided by a provider it will be `'device'`.

---

### Network provider

The network provider supplies connection type and detailed signal metadata for cellular, Wi-Fi, and wired connections. Output is written into the `connectionType`, `cellular`, `wifi`, and `wired` fields of the result payload. Registered via `setNetworkProvider()`.

#### SpeedTestNetworkProvider

Object interface used by `setNetworkProvider()`. Implement only the methods you need — the engine falls back to its default detection for any method not present on the object.

```ts
interface SpeedTestNetworkProvider {
  getConnectionType?(context: SpeedTestNetworkProviderContext): ConnectionType | null | Promise<ConnectionType | null>;
  getCellularMetadata?(context: SpeedTestNetworkProviderContext): Partial<NetworkTestResultCellularInfo> | null | Promise<Partial<NetworkTestResultCellularInfo> | null>;
  getWifiMetadata?(context: SpeedTestNetworkProviderContext): Partial<NetworkTestResultWiFiInfo> | null | Promise<Partial<NetworkTestResultWiFiInfo> | null>;
  getWiredMetadata?(context: SpeedTestNetworkProviderContext): Partial<NetworkTestResultWiredInfo> | null | Promise<Partial<NetworkTestResultWiredInfo> | null>;
}
```

| Method | Return type | Description |
|--------|-------------|-------------|
| `getConnectionType?(context)` | `ConnectionType \| null` | Override the runtime-detected connection type. Return `null` to keep the default. |
| `getCellularMetadata?(context)` | `Partial<NetworkTestResultCellularInfo> \| null` | Supply cellular signal fields. Return `null` to force the `cellular` block to `null`. |
| `getWifiMetadata?(context)` | `Partial<NetworkTestResultWiFiInfo> \| null` | Supply Wi-Fi signal fields. Return `null` to force the `wifi` block to `null`. |
| `getWiredMetadata?(context)` | `Partial<NetworkTestResultWiredInfo> \| null` | Supply wired link fields. Return `null` to force the `wired` block to `null`. |

Each method is called independently. Methods not present on the object leave their corresponding payload block at its runtime-derived default. Partial return values are merged onto the default — only the fields you return are overwritten.

---

#### SpeedTestNetworkProviderContext

Passed to each network provider method. Contains the runtime-detected network state available before the provider is consulted.

```ts
interface SpeedTestNetworkProviderContext {
  connectionInfo: ConnectionInfo | null;
  connectionType: ConnectionType;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `connectionInfo` | `ConnectionInfo \| null` | IP connection metadata from `/v1/connection`. |
| `connectionType` | `ConnectionType` | Runtime-detected connection type (`'wifi'`, `'mobile'`, `'wired'`, etc.). |

---

#### SpeedTestNetworkSnapshot

The resolved network state assembled by the engine after applying provider overrides.

```ts
interface SpeedTestNetworkSnapshot {
  connectionType: ConnectionType;
  cellular: NetworkTestResultCellularInfo | null;
  wifi: NetworkTestResultWiFiInfo | null;
  wired: NetworkTestResultWiredInfo | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `connectionType` | `ConnectionType` | Final resolved connection type written to the result payload. |
| `cellular` | `NetworkTestResultCellularInfo \| null` | Cellular signal metadata, present when connection type is mobile. |
| `wifi` | `NetworkTestResultWiFiInfo \| null` | Wi-Fi metadata, present when connection type is Wi-Fi. |
| `wired` | `NetworkTestResultWiredInfo \| null` | Wired link metadata, present when connection type is wired or unknown. |

---

### Device metadata provider

The device metadata provider controls how the engine identifies the device and assembles the `device` block in the result payload — device ID, browser name, OS, connection type, and host telemetry. Registered via `setDeviceMetadataProvider()`.

#### DeviceMetadataProvider

Interface for custom device metadata implementations. Replace the built-in provider when running in non-standard runtimes (Electron, React Native, serverless, host-bridged environments).

```ts
interface DeviceMetadataProvider {
  getDeviceId(config: DeviceMetadataProviderConfig): string;
  parseBrowserInfo(): ParsedBrowserInfo;
  parseOSInfo(): ParsedOSInfo;
  getBrowserInfo(): BrowserInfo;
  buildDeviceResult(config: DeviceMetadataProviderConfig): NetworkTestResultDevice;
}
```

| Method | Return type | Description |
|--------|-------------|-------------|
| `getDeviceId(config)` | `string` | Returns a persistent device identifier. |
| `parseBrowserInfo()` | `ParsedBrowserInfo` | Parses browser name, version, and engine. |
| `parseOSInfo()` | `ParsedOSInfo` | Parses OS name and version. |
| `getBrowserInfo()` | `BrowserInfo` | Returns the full browser fingerprint. |
| `buildDeviceResult(config)` | `NetworkTestResultDevice` | Assembles the complete device metadata payload written to the result. |

**`DeviceMetadataProviderConfig`**

```ts
interface DeviceMetadataProviderConfig {
  deviceIdStorageKey: string;
  application: NetworkTestResultApplicationInfo;
  coreSystem: CoreSystemOverrides;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `deviceIdStorageKey` | `string` | Storage key used to persist the device identifier. |
| `application` | `NetworkTestResultApplicationInfo` | Application metadata from the engine constructor options. |
| `coreSystem` | `CoreSystemOverrides` | Host-level telemetry overrides from `options.deviceInfo.coreSystem`. |

---

#### DefaultDeviceMetadataProvider

The built-in implementation using `ua-parser-js` and browser/Node.js APIs. Registered automatically when using `SpeedTestEngine`.

```ts
import { DefaultDeviceMetadataProvider } from '@coveragemap/speed-test';

const provider = new DefaultDeviceMetadataProvider();
```

Implements all methods of `DeviceMetadataProvider`. Reads device identity from `localStorage`, detects browser and OS from `navigator.userAgent`, and reads host telemetry from `process` in Node.js environments. Replace it via `setDeviceMetadataProvider()` when default detection is insufficient for your runtime.

---

#### DeviceInfoConfigOverrides

Passed as `options.deviceInfo` to the engine constructor. Controls device ID persistence and host-level telemetry without replacing the full provider.

```ts
interface DeviceInfoConfigOverrides {
  deviceIdStorageKey?: string;
  coreSystem?: CoreSystemOverrides;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `deviceIdStorageKey` | `string` | Local storage key used to persist the device identifier across sessions. Defaults to an internal key. |
| `coreSystem` | `CoreSystemOverrides` | Overrides for host-level telemetry fields merged onto the auto-detected `device.coreSystem` block. |

---

#### CoreSystemOverrides

Optional overrides for host-level telemetry fields. Useful for backend and worker contexts where runtime-derived values are incomplete or unavailable.

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
| `hostName` | `string \| null` | Machine hostname to emit in the result payload. |
| `processId` | `number \| null` | OS process identifier. |
| `platform` | `string \| null` | Runtime platform label (e.g. `'linux'`, `'win32'`). |
| `architecture` | `string \| null` | CPU architecture (e.g. `'x64'`, `'arm64'`). |
| `runtimeVersion` | `string \| null` | Runtime version string (e.g. Node.js version). |
| `uptimeSeconds` | `number \| null` | Process uptime in seconds. |
| `memoryRssMb` | `number \| null` | Resident set size memory in MB. |

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
  selfHosted?: boolean;
  protocols?: string[];
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
| `protocols` | `string[]` *(optional)* | Transports the server accepts with the speed test protocol version on each: `TCPv1` (raw TCP), `WSv1` (WebSocket), `WSSv1` (secure WebSocket). Absent for servers that predate the field, which are treated as `["WSSv1"]` (`["WSv1"]` when `id` is `"local"`). `config.transport: 'auto'` only uses transports that are listed. |
| `selfHosted` | `boolean` *(optional)* | `true` for a self-hosted server the user entered manually. Absent for CoverageMap network servers. Results upload to CoverageMap but are not mapped when this flag is present. |

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
| `speedMbps` | `number` | Throughput so far. In `SpeedTestData.snapshots` (and the result's `downloadList` / `uploadList`), by the same rule as the stage's final `speedMbps`: over the whole stage until the measurement start (250 ms after the first bytes), from the measurement start afterwards. In `onDownloadProgress` / `onUploadProgress`, the live speed: the same until the measurement start, then moving in a straight line from the whole-stage speed to the measured speed over the next 1,000 ms, and the measured speed from then on. Right after the measurement start the measured window is only milliseconds long and holds no message or `ACK` at all, or a whole one, so switching to it at once made a speed gauge jump and flicker. |
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
  loadedLatency: LatencyTestData | null;
  initialConnectionCount: number;
  requestedConnectionCount: number;
  connectionCount: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `durationMs` | `number` | Total stage duration in milliseconds. |
| `speedMbps` | `number` | Final throughput result in Mbps, measured from 250 ms after the stage's first counted bytes (the first `ACK`, for upload) to its end, so the slow start of the connections does not lower it. Everything after that point counts, so a ramp-up that lasts longer still lowers it. A stage that ended before that point is measured as a whole: `bytes / (max(durationMs - (latencyMs + jitterMs), 1) * 125)`. This is the value reported as `downloadSpeed` / `uploadSpeed`. See [Measurement Model](./protocol.md#measurement-model). |
| `bytes` | `number` | Total bytes transferred during the stage. |
| `snapshots` | `SpeedSnapshot[]` | All progress snapshots collected during the stage. |
| `loadedLatency` | `LatencyTestData \| null` | Latency measurements collected concurrently while throughput was saturated. `null` if no pings were completed during the stage, including a stage that ended less than 1 s after its first bytes. |
| `initialConnectionCount` | `number` | Connections the stage started with, picked from its estimate. |
| `requestedConnectionCount` | `number` | Connections the stage asked for: the initial ones and the ones its scale-up added. At 1, 2, and 3 s after the first bytes, a stage whose speed over the last 500 ms calls for more connections (with a 25% margin) opens them; see [Scale-up](./protocol.md#scale-up). After a scale-up `speedMbps` is measured from 250 ms after the added connections carried data. |
| `connectionCount` | `number` | Connections that carried the stage: the initial ones and the added ones that opened. This is the result's `downloadConnectionCount` / `uploadConnectionCount`. |

`loadedLatency` is measured by sending PING/PONG probes, 500 ms apart, over a dedicated connection that opens when the download or upload stage starts. The first probe waits until the link carries the stage's traffic: 1 s after the stage's first counted bytes (the first `ACK`, for upload), independent of the 250 ms ramp-up exclusion of the speed. Because the link is under load during these probes, the values reflect real-world latency under congestion — sometimes called "bufferbloat" or "under-load latency" — rather than the idle RTT captured by the pre-test latency stage. Compare it against the pre-test [`LatencyTestData`](#latencytestdata) from `onLatencyResult` to quantify how much latency increases when the connection is saturated.

---

## Result payload

The complete payload produced by `run()` and uploaded to CoverageMap. The definitions live in [`src/types/test-results.ts`](../src/types/test-results.ts); [Result schema](./result-schema.md) explains how each field is measured and when it is `null`.

### NetworkTestResultTestResults

Top-level container for a single test run.

```ts
interface NetworkTestResultTestResults {
  source: 'external';
  version: number;
  device: NetworkTestResultDevice;
  testType: NetworkTestResultTestType;
  results: NetworkTestResultResults;
  stages: NetworkTestResultStage[] | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `source` | `'external'` | Always `'external'`: the result comes from an application built on this library (or the native engine's external format). CoverageMap's own app sends no `source`. |
| `version` | `number` | Payload schema version, currently `1`. New fields are added without changing it. |
| `device` | `NetworkTestResultDevice` | Device and application metadata at the time of the test. |
| `testType` | `NetworkTestResultTestType` | Which stages ran and how they were sized. |
| `results` | `NetworkTestResultResults` | Measurements and network context. |
| `stages` | `NetworkTestResultStage[] \| null` | Stage markers, in order. |

---

### NetworkTestResultDevice

Device, browser, OS, and application metadata.

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

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string \| null` | Persistent device identifier (UUID, stored in local storage by default). |
| `manufacturer` | `string` | Device manufacturer. |
| `nameId` | `string \| null` | Machine-readable device name identifier. |
| `name` | `string` | Human-readable device name. |
| `os` | `DeviceOS` | Operating system. |
| `osVersion` | `string` | OS version string. |
| `appName` | `string \| null` | From `application.name`. |
| `appVersion` | `string \| null` | From `application.version`. |
| `application` | `NetworkTestResultApplicationInfo` | Application metadata from the constructor options. |
| `browserName`, `browserVersion` | `string \| null` | Browser name and version (browser runtimes). |
| `browserEngine`, `browserEngineVersion` | `string \| null` | Browser engine (e.g. `Blink`, `WebKit`) and its version. |
| `cpuArchitecture` | `string \| null` | CPU architecture. |
| `cpuCores` | `number \| null` | Logical CPU core count. |
| `deviceMemoryGb` | `number \| null` | Device memory reported by the browser. |
| `deviceType`, `deviceVendor`, `deviceModel` | `string \| null` | Device classification from the user agent or the device metadata provider. |
| `isMobile` | `boolean` | Whether the device is classified as mobile. |
| `language` | `string \| null` | Language string. |
| `timezone` | `string \| null` | IANA timezone string. |
| `coreSystem` | `NetworkTestResultCoreSystemInfo \| null` | Host-level runtime telemetry; `null` where it is not collected. |

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
| `runtime` | `RuntimeType` | Runtime environment: `'browser'`, `'node'`, or `'unknown'`. |
| `hostName` | `string \| null` | Machine hostname. |
| `processId` | `number \| null` | OS process identifier. |
| `platform` | `string \| null` | OS platform label. |
| `architecture` | `string \| null` | CPU architecture string. |
| `runtimeVersion` | `string \| null` | Runtime version (e.g. Node.js version). |
| `uptimeSeconds` | `number \| null` | Process uptime in seconds. |
| `memoryRssMb` | `number \| null` | Resident set size memory in MB. |

---

### NetworkTestResultTestType

Which stages ran and how they were sized.

```ts
interface NetworkTestResultTestsRun {
  latency: boolean;
  download: boolean;
  upload: boolean;
}

interface NetworkTestResultTestType {
  id: string;
  sessionId: string;
  type: TestTypeSingleMultiple;
  testIndex: number | null;
  testCount: number | null;
  tag: LocationTag;
  testsRun: NetworkTestResultTestsRun;
  downloadTestDuration: number | null;
  uploadTestDuration: number | null;
  testProtocol: string;
  downloadConnectionCount: number | null;
  uploadConnectionCount: number | null;
  requestedDownloadConnectionCount: number | null;
  establishedDownloadConnectionCount: number | null;
  requestedUploadConnectionCount: number | null;
  establishedUploadConnectionCount: number | null;
  downloadPacketSize: number | null;
  uploadPacketSize: number | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique test run identifier. |
| `sessionId` | `string` | Identifier of the engine instance, shared by its runs. |
| `type` | `TestTypeSingleMultiple` | Always `'single'` for the library. |
| `testIndex`, `testCount` | `number \| null` | Position in a sequence of runs: `0` and `1` for the library. |
| `tag` | `LocationTag` | Location context tag: `'other'` for the library. |
| `testsRun` | `NetworkTestResultTestsRun` | The stages that were enabled (`SpeedTestSelection`). |
| `downloadTestDuration`, `uploadTestDuration` | `number \| null` | Configured stage duration in ms; `null` when the stage was not enabled. |
| `testProtocol` | `string` | Transport used: `'TCP'` for raw TCP, `'WS'` for WebSocket, `'WSS'` for secure WebSocket. |
| `downloadConnectionCount`, `uploadConnectionCount` | `number \| null` | Connections that carried the throughput stage (the established count). `null` when the stage did not complete. |
| `requestedDownloadConnectionCount`, `requestedUploadConnectionCount` | `number \| null` | Connections the throughput stage asked for, from the estimate (1, 2, 4, 6, 8, or 12). `null` when estimation did not complete. |
| `establishedDownloadConnectionCount`, `establishedUploadConnectionCount` | `number \| null` | Connections that opened. A throughput stage starts only once every connection is open, so this equals the requested count; `null` when the stage did not complete. |
| `downloadPacketSize`, `uploadPacketSize` | `number \| null` | Throughput stage message (download) or chunk (upload) size in KiB; `null` when estimation did not complete. |

---

### NetworkTestResultResults

Measurements and network context.

```ts
interface NetworkTestResultResults {
  dateTime: string;
  connectionType: string | null;
  externalIpAddress: string | null;
  ispName: string | null;
  testStatus: TestStatus;
  location: NetworkTestResultLocation | null;
  server: SpeedTestServer | null;
  cellular: NetworkTestResultCellularInfo | null;
  wifi: NetworkTestResultWiFiInfo | null;
  wired: NetworkTestResultWiredInfo | null;
  measurements: NetworkTestResultMeasurements;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `dateTime` | `string` | ISO 8601 UTC timestamp (`Z`) when the result was assembled, at the end of the run. |
| `connectionType` | `string \| null` | Connection type (`ConnectionType` values) from the network provider. |
| `externalIpAddress` | `string \| null` | Client public IP address from the connection lookup. |
| `ispName` | `string \| null` | ISP or AS organization of the client (`connectionInfo.client.asOrg`). |
| `testStatus` | `TestStatus` | `'passed'`, or `'failed'` when a stage failed or the run was cancelled. |
| `location` | `NetworkTestResultLocation \| null` | Client location at the last stage marker. |
| `server` | `SpeedTestServer \| null` | The server tested against, as listed or supplied. |
| `cellular`, `wifi`, `wired` | see below | Network details for the active connection type, `null` otherwise. |
| `measurements` | `NetworkTestResultMeasurements` | The measured values. |

---

### NetworkTestResultLocation

Client geographic coordinates.

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

| Field | Type | Description |
|-------|------|-------------|
| `latitude` | `number` | Geographic latitude. |
| `longitude` | `number` | Geographic longitude. |
| `elevation` | `number \| null` | Elevation in meters. |
| `heading` | `number \| null` | Compass heading in degrees. |
| `speed` | `number \| null` | Movement speed in m/s. |
| `locationType` | `LocationType` | `'device'` when the location provider supplied it, `'ip'` when it came from the connection lookup. |

---

### NetworkTestResultCellularInfo

Present when the connection type is `mobile`, or when a network provider supplies it.

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
```

---

### NetworkTestResultMeasurements

The measured values of every enabled stage.

```ts
interface NetworkTestResultMeasurements {
  dateTime: string | null;
  estimatedDownloadSpeed: number | null;
  estimatedUploadSpeed: number | null;
  downloadSpeed: number | null;
  totalDownload: number | null;
  uploadSpeed: number | null;
  totalUpload: number | null;
  latency: number | null;
  jitter: number | null;
  latenciesList: number[] | null;
  loadedDownloadLatencies: number[] | null;
  loadedUploadLatencies: number[] | null;
  downloadList: NetworkTestResultSpeedTimePair[] | null;
  uploadList: NetworkTestResultSpeedTimePair[] | null;
  failedReason: string | null;
  failedStage: TestStage | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `dateTime` | `string \| null` | ISO 8601 UTC timestamp (`Z`) when the test started. |
| `estimatedDownloadSpeed`, `estimatedUploadSpeed` | `number \| null` | Mbps measured by the estimation stage, which sizes the throughput stage. Rounded to 3 decimals; `null` when estimation did not complete. |
| `downloadSpeed`, `uploadSpeed` | `number \| null` | Throughput stage speed in Mbps, measured from 250 ms after the stage's first counted bytes to its end. |
| `totalDownload`, `totalUpload` | `number \| null` | Bytes of the whole throughput stage, ramp-up included. |
| `latency` | `number \| null` | **Minimum** round trip of the latency stage, in ms. `null` when the latency stage was not enabled. |
| `jitter` | `number \| null` | **Median** difference between consecutive round trips of the latency stage, in ms. `null` when the latency stage was not enabled. |
| `latenciesList` | `number[] \| null` | Every round trip of the latency stage. `null` when the latency stage was not enabled. |
| `loadedDownloadLatencies`, `loadedUploadLatencies` | `number[] \| null` | Round trips measured during each throughput stage, from 1 s after its first counted bytes. `null` if the stage did not run or no ping completed. |
| `downloadList`, `uploadList` | `NetworkTestResultSpeedTimePair[] \| null` | Progress snapshots of each throughput stage. |
| `failedReason` | `string \| null` | `"<reason>: <message>"` when a stage failed, `"Cancelled"` when the run was cancelled. See [Result schema](./result-schema.md#failedreason). |
| `failedStage` | `TestStage \| null` | Start marker of the phase that failed: `'latencyStart'`, `'downloadStart'`, or `'uploadStart'`. For a cancelled run (`failedReason: 'Cancelled'`, never uploaded) it is the engine stage it was cancelled in instead, such as `'latency'` or `'download'`. |

---

### NetworkTestResultSpeedTimePair

A single progress snapshot in the result payload.

```ts
interface NetworkTestResultSpeedTimePair {
  time: number;
  speed: number;
  data: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `time` | `number` | Milliseconds since the throughput stage started, rounded. |
| `speed` | `number` | Speed in Mbps at this moment, by the same rule as the final speed. |
| `data` | `number` | Bytes counted so far in the stage. |

---

### NetworkTestResultStage

A stage marker: when a phase started or ended, with the network context at that moment.

```ts
interface NetworkTestResultStage {
  testStage: string;
  dateTime: string;
  connectionType: string | null;
  externalIpAddress: string | null;
  ispName: string | null;
  location: NetworkTestResultLocation | null;
  cellular: NetworkTestResultCellularInfo | null;
  wifi: NetworkTestResultWiFiInfo | null;
  wired: NetworkTestResultWiredInfo | null;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `testStage` | `string` | A `TestStage` value: `latencyStart`, `latencyEnd`, `downloadStart`, `downloadEnd`, `uploadStart`, `uploadEnd`. |
| `dateTime` | `string` | ISO 8601 UTC timestamp (`Z`) of the marker. |
| `connectionType`, `externalIpAddress`, `ispName` | `string \| null` | Network context at the marker. |
| `location` | `NetworkTestResultLocation \| null` | Location at the marker. |
| `cellular`, `wifi`, `wired` | see below | Network details at the marker. |

---

### NetworkTestResultBandInfo

A cellular band.

```ts
interface NetworkTestResultBandInfo {
  bandNumber: number;
  bandwidth: number;
  technology: string | null;
}
```

---

### NetworkTestResultWiFiInfo

Present when the connection type is `wifi`, or when a network provider supplies it.

```ts
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
```

---

### NetworkTestResultWiredInfo

Present when the connection type is `wired`, or when a network provider supplies it.

```ts
interface NetworkTestResultWiredInfo {
  ispName: string | null;
  macAddress: string | null;
  dataLink: number | null;
}
```

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
type DeviceOS = 'iOS' | 'android' | 'iPadOS' | 'windows' | 'mac' | 'linux' | 'chromeos' | 'web';

type TestStatus = 'passed' | 'failed';

type TestTypeSingleMultiple = 'single' | 'multiple';

type LocationTag = 'indoor' | 'outdoor' | 'driving' | 'other';

type LocationType = 'device' | 'ip';

type TestStage =
  | 'latencyStart'
  | 'latencyEnd'
  | 'downloadStart'
  | 'downloadEnd'
  | 'uploadStart'
  | 'uploadEnd';

type ConnectionType = 'wifi' | 'mobile' | 'wired' | 'bluetooth' | 'none' | 'unknown';

type RuntimeType = 'browser' | 'node' | 'unknown';

type ApplicationType = 'web' | 'backend' | 'mobile' | 'desktop' | 'cli' | 'serverless' | 'other';

type SpeedTestFailureReason =
  | 'unreachable'
  | 'connectionFailed'
  | 'connectionTimeout'
  | 'transferTimeout'
  | 'timeout'
  | 'protocolError'
  | 'unknown';
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
new SpeedTestApiClient(overrides?: ApiBaseUrlOverrides)
```

Omitted `overrides` properties fall back to the library’s default production base URLs. Call `setLocationProvider()` after construction to supply a custom location source for server discovery.

#### `getServers()`

```ts
getServers(): Promise<SpeedTestServer[]>
```

Returns the filtered server inventory (premium servers excluded). Results are cached for 30 minutes; subsequent calls within that window return the cached list when location has not changed. Location is resolved from the provider registered via `setLocationProvider()`, then falls back to `getConnectionInfo()` coordinates. Throws on HTTP errors or malformed responses.

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

`SpeedTestEngine` requires `coverageMapApiBaseUrl` to be an `https://` URL on `coveragemap.com` or a subdomain (or a loopback URL when `speedApiBaseUrl` is loopback too), and throws otherwise.

`CoverageMapApiClient` constructor: `new CoverageMapApiClient(overrides?: ApiBaseUrlOverrides)`.

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

### SpeedTestError

An error tagged with why the test failed. The stages raise it (or `SocketConnectError`, which extends it) and `onError` receives it; the result's `failedReason` is built from it with `formatFailedReason`.

```ts
import { SpeedTestError, getFailureReason, formatFailedReason } from '@coveragemap/speed-test';

class SpeedTestError extends Error {
  readonly reason: SpeedTestFailureReason;
  constructor(reason: SpeedTestFailureReason, message: string);
}

getFailureReason(error: unknown): SpeedTestFailureReason; // error.reason, or 'unknown'
formatFailedReason(error: unknown): string; // "<reason>: <message>"
```

| Reason | Meaning |
|--------|---------|
| `unreachable` | No transport the server offers can be used from this runtime. |
| `connectionFailed` | A connection was refused, could not be created, or dropped. |
| `connectionTimeout` | A connection did not open in time. |
| `transferTimeout` | A throughput stage did not move data. |
| `timeout` | A stage did not finish in time after it connected. |
| `protocolError` | The server answered with something the protocol does not allow. |
| `unknown` | Anything else. |

The reasons are the native engine's `FailureReason` values, so failures from every CoverageMap client group the same way.

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

### formatDeviceOS

```ts
formatDeviceOS(os: DeviceOS | string | null | undefined): string
```

Returns a display label for a canonical `DeviceOS` slug (e.g. `'windows'` → `"Windows"`, `'mac'` → `"macOS"`).

---

### formatDeviceType

```ts
formatDeviceType(deviceType: string | null | undefined): string
```

Returns a display label for a device type value (e.g. `'desktop'` → `"Desktop"`, `'mobile'` → `"Mobile"`).

---

### formatBrowserDisplay

```ts
formatBrowserDisplay(name: string | null | undefined, version?: string | null): string
```

Returns a formatted browser label (e.g. `"Chrome 148.0.0.0"`).

---

### formatOSDisplay

```ts
formatOSDisplay(os: DeviceOS | string | null | undefined, osVersion?: string | null): string
```

Returns a formatted operating system label (e.g. `"Windows 10"`, `"macOS 14.2.1"`). Use this when presenting `device.os` (slug) together with `device.osVersion`.

The default device metadata provider also applies these formatting rules when building human-readable fields such as `name`, `browserName`, and `deviceType`. The canonical `device.os` slug is unchanged for API compatibility.

---

### generateUUID

```ts
generateUUID(): string
```

Generates a UUID v4 string using `crypto.randomUUID()` when available, with a fallback for environments that do not support it.

---

## See also

- [Providers](./providers.md) — In-depth reference for `SpeedTestLocationProvider`, `SpeedTestNetworkProvider`, and `DeviceMetadataProvider` — context fields, merge semantics, RF signal field tables, and custom implementation guide
- [Protocol](./protocol.md) — WebSocket message framing and stage wire protocol
- [Result Schema](./result-schema.md) — Full result payload field reference
- [Examples](./examples.md) — Integration examples for browser, Node.js, and serverless
