# Backend Integration Guide

This guide explains how to run `@coveragemap/speed-test` in backend services
or worker environments where browser globals may be missing.

## What backend support means in this package

Backend support covers:

- backend-safe device/result metadata generation,
- ability to annotate runs with core runtime/system telemetry,
- reuse of the same result schema used by browser clients.

It does not mean:

- protocol execution without WebSocket support.

You still need a WebSocket implementation available as `globalThis.WebSocket`.

## Minimum backend requirements

- Node.js 20+ recommended.
- `fetch` available (Node 18+ provides it by default).
- `WebSocket` available globally, either native or polyfilled.

## Provide `WebSocket` in Node

If your runtime does not provide `globalThis.WebSocket`, attach one before creating the engine.

```ts
import { WebSocket } from 'ws';

globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
```

## Example backend worker setup

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';

export async function runBackendSpeedTest() {
  const engine = new SpeedTestEngine({
    application: {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      name: 'CoverageMap Backend Speed Agent',
      version: '1.0.0',
      organization: 'CoverageMap',
      type: 'backend',
      website: 'https://coveragemap.com',
    },
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

  const result = await engine.run();
  return result;
}
```

## Metadata behavior in backend mode

When browser globals are unavailable:

- browser fields may be null/defaulted,
- `device.coreSystem` remains populated from runtime data,
- `device.deviceType` defaults to `server`.

This ensures backend runs remain analyzable without pretending to be browser clients.

## Scheduling and orchestration recommendations

For recurring backend test jobs:

- isolate jobs by region/host to reduce contention,
- set sensible run cadence (for example every 5-15 minutes),
- include retry/backoff around transient endpoint failures,
- emit run ids and session ids to your observability pipeline.

## Failure handling recommendations

- Treat `failedReason` and `failedStage` as first-class monitoring signals.
- Separate protocol failures from upload failures in your alerts.
- The engine automatically retries queued uploads in the background on each run — no manual retry call is needed.

## Operational best practices

- Pin package version in production backends.
- Track Node runtime version in deployment metadata.
- Include CI coverage for runtime-specific behavior if your environment is customized.

## Related docs

- [Library API](./library-api.md)
- [Protocol](./protocol.md)
- [Result Schema](./result-schema.md)
- [Testing Guide](./testing.md)
