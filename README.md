# @coveragemap/speed-test

CoverageMap's speed test library for browser and backend workloads, including latency, download, and upload measurements using CoverageMap's speed-test infrastructure.

## Install

```bash
npm install @coveragemap/speed-test
```

## What it does

- Runs a full test sequence: latency -> download estimation -> download throughput -> upload estimation -> upload throughput.
- Pulls nearest servers from CoverageMap's speed API.
- Produces typed test result payloads.
- Captures browser metadata when available and core runtime/system metadata for backend runners.
- Uploads results to CoverageMap API with local queue fallback.
- Exposes helper utilities for formatting results and building custom flows.

## Quick start

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';

const engine = new SpeedTestEngine({
  application: {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'CoverageMap Web Console',
    version: '2.8.0',
    organization: 'CoverageMap',
    type: 'web',
  },
  callbacks: {
    onStageChange: (stage) => console.log('stage:', stage),
    onDownloadProgress: (snapshot) => console.log('download Mbps:', snapshot.speedMbps),
    onUploadProgress: (snapshot) => console.log('upload Mbps:', snapshot.speedMbps),
    onError: (error, stage) => console.error(stage, error.message),
  },
});

const result = await engine.run();
console.log(result.results.measurements);
```

## CoverageMap-first behavior

The library always uses CoverageMap infrastructure:

- Speed API: `api.speed.coveragemap.com`
- Result API: `map.coveragemap.com`

## Optional forward-compatible overrides

You can tune runtime behavior with:

- `tests.latency`, `tests.download`, `tests.upload`
- `locationProvider` (optional live coordinates provider; falls back to `getConnectionInfo()` when null)
- `deviceInfo.deviceIdStorageKey`
- `deviceInfo.coreSystem` (host/runtime/system overrides for backend runners)
- `setDeviceMetadataProvider()` for custom runtime metadata adapters

## Required application metadata

`SpeedTestEngineOptions` requires an `application` block. This metadata is embedded in every saved test result:

- `id` — UUID that uniquely identifies your application
- `name`
- `version`
- `organization`
- `type` (`web`, `backend`, `mobile`, `desktop`, `cli`, `serverless`, or `other`)

Optional field:

- `website`

## Data upload behavior

By default, completed test results are uploaded to CoverageMap systems (`map.coveragemap.com`) for analysis, quality metrics, and speed-test benchmarking across environments.

If upload fails, results are queued locally and retried automatically in the background on the next run.

## Configure which tests run

All three tests run by default. You can selectively enable latency, download, and upload:

```ts
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
    upload: true,
  },
});
```

## Scripts

- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run test:deploy` (live deploy-time real-world validation)
- `npm run build`

## Documentation

- [Protocol](./docs/protocol.md)
- [Library API](./docs/library-api.md)
- [Result Schema](./docs/result-schema.md)
- [Backend Integration](./docs/backend-integration.md)
- [Examples](./docs/examples.md)
- [Testing](./docs/testing.md)
- [Release Checklist](./docs/release.md)

## Example app

A runnable React + Vite sample is in [`examples/react-vite`](./examples/react-vite).

## License

MIT
