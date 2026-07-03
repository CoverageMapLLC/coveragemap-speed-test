# Changelog

## 0.4.0

### New Features

- **Loaded latency monitoring** — Download and upload speed tests now run a concurrent PING/PONG WebSocket connection throughout each stage. The measured RTTs (latency under load) are exposed as `SpeedTestData.loadedLatency` (`LatencyTestData | null`) on the download and upload results, enabling bufferbloat / under-load latency analysis.
- **`loadedDownloadLatencies` and `loadedUploadLatencies` in result schema** — The `NetworkTestResultMeasurements` object now includes individual RTT sample arrays (`number[] | null`) collected by the loaded latency monitor during each throughput stage.

### Breaking Changes

- **`onComplete` callback signature changed** — The callback now receives structured stage result objects instead of raw numbers: `(latencyData: LatencyTestData | null, downloadData: SpeedTestData | null, uploadData: SpeedTestData | null, result: NetworkTestResultTestResults)`. Update any existing `onComplete` handlers accordingly.

### Bug Fixes

- **Jitter now reports median jitter** — The `jitterMs` field in test results was previously reporting `minJitter`; it now correctly reports `medianJitter`.

### Improvements

- **Upload performance** — Burst interval reduced from 10 ms to 5 ms and buffer size multiplier increased from ×8 to ×32, keeping the send pipeline full at higher link speeds.
- **Measurement precision** — Numeric measurements (speed, latency, jitter) are now rounded to 3 decimal places before being submitted.

## 0.3.1

### Bug Fixes

- **Prevent stale latency and jitter in live UI updates** — When a test completes, latency and jitter values from the latency test stage are now preserved rather than being overwritten by the final result snapshot. This eliminates a race condition where a later, less accurate value could replace the already-settled measurement visible in the UI.

### Demo & Developer Experience

- Extracted the `LiveMeasurements` type, `EMPTY_MEASUREMENTS` constant, and new `mergeCompletedMeasurements` helper into a dedicated `live-measurements.ts` module in the React Vite demo for better separation of concerns and reusability.

### Tests

- Added `test/live-measurements.test.ts` to cover both cases of `mergeCompletedMeasurements`: when the latency test is enabled (preserves latency-stage values) and when it is disabled (falls back to completed result values).
- Added a regression test in `test/engine-regression.test.ts` verifying that the engine uses the latency-stage result as the source of truth for final latency and jitter values.

## 0.3.0

### New Features

- **`getDevice()` on `SpeedTestEngine`** — Returns a `NetworkTestResultDevice` snapshot of the current device metadata without running a full test. Useful for previewing what device context will be attached to test results.
- **`getLocation()` on `SpeedTestEngine`** — Async method that resolves and returns the current `NetworkTestResultLocation` (or `null`) independently of a test run, using the configured location provider.
- **`getNetwork()` on `SpeedTestEngine`** — Async method that resolves and returns the current `ResolvedSpeedTestNetwork` independently of a test run, using the configured network provider.
- **Device formatting utilities** — New `src/utils/device-format.ts` module with exported helpers: `formatDeviceOS`, `formatDeviceType`, `formatBrowserName`, `formatBrowserDisplay`, `formatOSDisplay`, and `formatDisplayName`. These are now part of the public API via `src/utils/index.ts`.

### Improvements

- **Normalized device display names** — `DefaultDeviceMetadataProvider` now uses the new formatting helpers to produce consistent, human-readable values for OS name, browser name, browser engine, device type, and device vendor across all runtimes (browser and Node.js).

### Bug Fixes

- **Fix inaccurate upload speed snapshots** — Replaced the sliding acknowledgement-window calculation with a simpler total-acknowledged-bytes-over-elapsed-duration approach, removing the moving window state (`ackEvents`, `ackBytesInWindow`, `MIN_SNAPSHOT_WINDOW_MS`). This produces more stable and accurate real-time upload speed readings.

### Demo & Developer Experience

