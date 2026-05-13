# Changelog

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
