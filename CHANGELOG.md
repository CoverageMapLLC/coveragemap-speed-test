# Changelog

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
