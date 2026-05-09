# CoverageMap Speed Test Protocol

This document is the authoritative reference for the transport protocol, measurement methodology, and runtime behavior used by `@coveragemap/speed-test`. It covers the full lifecycle of a test run from HTTP discovery through WebSocket measurement to result upload.

---

## Table of Contents

- [Overview](#overview)
- [Goals and Design Principles](#goals-and-design-principles)
- [System Architecture](#system-architecture)
- [Phase 1: HTTP Discovery](#phase-1-http-discovery)
  - [Connection Info](#connection-info)
  - [Server List](#server-list)
  - [Server Selection](#server-selection)
  - [Server Caching](#server-caching)
- [Phase 2: WebSocket Measurement](#phase-2-websocket-measurement)
  - [WebSocket Endpoint](#websocket-endpoint)
  - [Stage Sequence](#stage-sequence)
  - [Stage 1 — Latency](#stage-1--latency)
  - [Stage 2 — Download Estimation](#stage-2--download-estimation)
  - [Stage 3 — Download Throughput](#stage-3--download-throughput)
  - [Stage 4 — Upload Estimation](#stage-4--upload-estimation)
  - [Stage 5 — Upload Throughput](#stage-5--upload-throughput)
- [Throughput Calculation](#throughput-calculation)
- [Timing Normalization](#timing-normalization)
- [Adaptive Sizing](#adaptive-sizing)
- [Cancellation and Timeouts](#cancellation-and-timeouts)
- [Failure Semantics](#failure-semantics)
- [Phase 3: Result Upload](#phase-3-result-upload)
  - [Upload Queue Fallback](#upload-queue-fallback)
- [Default Configuration Reference](#default-configuration-reference)
- [Backend Runtime Considerations](#backend-runtime-considerations)

---

## Overview

The CoverageMap speed test protocol is a three-phase process:

1. **HTTP Discovery** — identify the client's network location and select the nearest measurement server.
2. **WebSocket Measurement** — run latency probes and bidirectional throughput tests over short-lived WebSocket connections to the selected server.
3. **Result Upload** — post the structured result payload to CoverageMap for storage and analysis.

Each phase is designed to be cancellable, resilient to transient failures, and produce the same typed result schema regardless of runtime environment (browser or Node.js).

---

## Goals and Design Principles

| Goal | Implementation |
|---|---|
| Stable, repeatable measurements | Separate low-cost "estimation" pass from full-throughput pass |
| Latency-aware throughput | Subtract RTT bias from all duration measurements |
| Prevent measurement collapse on fast links | Adaptive payload sizing scales from 1 KB to 1 MB |
| Parallel throughput saturation | Multi-socket concurrency (1–10 sockets) derived from estimation |
| Backpressure safety on upload | Skip send loop when `bufferedAmount` exceeds threshold |
| Deterministic promise lifecycle | Every stage settles its promise exactly once |
| Browser and Node.js parity | Uses `globalThis.WebSocket` and `fetch`; no environment-specific code in runners |
| Graceful failure | Every stage records `failedReason` and `failedStage`; results upload even on partial runs |

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Runtime                          │
│                      (Browser or Node.js)                       │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    SpeedTestEngine                        │  │
│  │                                                           │  │
│  │  1. getConnectionInfo()  ──────────────────────────────► │──┼──► GET /v1/connection
│  │  2. getServers()         ──────────────────────────────► │──┼──► GET /v1/list?lat&lng
│  │  3. runLatencyTest()     ──────────────────────────────► │──┼──► WSS /v1/ws  PING/PONG
│  │  4. runDownloadEstimation() ──────────────────────────► │──┼──► WSS /v1/ws  START <kb> 1
│  │  5. runDownloadSpeedTest()  ──────────────────────────► │──┼──► WSS /v1/ws  START <kb> 500
│  │  6. runUploadEstimation()   ──────────────────────────► │──┼──► WSS /v1/ws  binary chunks
│  │  7. runUploadSpeedTest()    ──────────────────────────► │──┼──► WSS /v1/ws  binary bursts
│  │  8. uploadResults()         ──────────────────────────► │──┼──► POST /api/v1/speedTests
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         │               │                    │
         ▼               ▼                    ▼
api.speed.coveragemap.com  Speed Server    map.coveragemap.com
  (HTTP Discovery)         (WSS Tests)     (Result Storage)
```

---

## Phase 1: HTTP Discovery

Before any WebSocket connection is opened, the engine fetches two HTTP resources to understand where the client is and which server to use.

### Connection Info

```
GET https://api.speed.coveragemap.com/v1/connection
```

Returns a JSON object describing the client's external network context:

```ts
interface ConnectionInfo {
  client: {
    ip: string | null;          // client's external IP address
    city: string | null;
    region: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
    continent: string | null;
    timezone: string | null;
    latitude: number;           // used for server selection when no GPS
    longitude: number;
    asn: number | null;         // autonomous system number (ISP)
    asOrg: string;              // ISP / organization name
  } | null;
  server: {
    provider: string;
    dataCenter: string;
    city: string;
    country: string;
    region: string | null;
    continent: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
}
```

This endpoint has a 5-second timeout. If it fails, location and ISP fields in the result will be `null`, but the test continues using an unlocated server list.

### Server List

```
GET https://api.speed.coveragemap.com/v1/list[?latitude=<lat>&longitude=<lng>]
```

Returns a JSON array of available measurement servers ordered by proximity to the supplied coordinates. If coordinates are omitted, the API uses the request's IP geolocation.

Each server object:

```ts
interface SpeedTestServer {
  id: string;          // unique server identifier; "local" means ws:// instead of wss://
  domain: string;      // hostname
  port: number | null; // WebSocket port
  provider: string | null;
  city: string | null;
  region: string | null;
  country: string;
  location: string;    // human-readable location label
  latitude: number | null;
  longitude: number | null;
  distance: number | null; // kilometers from client
  isCDN: boolean | null;
}
```

Premium servers (marked with `premium: true` in the raw response) are filtered out. Only non-premium servers are returned to the library consumer and used for testing.

### Server Selection

If `engine.run()` is called without an argument, the engine selects the first server from the ordered list (the nearest available non-premium server). You can override this:

```ts
// Let the engine auto-select
await engine.run();

// Pass a SpeedTestServer object directly
const servers = await engine.getServers();
await engine.run(servers[2]);

// Pass a server ID string
await engine.run('server-id-here');
```

### Server Caching

The server list is cached in memory for **30 minutes**. The cache is also keyed by location — if the coordinates change (e.g. a device that moves), the list is re-fetched automatically. Call `engine.refreshServers()` to force an immediate refresh.

---

## Phase 2: WebSocket Measurement

### WebSocket Endpoint

All measurement stages connect to:

```
wss://<server.domain>:<server.port>/v1/ws
```

Exception: servers with `id === "local"` use `ws://` (unencrypted) instead of `wss://`. All remote production servers use `wss://`.

The WebSocket `binaryType` is always set to `"arraybuffer"` so binary frames are delivered as `ArrayBuffer` objects.

### Stage Sequence

A full test run executes five stages in order. Each stage uses one or more short-lived WebSocket connections that are closed when the stage completes.

```
engine.run() called
       │
       ├─► [HTTP] GET /v1/connection          (connectionInfo)
       ├─► [HTTP] GET /v1/list                (server list → targetServer)
       │
       ├─ Stage 1: latency ─────────────────────────────────────────────┐
       │    │  1 socket, N PING/PONG round trips                        │
       │    │  → LatencyTestData (min/avg/median/max RTT, jitter)       │
       │    └────────────────────────────────────────────────────────────┘
       │
       ├─ Stage 2: downloadEstimation ──────────────────────────────────┐
       │    │  1 socket, adaptive payload doubling                      │
       │    │  → SpeedEstimationResult (speedMbps → determines config)  │
       │    └────────────────────────────────────────────────────────────┘
       │
       ├─ Stage 3: download ────────────────────────────────────────────┐
       │    │  N parallel sockets, sustained binary streaming           │
       │    │  → SpeedTestData (speedMbps, bytes, snapshots[])         │
       │    └────────────────────────────────────────────────────────────┘
       │
       │    [500 ms cooldown]
       │
       ├─ Stage 4: uploadEstimation ────────────────────────────────────┐
       │    │  1 socket, adaptive binary chunk upload + ACK             │
       │    │  → SpeedEstimationResult (speedMbps → determines config)  │
       │    └────────────────────────────────────────────────────────────┘
       │
       └─ Stage 5: upload ──────────────────────────────────────────────┐
            │  N parallel sockets, burst binary sending                 │
            │  → SpeedTestData (speedMbps, bytes, snapshots[])         │
            └────────────────────────────────────────────────────────────┘

       Assemble NetworkTestResultTestResults
       POST to map.coveragemap.com
```

Stage markers recorded in the result payload:

| Stage(s) | Marker recorded |
|---|---|
| Before latency | `latencyStart` |
| Before downloadEstimation | `downloadStart` |
| After download | `downloadEnd` |
| Before uploadEstimation | `uploadStart` |
| After upload | `uploadEnd` |

Each marker snapshot captures: timestamp, connection type, external IP, and location.

---

### Stage 1 — Latency

**Purpose:** Measure baseline round-trip time (RTT) and jitter. The resulting values are used by all subsequent stages to normalize throughput timing.

#### Message Exchange

```
Client ──── "PING" (text frame) ────────────────────► Server
Client ◄─── "PONG" (text frame) ───────────────────── Server
Client ──── "PING" (text frame) ────────────────────► Server
Client ◄─── "PONG" (text frame) ───────────────────── Server
  ... (repeated pingCount times, sequentially)
```

Pings are sequential — the next `PING` is sent only after the current `PONG` is received. This gives clean, non-overlapping RTT measurements.

RTT for each probe is measured with `performance.now()` at the moment `PING` is sent and again the moment `PONG` is received. The delta is the raw RTT.

#### Completion Criteria

- The stage resolves successfully once all `pingCount` probes complete.
- If the timeout fires before all pings finish but at least **3 valid RTTs** have been collected, the stage resolves with those samples rather than failing.
- If fewer than 3 RTTs are collected at timeout, the stage throws an error.

#### Computed Statistics

From the raw list of RTT samples `latencies[]`:

| Statistic | Description |
|---|---|
| `minLatency` | Minimum RTT across all probes |
| `averageLatency` | Arithmetic mean |
| `medianLatency` | Middle value of sorted list |
| `maxLatency` | Maximum RTT |
| `minJitter` | Minimum of consecutive differences `|latencies[i] - latencies[i-1]|` |
| `averageJitter` | Mean of consecutive differences |
| `medianJitter` | Median of consecutive differences |
| `maxJitter` | Maximum consecutive difference |

The downstream stages use `minLatency` and `minJitter` (the most optimistic estimates) for timing normalization, since those reflect the best achievable network conditions and give the most conservative throughput correction.

#### Timeouts and Defaults

| Parameter | Default | Configurable range |
|---|---|---|
| `pingCount` | 10 | 5 – 50 |
| `latencyTimeoutMs` | 10,000 ms | 3,000 – 30,000 ms |

---

### Stage 2 — Download Estimation

**Purpose:** Determine a suitable payload size for the full download stage, avoiding sending too little data (underestimates speed) or too much (wastes time before the real test).

#### Message Exchange

```
Client ──── Uint8Array(512) (warmup binary frame) ───► Server
  [10 ms delay]
Client ──── "START <kb> 1" (text frame) ────────────► Server
Client ◄─── <binary payload ~<kb> KB> ──────────────── Server
  [if adjusted duration < 100ms: double payload and repeat]
Client ──── "START <kb> 1" (text frame) ────────────► Server
Client ◄─── <binary payload ~<kb> KB> ──────────────── Server
  [continue until duration ≥ 100ms or max 5 MB reached]
```

The `<kb>` in the `START` command is the requested payload size in **kilobytes** (integer). The server streams a single binary frame of approximately that size.

#### Adaptive Doubling Algorithm

```
messageSizeBytes = 10 KB (initial)

loop:
  send "START <messageSizeBytes/1024> 1"
  receive binary frame of byteLength
  rawDurationMs = now - startTime
  adjustedMs = rawDurationMs - (latencyMs + jitterMs)

  if adjustedMs < 100ms AND messageSizeBytes < 5 MB:
    messageSizeBytes *= 2
    continue
  else:
    durationMs = max(adjustedMs, 1)
    speedMbps = bytes / (durationMs * 125)
    resolve { durationMs, bytes, speedMbps }
```

The doubling ensures that the estimation converges to a duration around 100 ms, giving a reliable throughput sample regardless of whether the connection is 1 Mbps or 1 Gbps.

#### Error Recovery

On WebSocket error, the stage retries up to **3 times** with a 1-second delay between attempts before failing permanently.

#### Timeout

Default: **15,000 ms** (configurable 3,000–30,000 ms). If no response arrives in time, the stage fails.

---

### Stage 3 — Download Throughput

**Purpose:** Saturate the available downstream bandwidth by streaming binary data over multiple parallel WebSocket connections simultaneously.

#### Connection Count and Packet Size

Both are derived from the estimation result using lookup tables:

**Download connection count:**

| Estimated speed | Connections |
|---|---|
| < 0.5 Mbps | 1 |
| 0.5 – 1 Mbps | 2 |
| 1 – 10 Mbps | 4 |
| 10 – 100 Mbps | 6 |
| 100 – 1000 Mbps | 8 |
| ≥ 1000 Mbps | 10 |

**Download packet size (per `START` command):**

| Estimated speed | Packet size |
|---|---|
| < 0.5 Mbps | 1 KB |
| 0.5 – 1 Mbps | 16 KB |
| 1 – 10 Mbps | 32 KB |
| 10 – 20 Mbps | 64 KB |
| 20 – 30 Mbps | 128 KB |
| 30 – 40 Mbps | 256 KB |
| 40 – 50 Mbps | 512 KB |
| ≥ 50 Mbps | 1024 KB (1 MB) |

#### Message Exchange

All sockets are opened in parallel. Once every socket is connected, the test begins simultaneously:

```
Client ──── "START <kb> 500" ──────────────────────► Socket 0
Client ──── "START <kb> 500" ──────────────────────► Socket 1
Client ──── "START <kb> 500" ──────────────────────► Socket N
                                                        │
Client ◄─── binary frame ◄─── binary frame ◄──── binary frame ─── ...
Client ◄─── binary frame ◄─── binary frame ◄──── binary frame ─── ...
  [continuous streaming for durationMs, all sockets in parallel]
```

The `500` iteration count instructs the server to send 500 frames per `START`. Each frame is approximately `<kb>` kilobytes. The test's wall-clock `durationMs` timer ends the stage regardless of how many frames were received.

#### Measurement Model

```
testStartTime = performance.now()

every snapshotIntervalMs (default 100ms):
  elapsed = now - testStartTime
  effectiveDurationMs = max(elapsed - (latencyMs + jitterMs), 1)
  speedMbps = totalBytes / (effectiveDurationMs * 125)
  emit SpeedSnapshot { timeOffsetMs: elapsed, speedMbps, bytes: totalBytes }

after durationMs:
  elapsed = now - testStartTime
  effectiveDurationMs = max(elapsed - (latencyMs + jitterMs), 1)
  final speedMbps = totalBytes / (effectiveDurationMs * 125)
  resolve { durationMs: elapsed, speedMbps, bytes: totalBytes, snapshots }
```

All sockets accumulate into a single `totalBytes` counter. The final speed is computed from the aggregate data across all connections.

#### Defaults

| Parameter | Default | Configurable range |
|---|---|---|
| `downloadDurationMs` | 10,000 ms | 3,000 – 30,000 ms |
| `snapshotIntervalMs` | 100 ms | 50 – 5,000 ms |
| Iterations per START | 500 | (fixed) |

---

### Stage 4 — Upload Estimation

**Purpose:** Mirror of download estimation, but for upstream. Determine the optimal payload size and expected upload speed before the full upload test.

#### Message Exchange

```
Client ──── Uint8Array(<bytes>) ─────────────────────► Server
  [chunked into ≤ 1 MB pieces if bytes > 1 MB]
Client ◄─── "ACK" (text frame, one per chunk) ──────── Server

  [if adjustedMs < 100ms: double bytes, repeat]
Client ──── Uint8Array(<bytes * 2>) ────────────────► Server
Client ◄─── "ACK" ... "ACK" ───────────────────────── Server
  [continue until duration ≥ 100ms or max 5 MB reached]
```

**Chunking rule:** If the target `bytes` exceeds 1 MB, the payload is split into 1 MB chunks. The server sends one `ACK` per chunk. The stage waits for all ACKs before evaluating the duration.

#### Adaptive Doubling Algorithm

```
bytes = 5 KB (initial)

loop:
  chunks = split bytes into ≤ 1 MB pieces
  targetAcks = number of chunks
  startTime = now

  for each chunk: socket.send(chunk)
  wait for targetAcks ACKs

  rawDurationMs = now - startTime
  adjustedMs = rawDurationMs - (latencyMs + jitterMs)

  if adjustedMs < 100ms AND bytes < 5 MB:
    bytes *= 2
    continue
  else:
    durationMs = max(adjustedMs, 1)
    speedMbps = bytes / (durationMs * 125)
    resolve { durationMs, bytes, speedMbps }
```

#### Timeout

Default: **15,000 ms** (configurable 3,000–30,000 ms).

---

### Stage 5 — Upload Throughput

**Purpose:** Saturate available upstream bandwidth by continuously sending binary data bursts across multiple parallel WebSocket connections.

#### Connection Count and Packet Size

Same lookup tables as download (see [Stage 3](#stage-3--download-throughput)), using the upload estimation result as the input.

**Upload packet size per burst:**

| Estimated speed | Packet size |
|---|---|
| < 0.5 Mbps | 1 KB |
| 0.5 – 1 Mbps | 16 KB |
| 1 – 10 Mbps | 128 KB |
| 10 – 50 Mbps | 512 KB |
| ≥ 50 Mbps | 1024 KB (1 MB) |

#### Message Exchange

```
Client ──── Uint8Array(chunk) ──────────────────────► Socket 0  ─┐
Client ──── Uint8Array(chunk) ──────────────────────► Socket 1   │ repeated every
Client ──── Uint8Array(chunk) ──────────────────────► Socket N   │ 10 ms for durationMs
            [backpressure check per socket]                       │
Client ◄─── "ACK" (optional, not counted for throughput) ◄──────┘
```

#### Backpressure Control

Each burst loop checks `socket.bufferedAmount` before sending. If the send buffer is full, the socket is skipped for that burst cycle:

```
bufferSizeKb = max(messageSizeKb * 8, 1024)
bufferThreshold = bufferSizeKb * 1024  // bytes

for each socket:
  if socket.bufferedAmount > bufferThreshold: skip
  else: send chunks
```

This prevents the internal socket buffer from growing unboundedly, which would inflate the effective `totalBytes` counter beyond what has actually been transmitted.

**Throughput is computed from sent bytes** (summed at the `socket.send()` call site), not from ACKs. ACKs may arrive but are not used for measurement.

#### Measurement Model

Identical to download: `snapshotIntervalMs` periodic snapshots and a wall-clock `durationMs` deadline.

#### Defaults

| Parameter | Default | Configurable range |
|---|---|---|
| `uploadDurationMs` | 10,000 ms | 3,000 – 30,000 ms |
| `snapshotIntervalMs` | 100 ms | 50 – 5,000 ms |
| Burst interval | 10 ms | (fixed) |
| Max chunk size | 1 MB | (fixed) |

---

## Throughput Calculation

All speed measurements use the same formula:

```
Mbps = bytes / (durationMs × 125)
```

**Derivation:**

```
1 Mbps  = 1,000,000 bits/second
        = 125,000 bytes/second
        = 125 bytes/millisecond

∴ bytes / ms  = Mbps × 125
  Mbps        = bytes / (ms × 125)
```

This is applied consistently at both snapshot sampling time and final result assembly.

---

## Timing Normalization

Raw measured durations include network round-trip overhead that isn't part of the data transfer itself. All throughput stages remove this bias by subtracting the latency and jitter baselines measured in Stage 1:

```
effectiveDurationMs = max(rawDurationMs - (minLatency + minJitter), 1)
speedMbps = bytes / (effectiveDurationMs × 125)
```

**Why `minLatency + minJitter`?**

`minLatency` represents the lowest observed RTT — the best-case network propagation delay. `minJitter` represents the smallest observed consecutive RTT variation. Together they define the irreducible overhead floor. Subtracting the floor from the measured duration isolates the time actually spent transferring bytes.

**Why clamp to 1 ms?**

On loopback interfaces or very fast local networks, the adjusted duration can be zero or negative (the transfer was faster than the RTT floor). Clamping to 1 ms prevents division by zero and avoids reporting astronomically large Mbps values.

---

## Adaptive Sizing

The estimation stages converge to a target adjusted duration of **100 ms** by doubling the payload on each attempt. The table below shows how many doubling iterations are needed for different connection speeds:

| Connection speed | Starting payload (10 KB) adjusted duration | Doublings to reach 100 ms |
|---|---|---|
| 1 Mbps | ~80 ms | 0–1 |
| 10 Mbps | ~8 ms | 3–4 |
| 100 Mbps | ~0.8 ms | 6–7 |
| 1 Gbps | ~0.08 ms | 9–10 → capped at 5 MB |

At 5 MB cap, the estimation result reflects the actual transfer time for 5 MB, which still provides a reliable throughput estimate even if the target duration wasn't reached.

---

## Cancellation and Timeouts

Every stage accepts a shared `CancellationToken`. The engine creates a new token at the start of each `run()` call.

```ts
engine.cancel(); // signals the active token
```

When cancelled:

1. The active stage's `onCancel` handler fires.
2. Any pending `setTimeout`/`setInterval` timers are cleared.
3. All open WebSocket connections for that stage are closed.
4. The stage promise rejects with `CancellationError`.
5. The engine sets `failedReason = "Cancelled"` in the result.

**Stage timeout defaults:**

| Stage | Default timeout |
|---|---|
| Latency | 10,000 ms |
| Download estimation | 15,000 ms |
| Download throughput | `downloadDurationMs` (wall-clock, no extra guard) |
| Upload estimation | 15,000 ms |
| Upload throughput | `uploadDurationMs` (wall-clock, no extra guard) |

---

## Failure Semantics

When a stage throws an error (non-cancellation):

1. `engine.callbacks.onError(error, stage)` fires.
2. `failedReason` is set to `error.message`.
3. `failedStage` is mapped from the engine stage name to the result stage marker:

| Engine stage | `failedStage` recorded |
|---|---|
| `latency` | `"latencyStart"` |
| `downloadEstimation` or `download` | `"downloadStart"` |
| `uploadEstimation` or `upload` | `"uploadStart"` |

4. The engine continues to the result assembly step and uploads a partial result.

Partial results (where a stage failed) still include all data that was collected up to the point of failure. For example, if download succeeds but upload fails, the result contains valid `downloadSpeed` and `latency` but `uploadSpeed: null`.

The `testStatus` field is `"passed"` when `failedStage` is null, and `"failed"` otherwise.

---

## Phase 3: Result Upload

On successful test completion, the engine uploads the assembled result to:

```
POST https://map.coveragemap.com/api/v1/speedTests
Content-Type: application/json

[NetworkTestResultTestResults, ...]
```

The body is a JSON array (batch format), containing a single result per standard test run.

This upload is fire-and-forget from the engine's perspective — it does not block the resolved `run()` promise.

### Upload Queue Fallback

If the upload POST fails (network error, server unavailable, etc.), the result is saved to `localStorage` under the key `coveragemap-test-results-queue`.

```
coveragemap-test-results-queue → JSON array of NetworkTestResultTestResults
```

On the **next call** to `engine.run()`, the engine attempts to flush the queue before the new test begins:

```
engine.run() called
  → flushUploadQueue()  // retry any previously failed uploads
  → ... run test stages ...
  → uploadResults(newResult)
```

If the retry batch succeeds, the queue entry is removed. If it fails again, it remains for the next attempt.

You can also trigger a manual flush:

```ts
await engine.retryQueuedUploads();
```

---

## Default Configuration Reference

| Config field | Default | Min | Max | Description |
|---|---|---|---|---|
| `pingCount` | 10 | 5 | 50 | Number of PING/PONG probes per latency stage |
| `downloadDurationMs` | 10,000 | 3,000 | 30,000 | Download throughput stage wall time (ms) |
| `uploadDurationMs` | 10,000 | 3,000 | 30,000 | Upload throughput stage wall time (ms) |
| `snapshotIntervalMs` | 100 | 50 | 5,000 | Progress snapshot interval (ms) |
| `latencyTimeoutMs` | 10,000 | 3,000 | 30,000 | Timeout for latency stage (ms) |
| `estimationTimeoutMs` | 15,000 | 3,000 | 30,000 | Timeout for estimation stages (ms) |

Override any of these through `SpeedTestEngineOptions.config`:

```ts
const engine = new SpeedTestEngine({
  application: { /* ... */ },
  config: {
    pingCount: 5,
    downloadDurationMs: 5000,
    uploadDurationMs: 5000,
  },
});
```

---

## Backend Runtime Considerations

The protocol runners use only `globalThis.WebSocket` and `globalThis.fetch` — no browser-specific APIs. In Node.js environments:

- **Node 22+** includes a native `WebSocket` implementation. No polyfill needed.
- **Node 20 / 21**: install the `ws` package and assign it to `globalThis.WebSocket` before creating `SpeedTestEngine`.
- `performance.now()` is available in Node.js via the `perf_hooks` module (globally available in Node 16+).
- `localStorage` is not available in Node.js. The upload queue fallback (`saveToLocalQueue` / `flushUploadQueue`) will silently no-op if `localStorage` throws, which it will in a Node environment.

Device metadata fields specific to browsers (`browserName`, `browserVersion`, `deviceMemoryGb`, etc.) will be `null` in backend runs. The `device.coreSystem` field is populated instead with host/runtime information:

```ts
interface NetworkTestResultCoreSystemInfo {
  runtime: 'browser' | 'node' | 'unknown';
  hostName: string | null;
  processId: number | null;
  platform: string | null;
  architecture: string | null;
  runtimeVersion: string | null;
  uptimeSeconds: number | null;
  memoryRssMb: number | null;
}
```

See [Backend Integration](./backend-integration.md) for a complete Node.js setup guide.

---

## See Also

- [Library API](./library-api.md) — full `SpeedTestEngine` API reference
- [Result Schema](./result-schema.md) — complete `NetworkTestResultTestResults` type definitions
- [Backend Integration](./backend-integration.md) — Node.js / server-side setup
- [Examples](./examples.md) — usage recipes and patterns
