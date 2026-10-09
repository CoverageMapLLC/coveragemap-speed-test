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
| Parallel throughput saturation | Multi-socket concurrency (1–12 sockets) derived from estimation, spread across worker threads in Node.js for multi-gigabit stages |
| Backpressure safety on upload | Keep `bufferedAmount` at two chunks and cap unacknowledged chunks per socket |
| Deterministic promise lifecycle | Every stage settles its promise exactly once |
| Browser and Node.js parity | Runners only use the WebSocket API and `fetch`; in Node.js the same API can be backed by raw TCP |
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
│  │  7. runUploadSpeedTest()    ──────────────────────────► │──┼──► WSS /v1/ws  binary chunks
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
  selfHosted?: boolean; // true only for self-hosted servers entered manually; never present in this list
  protocols?: string[]; // transports and protocol versions, e.g. ["WSSv1", "WSv1", "TCPSv1", "TCPv1"]; absent means ["WSSv1"]
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

### Raw TCP Transport

Servers report the transports they accept in `protocols`: `WSSv1` (secure WebSocket), `WSv1` (WebSocket), `TCPSv1` (raw TCP over TLS), and `TCPv1` (raw TCP), each with the speed test protocol version on it. Servers that report nothing predate the field and are treated as `["WSSv1"]`, and so is the Cloudflare CDN server.

