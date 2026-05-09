# @coveragemap/speed-test

[![npm](https://img.shields.io/npm/v/@coveragemap/speed-test)](https://www.npmjs.com/package/@coveragemap/speed-test)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/@coveragemap/speed-test)](https://nodejs.org)

CoverageMap's speed-test library for browser and backend environments. Measures latency, download throughput, and upload throughput using CoverageMap's speed-test protocol and infrastructure.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
  - [Required: Application Metadata](#required-application-metadata)
  - [Optional: Select Tests](#optional-select-tests)
  - [Optional: Overrides](#optional-overrides)
- [Data Upload](#data-upload)
- [Fair Use Policy](#fair-use-policy)
- [Development](#development)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

---

## Installation

```bash
npm install @coveragemap/speed-test
```

**Requirements:** Node.js ≥ 20

---

## Quick Start

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';

const engine = new SpeedTestEngine({
  application: {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    name: 'My App',
    version: '1.0.0',
    organization: 'My Org',
    type: 'web',
  },
  callbacks: {
    onStageChange: (stage) => console.log('stage:', stage),
    onDownloadProgress: (snap) => console.log('download Mbps:', snap.speedMbps),
    onUploadProgress: (snap) => console.log('upload Mbps:', snap.speedMbps),
    onError: (error, stage) => console.error(stage, error.message),
  },
});

const result = await engine.run();
console.log(result.results.measurements);
```

The engine runs a full sequence — latency → download → upload — against the nearest CoverageMap server, and returns a typed result payload.

---

## Configuration

### Required: Application Metadata

Every `SpeedTestEngine` instance requires an `application` block. This metadata is embedded in every saved result.

| Field | Type | Description |
|---|---|---|
| `id` | `string` | UUID that uniquely identifies your application |
| `name` | `string` | Human-readable application name |
| `version` | `string` | Application version |
| `organization` | `string` | Organization or publisher name |
| `type` | `string` | One of: `web`, `backend`, `mobile`, `desktop`, `cli`, `serverless`, `other` |
| `website` | `string` | *(Optional)* Application URL |

### Optional: Select Tests

All three tests run by default. Disable individual phases as needed:

```ts
const engine = new SpeedTestEngine({
  application: { /* ... */ },
  tests: {
    latency: true,
    download: true,
    upload: false,
  },
});
```

### Optional: Overrides

| Option | Description |
|---|---|
| `tests.latency` / `tests.download` / `tests.upload` | Toggle individual test phases |
| `locationProvider` | Live coordinates provider; falls back to `getConnectionInfo()` when `null` |
| `networkProvider` | Overrides resolved connection type and cellular/Wi-Fi/wired metadata used in `results` + `stages` |
| `deviceInfo.deviceIdStorageKey` | Custom storage key for the persistent device ID |
| `deviceInfo.coreSystem` | Host/runtime/system overrides for backend runners |
| `setDeviceMetadataProvider()` | Register a custom runtime metadata adapter |

---

## Data Upload

Completed test results are uploaded to CoverageMap systems (`map.coveragemap.com`) for analysis, benchmarking, and network quality metrics.

If an upload fails, results are queued locally and retried automatically in the background on the next run.

> **Disclaimer:** All speed test results produced by this library — including measurement data, device metadata, and application identity — are uploaded to and retained by CoverageMap. By using this library, you acknowledge that result data will be used by CoverageMap to power network quality mapping, coverage analytics, and related services on [coveragemap.com](https://coveragemap.com). Do not use this library in contexts where uploading network measurement data to a third party is not permitted.

---

## Fair Use Policy

This library uses CoverageMap's speed-test infrastructure to run measurements. To keep the service available and performant for everyone, please observe the following:

- Tests should be initiated in response to a genuine need — user-triggered measurements, scheduled monitoring at a reasonable cadence, or one-off diagnostics. Do not use this library to benchmark or stress-test CoverageMap's servers.
- **Automated or scheduled tests must run no more than once per 10 minutes per application.** Running tests more frequently than this is considered abusive and puts unnecessary load on shared infrastructure.
- Each application must provide accurate `application.id`, `application.name`, and `application.organization` metadata. Misrepresenting or omitting this information is a violation of fair use.

**CoverageMap reserves the right to rate-limit or block any application ID that is found to be abusing the infrastructure.** If your application is blocked, contact us through the repository to discuss your use case.

---

## Development

```bash
npm run lint        # ESLint
npm run typecheck   # TypeScript type check (no emit)
npm run test        # Unit tests (Vitest)
npm run test:deploy # Live deploy-time validation against real servers
npm run build       # Compile to dist/
```

A runnable React + Vite sample app is available in [`demos/react-vite`](./demos/react-vite).

---

## Documentation

| Document | Description |
|---|---|
| [Protocol](./docs/protocol.md) | WebSocket protocol specification |
| [Library API](./docs/library-api.md) | Full API reference |
| [Result Schema](./docs/result-schema.md) | Result payload type definitions |
| [Backend Integration](./docs/backend-integration.md) | Node.js / server-side usage guide |
| [Examples](./docs/examples.md) | Usage examples and recipes |

---

## Contributing

Issues and pull requests are welcome. Please open an issue first to discuss significant changes.

- **Bug reports:** [GitHub Issues](https://github.com/CoverageMapLLC/coveragemap-speed-test/issues)
- **Repository:** [github.com/CoverageMapLLC/coveragemap-speed-test](https://github.com/CoverageMapLLC/coveragemap-speed-test)

---

## License

[Apache 2.0](./LICENSE) © CoverageMap