- Enhanced the React Vite demo with a new "Device & Location" panel that displays resolved device and location metadata using the new `getDevice()` and `getLocation()` methods.
- Added Vite and TypeScript path aliases in the demo to resolve `@coveragemap/speed-test` directly from the local source, eliminating the need to publish before testing locally.

## 0.2.2

### Bug Fixes & Refinements

- **Rename `ethernet` → `wired` connection type** — The connection type value `"ethernet"` has been renamed to `"wired"` across the codebase, documentation, and tests for consistent terminology. Existing usages of `"ethernet"` should be updated to `"wired"`.
- **Refactor `DeviceMetadataProvider` interface** — Removed the `reset` method from the `DeviceMetadataProvider` interface. To restore the built-in default provider, pass `null` to `setDeviceMetadataProvider` instead. Updated documentation and examples to reflect this change.

## 0.2.1

### Bug Fixes

- **Fix upload results submitted on cancellation** — `SpeedTestEngine` no longer calls `uploadResults` when a test run is cancelled mid-flight. A `wasCancelled` guard was added so partial results are not sent to the backend.
- **Fix inaccurate upload speed snapshots** — Upload throughput is now measured from server-acknowledged bytes (WebSocket ACK events) rather than raw bytes dispatched to the send buffer. Snapshots use a sliding acknowledgement window (`snapshotIntervalMs × 3`, minimum 300 ms) so real-time readings reflect actual throughput rather than buffered-but-unconfirmed data.

### New Features

- **`testsRun` result field** — `NetworkTestResult` now contains a `testsRun` object (`{ latency: boolean; download: boolean; upload: boolean }`) that records which test phases were enabled for the run.
- **`ispName` result field** — `NetworkTestResult.results` and per-stage objects now expose `ispName: string | null`, populated from connection info returned by the network provider.
- **`setDeviceMetadataProvider` on `SpeedTestEngine`** — Callers can now inject a custom `DeviceMetadataProvider` directly on the engine instance, consistent with `setNetworkProvider` and `setLocationProvider`. Pass `null` to restore the built-in `DefaultDeviceMetadataProvider`.

### CI / Internal

- Updated GitHub Actions publish workflow to Node.js 24 and `actions/setup-node@v6`.
- Added `production` environment to the npm publish job and enabled verbose logging with provenance.

## 0.2.0

### New Features

- **Network Provider API** — Introduced `setNetworkProvider` on `SpeedTestEngine`, allowing callers to supply custom network metadata (carrier, connection type, signal strength, etc.) that is attached to test results. New `NetworkProvider` type exported from `src/types/network-provider.ts`.
- **Device Metadata Provider** — Added `DeviceMetadataProvider` utility (`src/utils/device-metadata-provider.ts`) and updated `DeviceInfo` helpers to support richer, provider-driven device context.
- **Cellular / Wi-Fi / Wired result fields** — Result schema now includes structured `cellular`, `wifi`, and `wired` network objects. The previous flat `localIp` and `vpn` fields have been removed.
- **UUID validation for application IDs** — `SpeedTestEngine` now enforces that the `applicationId` is a valid UUID at construction time, surfacing configuration errors early.
- **React + Vite demo** — Added a complete demo application under `demos/react-vite/` showcasing live latency and throughput updates, server selection UI, and real-time metrics display.

### Documentation

- Added `docs/providers.md` — a dedicated guide covering the new provider architecture and usage examples.
- Updated `docs/library-api.md`, `docs/examples.md`, `docs/result-schema.md`, and `docs/backend-integration.md` to reflect the new provider structure and result schema.
- Added Fair Use Policy section to `README.md`.

### Other Changes

- Repository URLs and package metadata updated.
- Deploy workflow now uses secrets for API base URLs.

## 0.1.0

- Initial open-source release of `@coveragemap/speed-test`.
- Includes CoverageMap-first test engine, protocol runners, docs, examples, and automated test suites.