In Node.js, with `config.transport` set to `auto` (the default), the engine runs over raw TCP when the server lists `TCPSv1` (`TCPv1` for servers with `id === "local"`), on the same port as WebSocket. Servers built on [`@coveragemap/speed-transport`](https://github.com/CoverageMapLLC/speed-transport) offer it:

```
tcps://<server.domain>:<server.port>     (tcp:// for servers with id === "local")
```

The client opens a TLS connection and sends the 7 byte preamble `STCP/1\n`; the server echoes it. After that both sides exchange RFC 6455 frames without masking and without an HTTP handshake. Every command (`PING`, `START`, `CLOSE`, `ACK`, `PONG`) and every stage below is identical to WebSocket.

The engine does not check for raw TCP before the run. Instead, the first stage's connection over raw TCP gets 3 seconds to open (TCP, TLS, and the preamble echo). If it is refused or not answered in time, for example on a network that only passes HTTP through a proxy, the engine repeats that stage over WebSocket and runs the rest of the test there. Failures after a connection opened do not switch transports. `transport: 'websocket'` and `transport: 'tcp'` skip all of this and use one transport.

Raw TCP saves the client the WebSocket mask on every uploaded byte and lets it count downloaded frames without copying them. On loopback with TLS it measured 16.8/14.8 Gbps against 11.5/13.9 Gbps for WebSocket, with 37% less client CPU on upload. Browsers cannot open raw TCP connections and always use WebSocket. Results record the transport in `testType.testProtocol` (`TCP` or `WSS`).

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
       │    │  + 1 dedicated socket, PING/PONG every 1000 ms           │
       │    │  → SpeedTestData (speedMbps, bytes, snapshots[],         │
       │    │                   loadedLatency)                          │
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
            │  N parallel sockets, continuous binary sending            │
            │  + 1 dedicated socket, PING/PONG every 1000 ms           │
            │  → SpeedTestData (speedMbps, bytes, snapshots[],         │
            │                   loadedLatency)                          │
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
| ≥ 1000 Mbps | 12 |

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

The `500` iteration count instructs the server to send 500 frames per `START`. Each frame is approximately `<kb>` kilobytes. When a socket has received all 500 frames it requests the next batch with twice the frame size, up to 5 MB. The test's wall-clock `durationMs` timer ends the stage regardless of how many frames were received.

When the stage ends, each download socket sends the text command `CLOSE` before closing. The server ends the connection at once instead of first delivering every frame it has already queued, which on a slow link would otherwise occupy the downlink well into the next stage. Servers that do not know the command ignore it.

#### Threads

A single JavaScript thread cannot receive or send much more than about 5 Gbps over TLS. When the estimate is 1 Gbps or more (the single socket estimate tops out at a few Gbps however fast the link is), Node.js spreads the sockets across worker threads: 6 by default (`config.throughputThreads`), two sockets each, and never more than half the CPU cores. Each worker runs the same standard WebSocket code and publishes its byte count through a `SharedArrayBuffer`, so the main thread's snapshots stay real time. Worker threads are only used when their built-in `WebSocket` is the same implementation as the application's, so an application that installs a polyfill such as `ws` keeps every socket on the calling thread. Raw TCP lanes skip that check, since they do not depend on the global `WebSocket`, so they can use worker threads on every Node.js version; below 1 Gbps or with `throughputThreads: 1` they stay on the calling thread like WebSocket lanes. Browsers always use the calling thread.

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

#### Loaded Latency Monitor

A dedicated WebSocket connection is opened to the same server at the start of Stage 3. It sends a single `PING` text frame immediately on connect, then sends another `PING` every 1,000 ms after each `PONG` is received. RTT is measured with `performance.now()` at send and receive time.

```
[Stage 3 starts]
LoadedLatencySocket ──── "PING" ──────────────────────────────► Server
LoadedLatencySocket ◄─── "PONG" ───────────────────────────── Server
  [wait 1000 ms]
LoadedLatencySocket ──── "PING" ──────────────────────────────► Server
LoadedLatencySocket ◄─── "PONG" ───────────────────────────── Server
  ... (repeated until stage timer fires)

[durationMs timer fires → finishTest() called]
  → if a PING is in flight: wait up to 100 ms for final PONG (grace period)
  → close LoadedLatencySocket
  → compute LatencyTestData from collected RTTs
  → attach as SpeedTestData.loadedLatency (null if no pings completed)
```

Because these probes run while the download sockets are saturating the link, the resulting RTT values reflect latency **under load** rather than idle baseline latency. Compare `loadedLatency.minLatency` against the pre-test `LatencyTestData.minLatency` to measure the latency increase caused by congestion.

`loadedLatency` is `null` in the result if no PONG was received before the monitor stopped (e.g. the connection took longer to open than the stage duration).

#### Defaults

| Parameter | Default | Configurable range |
|---|---|---|
| `downloadDurationMs` | 10,000 ms | 3,000 – 30,000 ms |
| `snapshotIntervalMs` | 100 ms | 50 – 5,000 ms |
| Iterations per START | 500 | (fixed) |
| Loaded latency ping interval | 1,000 ms | (fixed) |
| Loaded latency grace period | 100 ms | (fixed) |

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

**Upload chunk size:**

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
Client ──── Uint8Array(chunk) ──────────────────────► Socket 1   │ kept topped up
Client ──── Uint8Array(chunk) ──────────────────────► Socket N   │ for durationMs
Client ◄─── "ACK" (one per chunk, counted for throughput) ◄─────┘
```

#### Backpressure Control

Every socket reuses one preallocated chunk of at most 1 MB and keeps its send buffer topped up to two chunks (at least 16 KB). The WebSocket API has no drain event, so sockets are refilled after acknowledgements arrive and on a 5 ms timer:

```
target = max(2 × chunkBytes, 16 KB)

refill(socket):
  while socket.bufferedAmount < target
    and unacknowledged chunks < 64:
    socket.send(chunk)
```

A refill stops after 4 ms of work, and acknowledgements that arrive together share one refill, so a client that is short of CPU still emits snapshots and loaded latency probes on time. The cap of 64 unacknowledged chunks bounds memory with WebSocket implementations that do not report `bufferedAmount`, while still covering the bandwidth-delay product of 1.7 Gbps per socket at a 300 ms round trip.

**Throughput is computed from acknowledged bytes**: a chunk counts once the server's `ACK` for it arrives, so data still queued on the client is never counted.

#### Loaded Latency Monitor

Identical in design to the download stage loaded latency monitor. A dedicated PING/PONG WebSocket connection runs for the full duration of Stage 5, probing every 1,000 ms. The collected RTTs are attached to the upload result as `SpeedTestData.loadedLatency`. See the [download stage loaded latency description](#loaded-latency-monitor) for the full exchange sequence and timing details.

#### Measurement Model

Identical to download: `snapshotIntervalMs` periodic snapshots and a wall-clock `durationMs` deadline.

#### Defaults

| Parameter | Default | Configurable range |
|---|---|---|
| `uploadDurationMs` | 10,000 ms | 3,000 – 30,000 ms |
| `snapshotIntervalMs` | 100 ms | 50 – 5,000 ms |
| Refill timer | 5 ms | (fixed) |
| Max chunk size | 1 MB | (fixed) |
| Loaded latency ping interval | 1,000 ms | (fixed) |
| Loaded latency grace period | 100 ms | (fixed) |

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
| `throughputThreads` | 0 | 0 | 64 | Threads for stages estimated at 1 Gbps or more: `0` picks automatically (6), `1` keeps every socket on the calling thread. Node.js only (see [Threads](#threads)) |
| `transport` | `'auto'` | | | `'auto'`, `'websocket'`, or `'tcp'`. `auto` uses raw TCP in Node.js when the server offers it (see [Raw TCP Transport](#raw-tcp-transport)) |

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

The protocol runners use the WebSocket API and `globalThis.fetch` — no browser-specific APIs. In Node.js the sockets come from `globalThis.WebSocket`, or from `@coveragemap/speed-transport` when the run uses [raw TCP](#raw-tcp-transport). In Node.js environments:

- Against servers that offer raw TCP (with `transport: 'auto'` or `'tcp'`), no WebSocket implementation is needed on any Node.js version, and multi-gigabit stages run their sockets on worker threads.
- **Node 22+** includes a native `WebSocket` implementation for every other server. No polyfill needed, and multi-gigabit stages run their sockets on worker threads (see [Threads](#threads)).
- With a polyfill such as `ws`, WebSocket sockets stay on the calling thread, which limits a test to roughly 5 Gbps over TLS.
- **Node 20 / 21**: install the `ws` package and assign it to `globalThis.WebSocket` before creating `SpeedTestEngine`, for servers without raw TCP (including CDN servers).
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
