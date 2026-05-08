# Backend Integration Guide

This guide covers how to run `@coveragemap/speed-test` as a backend service for continuous network performance monitoring. If your goal is to measure and track network quality from a server, worker, or scheduled job — rather than from a browser — this is the right starting point.

---

## What this package supports in backend environments

The package is designed to run in both browser and non-browser runtimes. In backend mode it provides:

- **Structured result payloads** using the same schema as browser clients, so you can store and compare measurements across environments without any special-casing.
- **Runtime and system telemetry** attached to each result through `device.coreSystem` — host name, process ID, platform, architecture, and runtime version.
- **Flexible scheduling** — the engine is stateless and safe to call repeatedly in cron jobs, worker pools, or long-running polling loops.

One important constraint: the engine uses WebSocket for the speed test protocol. Your runtime must expose `globalThis.WebSocket`. See [Providing WebSocket in Node](#providing-websocket-in-node) below for how to satisfy this in environments that do not ship it natively.

---

## Installation

```bash
npm install @coveragemap/speed-test
```

If you are running Node.js older than 22 (which ships WebSocket natively), also install a WebSocket polyfill:

```bash
npm install ws
npm install --save-dev @types/ws
```

---

## Runtime requirements

| Requirement | Detail |
|---|---|
| Node.js version | 20 or later recommended; 22+ for native WebSocket |
| `fetch` | Available by default in Node 18+ |
| `WebSocket` | Native in Node 22+; polyfill with `ws` on older runtimes |
| TypeScript | Works with any modern TS config; no special settings required |

---

## Providing WebSocket in Node

If your runtime does not expose `globalThis.WebSocket`, attach a polyfill at the very start of your entry file — before any engine import.

```ts
import { WebSocket } from 'ws';

// Must be set before importing or constructing SpeedTestEngine
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
```

Node 22 and later ship `WebSocket` natively, so no polyfill is needed in those environments. You can guard the assignment if you want a single file that works across versions:

```ts
if (!('WebSocket' in globalThis)) {
  const { WebSocket } = await import('ws');
  globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
}
```

---

## Basic backend setup

The minimal configuration to get a measurement from a backend service:

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';
import type { NetworkTestResultTestResults } from '@coveragemap/speed-test';

const engine = new SpeedTestEngine({
  application: {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',  // demo placeholder — replace before production; API rejects this id on upload
    name: 'My Performance Monitor',
    version: '1.0.0',
    organization: 'My Organization',
    type: 'backend',
  },
});

const result: NetworkTestResultTestResults = await engine.run();

console.log('Download:', result.results.measurements.downloadSpeed, 'Mbps');
console.log('Upload:  ', result.results.measurements.uploadSpeed, 'Mbps');
console.log('Latency: ', result.results.measurements.latency, 'ms');
console.log('Run ID:  ', result.testType.id);
```

---

## Annotating results with host metadata

For a monitoring setup, you want each result to identify which host or deployment produced it. Pass `deviceInfo.coreSystem` overrides at construction time:

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';
import type { NetworkTestResultTestResults } from '@coveragemap/speed-test';

const engine = new SpeedTestEngine({
  application: {
    id: process.env.APP_ID!,
    name: process.env.APP_NAME ?? 'Performance Monitor',
    version: process.env.APP_VERSION ?? '1.0.0',
    organization: process.env.APP_ORG ?? 'My Organization',
    type: 'backend',
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

const result: NetworkTestResultTestResults = await engine.run();
```

These values flow through to `result.device.coreSystem` in the payload and are uploaded automatically. They make it straightforward to filter results by host or deployment region when analyzing in dashboards.

---

## Environment variable conventions

A consistent env var layout makes deployments easier to manage across regions or environments:

```bash
# Required — stable UUID for this application; keep consistent across deployments
APP_ID=a1b2c3d4-e5f6-7890-abcd-ef1234567890

# Recommended — human-readable identity for the service
APP_NAME=My Performance Monitor
APP_VERSION=1.0.0
APP_ORG=My Organization

# Optional — set automatically by most container platforms, but can be set manually
HOSTNAME=prod-monitor-us-east-1
```

---

## Scheduling strategies

### Cron job / scheduled task

The simplest approach for recurring measurement is a standalone script triggered by a scheduler (cron, AWS EventBridge, GitHub Actions, a Kubernetes CronJob, etc.).

```ts
// monitor.ts — run on a schedule, e.g. every 10 minutes
import { SpeedTestEngine } from '@coveragemap/speed-test';

async function runMonitor() {
  const engine = new SpeedTestEngine({
    application: {
      id: process.env.APP_ID!,
      name: 'My Performance Monitor',
      version: '1.0.0',
      organization: 'My Organization',
      type: 'backend',
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

  try {
    const result = await engine.run();
    console.log(JSON.stringify({
      runId: result.testType.id,
      sessionId: result.testType.sessionId,
      downloadMbps: result.results.measurements.downloadSpeed,
      uploadMbps: result.results.measurements.uploadSpeed,
      latencyMs: result.results.measurements.latency,
      jitterMs: result.results.measurements.jitter,
      server: result.results.server?.name,
      host: result.device.coreSystem?.hostName,
      timestamp: result.results.dateTime,
    }));
  } catch (err) {
    console.error('Speed test failed:', (err as Error).message);
    process.exit(1);
  }
}

runMonitor();
```

### Long-running polling loop

For services that stay alive rather than exit, use a polling loop with a configurable interval and exponential backoff on failure:

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';

const INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes
const MAX_BACKOFF_MS = 60 * 60 * 1000; // 1 hour cap

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runLoop() {
  const engine = new SpeedTestEngine({
    application: {
      id: process.env.APP_ID!,
      name: 'My Performance Monitor',
      version: '1.0.0',
      organization: 'My Organization',
      type: 'backend',
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

  let consecutiveFailures = 0;

  while (true) {
    try {
      const result = await engine.run();

      consecutiveFailures = 0;

      // Emit structured log or forward to your observability pipeline
      console.log(JSON.stringify({
        event: 'speed_test_complete',
        runId: result.testType.id,
        downloadMbps: result.results.measurements.downloadSpeed,
        uploadMbps: result.results.measurements.uploadSpeed,
        latencyMs: result.results.measurements.latency,
        jitterMs: result.results.measurements.jitter,
        failedReason: result.results.measurements.failedReason,
        timestamp: result.results.dateTime,
      }));

      await sleep(INTERVAL_MS);
    } catch (err) {
      consecutiveFailures++;

      const backoff = Math.min(
        INTERVAL_MS * Math.pow(2, consecutiveFailures - 1),
        MAX_BACKOFF_MS,
      );

      console.error(JSON.stringify({
        event: 'speed_test_error',
        error: (err as Error).message,
        consecutiveFailures,
        nextRetryMs: backoff,
      }));

      await sleep(backoff);
    }
  }
}

runLoop();
```

---

## Isolating tests by region or host

When running monitors across multiple hosts or regions:

- Use a distinct `HOSTNAME` per deployment so results can be grouped and compared.
- Stagger start times across hosts to avoid testing all nodes simultaneously. A simple offset based on host index works well enough for most setups.
- Do not share a single engine instance across multiple concurrent runs. Construct a new engine per run if you need parallel execution.

---

## Selecting a specific test server

By default `engine.run()` picks the nearest server automatically. For backend monitors you may want to pin a specific endpoint to measure consistently over time:

```ts
const servers = await engine.getServers();

// Pick the nearest server once, then pin it for all subsequent runs
const target = servers[0];

// Later runs — pass the same server object directly
const result = await engine.run(target);
```

To monitor multiple servers independently, construct a separate engine per target and run them sequentially or in separate workers.

---

## Running partial tests

For lightweight heartbeat checks, disable the throughput stages and measure only latency:

```ts
const engine = new SpeedTestEngine({
  application: { /* ... */ },
  tests: {
    latency: true,
    download: false,
    upload: false,
  },
});

const result = await engine.run();
// result.results.measurements.latency and .jitter are populated
```

This significantly reduces test duration (from ~30 seconds for a full run to a few seconds) and is useful for high-frequency health checks where throughput measurement would be too disruptive.

---

## Interpreting results for monitoring

### Key fields to track

| Field | Path in result | Notes |
|---|---|---|
| Download speed | `results.measurements.downloadSpeed` | Final sustained Mbps |
| Upload speed | `results.measurements.uploadSpeed` | Final sustained Mbps |
| Latency | `results.measurements.latency` | Round-trip time in ms |
| Jitter | `results.measurements.jitter` | Latency variance in ms |
| Run ID | `testType.id` | Unique per test run — use for deduplication |
| Session ID | `testType.sessionId` | Stable per engine instance — groups runs from one process |
| Failure reason | `results.measurements.failedReason` | Non-null when a run did not complete |
| Failed stage | `results.measurements.failedStage` | Which stage failed, if any |
| Server used | `results.server` | Which test server was selected |
| Timestamp | `results.dateTime` | ISO timestamp of the completed run |

### Failure signals

`failedReason` and `failedStage` are the primary signals for distinguishing partial failures from complete failures. A result can be partially successful — for example, latency may succeed while download fails — so treat them independently:

- If `failedStage` is `latencyStart` or earlier, the connection could not be established at all.
- If `failedStage` is `downloadStart` or later, latency data is likely still valid.
- If `failedReason` is null and all measurement fields are populated, the run was fully successful.

The engine automatically retries failed result uploads in the background on subsequent runs. No manual retry logic is needed for the upload path.

---

## Storing results

For analytics and trend analysis:

- Store the full JSON payload alongside a few indexed columns: timestamp, run ID, session ID, server ID, and host name.
- Do not flatten every nested field unless your query model specifically requires it — the payload structure is designed to be stored as a blob.
- Index `testType.id`, `testType.sessionId`, and `results.dateTime` as primary lookup keys.
- Gate parsing logic on `version` (currently `1`) so schema changes do not break existing consumers.
- Treat `null` measurement values as "not available" rather than zero. Many fields are nullable by design when a signal was unavailable or a stage failed early.

---

## What backend mode does not support

The package does not implement its own WebSocket transport. If `globalThis.WebSocket` is not available, the engine will throw before the test begins. This is the only hard dependency on your runtime environment.

Browser-specific fields (`device.browser`, `device.os`, connection type from the Network Information API) will be null in backend results. This is expected and documented in the [Result Schema](./result-schema.md).

---

## Related docs

- [Library API](./library-api.md)
- [Protocol](./protocol.md)
- [Result Schema](./result-schema.md)
- [Examples](./examples.md)
