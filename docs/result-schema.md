# Result Schema Reference

This document explains the `NetworkTestResultTestResults` payload in practical terms.
Use it when integrating storage, analytics, or downstream reporting.

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

## `version`

- Schema version for compatibility tracking.
- Current value is `1`.
- Consumers should store this and gate parsing logic by version for future-proofing.

## `device`

Device/runtime metadata captured at run time.

Important categories:

- app identity (`appName`, `appVersion`, `application`),
- browser/device data when available,
- backend/runtime system data under `coreSystem`.

## `device.application` (required)

Captured from `SpeedTestEngineOptions.application`. These fields are always present in emitted results:

- `name`
- `version`
- `author`
- `organization`
- `type`

Optional fields (nullable when not provided):

- `website`

This object is the canonical application attribution block used for CoverageMap analytics/metrics segmentation.

## `device.coreSystem` (backend-focused)

Present for runtime/system telemetry and especially valuable outside browsers.

Fields:

- `runtime`: `browser`, `node`, or `unknown`
- `hostName`: host identifier when known
- `processId`: process id where available
- `platform`: runtime platform (`win32`, `linux`, etc.)
- `architecture`: CPU architecture (`x64`, `arm64`, etc.)
- `runtimeVersion`: runtime version (for Node, `process.version`)
- `uptimeSeconds`: process uptime when available
- `memoryRssMb`: resident memory snapshot in MB when available

## `testType`

Describes execution mode and test tunables used for this run.

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

### Network context fields

- `connectionType`
- `externalIpAddress`
- `location`
- `server`
- `wifi` and `wired` metadata

### Measurement fields

Located at `results.measurements`:

- `estimatedDownloadSpeed`
- `downloadSpeed`
- `totalDownload`
- `estimatedUploadSpeed`
- `uploadSpeed`
- `totalUpload`
- `latency`
- `jitter`
- `latenciesList`
- `downloadList` (time-series snapshots)
- `uploadList` (time-series snapshots)
- `failedReason`
- `failedStage`

## `stages`

Chronological stage records with timestamps and network context snapshots.

Typical values:

- `latencyStart`
- `downloadStart`
- `downloadEnd`
- `uploadStart`
- `uploadEnd`

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
- [Protocol](./protocol.md)
- [Testing Guide](./testing.md)
