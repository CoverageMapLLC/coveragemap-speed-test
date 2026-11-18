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
  - [Raw TCP Transport](#raw-tcp-transport)
  - [Browser Worker](#browser-worker)
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
| Latency-aware throughput | Subtract RTT bias from estimation and whole-stage durations |
| Sustained throughput, not ramp-up | Measure download and upload speeds from 250 ms after the first bytes |
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
│  │  3. runLatencyTest()     ──────────────────────────────► │──┼──► TCP/WS/WSS  PING/PONG
│  │  4. runDownloadEstimation() ──────────────────────────► │──┼──► TCP/WS/WSS  START <kb> 1
│  │  5. runDownloadSpeedTest()  ──────────────────────────► │──┼──► TCP/WS/WSS  START <kb> 200
│  │  6. runUploadEstimation()   ──────────────────────────► │──┼──► TCP/WS/WSS  binary chunks
│  │  7. runUploadSpeedTest()    ──────────────────────────► │──┼──► TCP/WS/WSS  binary chunks
│  │  8. uploadResults()         ──────────────────────────► │──┼──► POST /api/v1/speedTests
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         │               │                    │
         ▼               ▼                    ▼
api.speed.coveragemap.com  Speed Server    map.coveragemap.com
  (HTTP Discovery)         (Speed Tests)   (Result Storage)
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
  id: string;          // unique server identifier; "local" servers without protocols use ws://
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
  protocols?: string[]; // transports and protocol versions, e.g. ["WSSv1", "WSv1", "TCPv1"]; absent means ["WSSv1"]
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

Every stage connects to one URL on the server's port. Servers built on [`@coveragemap/speed-transport`](https://github.com/CoverageMapLLC/speed-transport) accept all three on the same port:

```
tcp://<server.domain>:<server.port>          raw TCP            (TCPv1)
ws://<server.domain>:<server.port>/v1/ws     WebSocket          (WSv1)
wss://<server.domain>:<server.port>/v1/ws    secure WebSocket   (WSSv1)
```

The WebSocket `binaryType` is always set to `"arraybuffer"` so binary frames are delivered as `ArrayBuffer` objects.

### Raw TCP Transport

Servers report the transports they accept in `protocols`: `TCPv1` (raw TCP), `WSv1` (WebSocket), and `WSSv1` (secure WebSocket), each with the speed test protocol version on it. Servers that report nothing predate the field and are treated as `["WSSv1"]` (`["WSv1"]` for servers with `id === "local"`), and so is the Cloudflare CDN server.

The speed test carries no private data, so encryption only costs CPU. With `config.transport` set to `auto` (the default), the engine picks the fastest transport the server lists:

1. Raw TCP, in Node.js.
2. WebSocket, except on HTTPS pages, where browsers only allow secure WebSockets.
3. Secure WebSocket.

For raw TCP, the client connects and sends the 7 byte preamble `STCP/1\n`; the server echoes it. After that both sides exchange RFC 6455 frames without masking and without an HTTP handshake. Every command (`PING`, `START`, `CLOSE`, `ACK`, `PONG`) and every stage below is identical to WebSocket.

The engine does not probe the server before the run. Instead, when there is a slower transport to fall back to, the first stage's connection gets 3 seconds to open. If it is refused or not answered in time, for example on a network that only passes HTTPS, the engine repeats that stage over the next transport in the list and runs the rest of the test there. Failures after a connection opened do not switch transports. `transport: 'tcp'`, `'ws'`, and `'wss'` skip all of this and use one transport.

Raw TCP saves the client the WebSocket mask on every uploaded byte and lets it count downloaded frames without copying them. Browsers cannot open raw TCP connections. Results record the transport in `testType.testProtocol` (`TCP`, `WS`, or `WSS`).

### Browser Worker

In a browser, the page's main thread also renders the page and runs the application. While it is busy, socket events and timers wait: snapshots and acknowledgements arrive late, uploads are refilled late, and pings look slower. A page that redraws charts on every progress callback can measure far below the link's speed.

So in browsers the engine runs every stage (latency, both estimations, download, upload, and the loaded latency monitor) in a dedicated Web Worker, unless `config.browserWorker` is `false`. The upload phase gets a new worker after a download phase, so the download sockets are dropped at once (see [Stage 3](#stage-3--download-throughput) on `CLOSE`). The engine stays on the main thread and talks to the worker by message: it sends each stage's options and a cancel message, and receives pings, snapshots, results, and errors. Timing happens inside the worker, so it does not depend on the page. Callbacks still run on the main thread, so a busy page may show progress a little late, but the numbers are not affected.

The worker script is built into the library and started from a `blob:` URL. It needs no bundler configuration or extra file. The engine falls back to the main thread, with the same results as before, when:

- the browser refuses the worker, for example because the page's Content Security Policy does not allow `blob:` workers (`worker-src blob:`, or `child-src` / `script-src` when `worker-src` is not set);
- the runtime has no `Worker`, `Blob`, or `URL.createObjectURL`, or the worker has no `WebSocket`;
- the worker does not report ready within 3 seconds;
- the page installed its own `WebSocket` implementation, which the worker would not use.

If the worker fails after it started, the stage in progress fails and later stages run on the main thread. A new worker is started for each run and stopped when it ends.

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
       │    │  1 socket, rounds tripling in size                         │
       │    │  → SpeedEstimationResult (speedMbps → determines config)  │
       │    └────────────────────────────────────────────────────────────┘
       │
       ├─ Stage 3: download ────────────────────────────────────────────┐
       │    │  N parallel sockets, sustained binary streaming           │
       │    │  + 1 dedicated socket, PING/PONG every 500 ms once loaded │
       │    │  → SpeedTestData (speedMbps, bytes, snapshots[],          │
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
            │  + 1 dedicated socket, PING/PONG every 500 ms once loaded │
            │  → SpeedTestData (speedMbps, bytes, snapshots[],          │
            │                   loadedLatency)                          │
            └────────────────────────────────────────────────────────────┘

       Assemble NetworkTestResultTestResults
       POST to map.coveragemap.com
```

Stage markers recorded in the result payload:

| Stage(s) | Marker recorded |
|---|---|
| Before latency | `latencyStart` |
| After latency | `latencyEnd` |
| Before downloadEstimation | `downloadStart` |
| After download | `downloadEnd` |
| Before uploadEstimation | `uploadStart` |
| After upload | `uploadEnd` |

Each marker snapshot captures: timestamp (ISO 8601 UTC), connection type, external IP, ISP, location, and network details. Markers are recorded only for enabled stages. An end marker is recorded whenever its phase ran and ended, whether it passed or failed: a failed download phase records `downloadStart` and `downloadEnd`, and `failedStage` says which phase failed. A cancelled run records no end marker for the phase it was cancelled in (it is not uploaded either).

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

#### When the latency stage is disabled

With `tests.latency: false`, the later stages still need a latency to subtract. The first enabled download or upload phase therefore starts with one silent `PING` (after its `downloadStart` or `uploadStart` marker, like the native engine) and uses that round trip for normalization only. It is not reported: the result's `latency`, `jitter`, and `latenciesList` are `null`, `onLatencyPing` and `onLatencyResult` do not fire, and no `latencyStart`/`latencyEnd` markers are recorded. If that ping fails, the phase it belongs to fails.

#### Timeouts and Defaults

| Parameter | Default | Configurable range |
|---|---|---|
| `pingCount` | 15 | 5 – 50 |
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
  [if adjusted duration < 100ms, or the round stalled: three times the payload, repeat]
Client ──── "START <kb × 3> 1" (text frame) ────────► Server
Client ◄─── <binary payload ~<kb × 3> KB> ──────────── Server
  [until a clean round of ≥ 100ms, 5 MB, or 2 s since the first round]
```

The `<kb>` in the `START` command is the requested payload size in **kilobytes** (integer). The server streams a single binary frame of approximately that size.

#### Adaptive Growth Algorithm

The rules are shared with the native libraries (`src/utils/adaptive.ts`):

```
messageSizeBytes = 10 KB (initial: 10, 30, 90, 270, 810, 2430, 5120 KB)
rounds = []

loop:
  send "START <messageSizeBytes/1024> 1"
  receive binary frame of byteLength
  durationMs = max(now - startTime - (latencyMs + jitterMs), 1)
  speedMbps = bytes / (durationMs * 125)

  if durationMs >= 100 and the thread was blocked for > 50 ms during this round and repeats < 3:
    repeats += 1
    continue                                   (same size again)
  rounds.push({ bytes, durationMs, speedMbps })
  reference = the fastest of the last 3 rounds

  if 2 s have passed since the first round started:       stop
  else if durationMs < 100:
    if messageSizeBytes < 5 MB: messageSizeBytes *= 3 (at most 5 MB); continue
    else stop
  else if this is the first round and messageSizeBytes < 5 MB:
    messageSizeBytes *= 3; continue                                (never trusted alone)
  else if speedMbps >= reference.speedMbps / 2:            stop   (a clean round)
  else:                                                            (a stalled round)
    if messageSizeBytes < 5 MB: messageSizeBytes *= 3 (at most 5 MB)
    continue

resolve the fastest of the last 3 rounds { durationMs, bytes, speedMbps }
```

Tripling reaches 5 MB in 7 rounds, three round trips fewer than doubling, which matters most on long paths. A slow link still stops early: at 100 kbps the first 10 KB round takes about 820 ms, and the second (30 KB, about 2.5 s) confirms it.

**A slow first round is never trusted alone.** With nothing to compare it with, it can't tell a slow link from one that stalled: on a 300 ms path, an upload estimate read 0.1 Mbps after its first 5 KB took a round trip longer. Only links under about 0.8 Mbps take 100 ms or more for the first round, so only they pay for the second round.

**Stalled rounds.** A round that took 100 ms or more but ran at less than half the reference speed stalled, most likely on a lost packet: its recovery costs a round trip, or a retransmission timeout for a loss near the end of a message. Asking for more data cannot make a link slower, so estimation goes on with a larger round, which spreads the recovery over more data. Stopping on the first slow round, as before, made a 940 Mbps link with 1% loss estimate 1 to 90 Mbps and run its stage on 2 to 4 connections. Estimation settles 2 s after its first round in any case.

**The estimate is the fastest of the last three rounds**, not the last one: a stall can only make a round look slower. Earlier, smaller rounds are left out, because a round of a few KB takes only milliseconds beyond the latency, and a millisecond of jitter can make it read several times too fast.

A slow round only counts if the network made it slow. A heartbeat timer runs every 10 ms during each round; if one arrives more than 50 ms late, the thread was blocked (an application rendering between stages, for example), so the message was handled late and the round's timing is not the network's. Such a round is repeated at the same size, up to 3 times, before it is used. Without this, a page that rendered for a few hundred milliseconds right after a stage could make a gigabit link estimate below 1 Mbps. Upload estimation does the same.

#### Error Recovery

On WebSocket error, the stage retries up to **3 times** with a 1-second delay between attempts before failing permanently.

#### Timeout

Default: **15,000 ms** (configurable 3,000–30,000 ms). If no response arrives in time, the stage fails.

---

### Stage 3 — Download Throughput

**Purpose:** Saturate the available downstream bandwidth by streaming binary data over multiple parallel WebSocket connections simultaneously.

#### Connection Count and Message Size

The stage starts with the connection count for its estimate:

**Download connection count:**

| Estimated speed | Connections |
|---|---|
| < 0.5 Mbps | 1 |
| 0.5 – 1 Mbps | 2 |
| 1 – 10 Mbps | 4 |
| 10 – 100 Mbps | 6 |
| 100 – 1000 Mbps | 8 |
| ≥ 1000 Mbps | 12 |

The [scale-up](#scale-up) may add connections during the stage.

**Message sizes.** Each message holds about 10 ms of its connection's speed (`MESSAGE_TARGET_MS`), as a power of two from 1 KB to 4 MB, or 5 MB (`DOWNLOAD_MESSAGE_SIZES_KB`). Too small a message costs a fast link per-message work (events, frames, and in JavaScript one callback per message); too large a message, on a slow link, arrives in a lump that makes the gauge pulse, since browsers count whole messages. A connection's first batch is sized for 2.5 ms of its share of the estimate (`getDownloadMessageSizeKb`, `FIRST_MESSAGE_TARGET_MS`): a batch of messages too small ends quickly and the next is sized from what was measured, while one too large would last the whole stage, so the first batch starts small. Every later batch is sized for 10 ms of what the connection received over the last 500 ms, so it grows on a fast link and shrinks on a slow one:

| Speed per connection | Message | Time per message |
|---|---|---|
| 100 kbps | 1 KB (the minimum) | 82 ms |
| 1 Mbps | 1 KB | 8 ms |
| 10 Mbps | 16 KB | 13 ms |
| 100 Mbps | 128 KB | 10 ms |
| 1 Gbps | 1 MB | 8 ms |
| 3 Gbps | 4 MB | 11 ms |

Servers keep one zero-filled buffer per message size, so a fixed set of sizes (about 13 MB together) keeps that memory bounded.

#### Message Exchange

All sockets are opened in parallel. Once every socket is connected, the test begins simultaneously:

```
Client ──── "START <kb> 200" ──────────────────────► Socket 0
Client ──── "START <kb> 200" ──────────────────────► Socket 1
Client ──── "START <kb> 200" ──────────────────────► Socket N
                                                        │
Client ◄─── binary frame ◄─── binary frame ◄──── binary frame ─── ...
  [what is still due covers less than max(2 round trips, 300 ms)]
Client ──── "START <10 ms of the socket's speed> 200" ──► Socket 0   (first batch still sending)
Client ◄─── <kb> frame ◄─── <kb'> frame ◄─── <kb> frame ◄─── <kb'> frame ─── ...
  [continuous streaming for durationMs, all sockets in parallel]
```

The `200` count asks the server for 200 frames per `START`; at 10 ms each, a batch is about 2 s of data. Each frame is approximately `<kb>` kilobytes. Each socket keeps a running total of the frames it has requested but not received: every `START` adds 200 and every frame received subtracts 1. It asks for the next batch while what is still due covers max(2 round trips at the minimum latency, 300 ms) at its message rate over the last 500 ms, so the server always has the next batch before the current one runs out and the link never idles between batches. That is at most one batch, so a socket never has more than two outstanding: the CDN server queues a whole `START` at once, up to 96 MiB, and drops a connection with about 256 MB unsent. Before a socket has 50 ms of history it asks once 100 or fewer are due, at four times the size (a first batch that ended that fast was far too small).

The server starts sending a new batch immediately, alongside the one still in progress, so whole frames of the two batches interleave and differ in size. The client does not rely on batch order or frame size; only the running total matters. Frames beyond everything requested are not counted. The test's wall-clock `durationMs` timer ends the stage regardless of how many frames were received, and no request goes out after it.

```
outstanding = 0
request(kb):  outstanding += 200; lastKb = kb; send "START <kb> 200"
start:        request(messageSizeKb)                        (2.5 ms of the connection's share)
on frame:     if outstanding = 0: ignore
              count its bytes; outstanding -= 1
              rate = frames and bytes per second over the last 500 ms (null under 50 ms of history)
              due = rate ? min(ceil(rate.frames × max(2 × latencyMs, 300) / 1000), 200) : 100
              if outstanding <= due and the stage is running:
                request(rate ? nearestSize(rate.mbps × 10 ms) : nearestSize(lastKb × 4))
```

**When bytes count.** In Node.js, raw TCP sockets and the [Node.js WebSocket client](#nodejs-websocket-client) report a frame's payload bytes as they arrive, once per socket read, and the lane counts them then (each byte once: the frame's message event adds nothing more). A snapshot or the end of the stage therefore also counts the frames still arriving, as in the native libraries. The browser WebSocket API only delivers whole messages, so in browsers (and with `config.nodeWebSocket: false`) a frame counts once it has fully arrived, and up to one frame per socket can be left out of a snapshot or the stage total.

When the stage ends, the download sockets stop requesting more messages but stay open while the loaded latency monitor waits for its last `PONG` (at most 100 ms), so that ping still measures a loaded link; bytes that arrive then are not counted. Each download socket then sends the text command `CLOSE` before closing. The server ends the connection at once instead of first delivering every frame it has already queued, which on a slow link would otherwise occupy the downlink well into the next stage. Servers that do not know the command ignore it.

The CDN server (a Cloudflare Worker) cannot reset a connection: it closes cleanly, and Cloudflare still delivers the frames it already queued, while a browser can only close a WebSocket gracefully. On a 1 Mbps link that left the upload stage at about 60% of the link. So in browsers the upload phase runs in a new stage worker: the worker that ran the download is terminated during the 500 ms cooldown, which drops its sockets at once, like the native clients' hard close. With that, the upload measures the same after a download as on its own (about 100%, against the CDN at 1 Mbps). On the main thread (`browserWorker: false`, or where a worker cannot start) the graceful close remains.

#### Threads

A single JavaScript thread cannot receive or send TLS at 10 Gbps. When the estimate is 1 Gbps or more (the single socket estimate tops out at a few Gbps however fast the link is), Node.js spreads the sockets across worker threads: 6 when `config.throughputThreads` is `0` (its default, which picks the count automatically), two sockets each, and at most one per CPU core (the server runs elsewhere, and the calling thread only takes snapshots and loaded latency pings). Each worker runs the same lane code and publishes its byte count through a `SharedArrayBuffer`, so the main thread's snapshots stay real time. Workers open the same kind of socket as the calling thread: raw TCP and the [Node.js WebSocket client](#nodejs-websocket-client) load inside the worker; a global `WebSocket` is only used in a worker when it is the same implementation as the application's, so a polyfill keeps every socket on the calling thread. Below 1 Gbps or with `throughputThreads: 1` every socket stays on the calling thread. In browsers every socket of a stage runs on one thread: the [browser worker](#browser-worker), or the page's main thread when it is off or cannot start.

#### Node.js WebSocket client

In Node.js, `ws://` and `wss://` sockets come from the library's own client (`src/tests/node-websocket.ts`) instead of `globalThis.WebSocket`, so no polyfill is needed on any supported Node.js version. Node's built-in `WebSocket` masks every upload byte and copies every download byte in JavaScript, which held a thread to about half its TLS throughput. The client speaks standard WebSocket and differs only in what it does with the payload:

- Download messages above 64 KiB are counted, not read: the frame parser skips their payload, and the message arrives as a zero-filled `ArrayBuffer` of the right length.
- Download bytes are reported as they arrive (`onpayloadprogress`): for each read, once per message it carries bytes of, and before that message is delivered, so a frame still arriving counts toward snapshots and the stage total. Both this client and raw TCP sockets get it from speed-transport's public payload progress hook (`FrameParserHandler.onPayloadProgress`, `SpeedTransportSocket.onpayloadprogress`, speed-transport 0.3.0 and later).
- Upload chunks are zeros, so a masked chunk is the masking key repeated. Each chunk size is masked once with a random key and that frame is sent again and again. RFC 6455 asks for a fresh key per frame so that page scripts cannot choose the bytes intermediaries see; the payload here is always zeros chosen by the library. Commands get a fresh key per frame.

Bun and Deno keep their native `WebSocket`. If the client cannot load, the global `WebSocket` is used as before.

Applications that need their own `WebSocket` in Node.js, for example one that goes through an HTTP proxy, adds headers, or uses custom TLS options, set `config.nodeWebSocket: false`. Every socket of the run, the loaded latency socket and worker thread sockets included, then comes from `globalThis.WebSocket` as before this client existed. Worker threads are only used when the workers' `WebSocket` is the same implementation, so a polyfill keeps every socket on the calling thread, and the built-in client's per-byte work applies again. Raw TCP is unaffected.

#### Scale-up

An estimate can still be far too low, and on a path with loss the connection count decides the speed: TCP limits each connection, and only more connections carry more. So the stage checks its own speed at 1, 2, and 3 s after its first counted bytes (`SCALE_UP_CHECKS_MS`):

```
at each check, while at least 3 s of the stage are left (MIN_SCALE_UP_REMAINING_MS):
  mbps = the stage's speed over the last 500 ms
  target = min(connectionCount(mbps / 1.25), 12)            (the same table as the estimate)
  if target > connections asked for so far:
    open (target - connections) more at once, spread over the threads with the fewest,
    each starting at 2.5 ms of mbps / target
```

Connections are only added, never closed. The 25% margin (`SCALE_UP_MARGIN`) keeps a link near a threshold where it is: right after the ramp-up, data the client hadn't read yet arrives in a burst, and a 940 Mbps link read over 1 Gbps for a moment. A connection that fails to open is dropped without failing the stage. No threads are added mid-stage, so a stage estimated under 1 Gbps stays on one thread even with 12 connections.

The added connections slow-start, so the measurement restarts once they carry data: 250 ms after the last of them counted its first bytes, or 1.25 s after the scale-up if one never does (`SCALE_UP_SETTLE_MS`). A 7 s stage that scales up at 3 s still measures about 3.7 s. The result reports the connections the stage started with and the ones it ended with (see [`testType`](result-schema.md#testtype)).

#### Measurement Model

```
testStartTime = performance.now()          (every socket is open; traffic starts)

stageSpeed(bytes, elapsed) = bytes / (max(elapsed - (latencyMs + jitterMs), 1) * 125)

when the first bytes of the stage are counted:
  250 ms later (the ramp-up exclusion), unless the stage has ended:
    fromMs = now - testStartTime
    fromBytes = totalBytes
  1000 ms later (the loaded latency delay), unless the stage has ended:
    the link is loaded (loaded latency pings start, see below)

when a scale-up's connections settled (see Scale-up):
  250 ms later, unless the stage has ended:
    fromMs = now - testStartTime
    fromBytes = totalBytes
    liveFrom = the live speed last shown

speed(bytes, elapsed) =
  fromMs set and elapsed > fromMs ? (bytes - fromBytes) / ((elapsed - fromMs) * 125)
                                  : stageSpeed(bytes, elapsed)

liveSpeed(bytes, elapsed) =                (progress callbacks only)
  fromMs not set or elapsed <= fromMs ? stageSpeed(bytes, elapsed)
  : w = min((elapsed - fromMs) / 1000, 1)  (LIVE_SPEED_BLEND_MS)
    from = liveFrom set ? liveFrom : stageSpeed(bytes, elapsed)
    from + (speed(bytes, elapsed) - from) * w

every snapshotIntervalMs (default 100ms):
  elapsed = now - testStartTime
  store SpeedSnapshot { timeOffsetMs: elapsed, speedMbps: speed(totalBytes, elapsed), bytes: totalBytes }
  emit  the same snapshot with speedMbps: liveSpeed(totalBytes, elapsed)

after durationMs (from testStartTime, not from the first bytes):
  elapsed = now - testStartTime
  resolve { durationMs: elapsed, speedMbps: speed(totalBytes, elapsed), bytes: totalBytes, snapshots }
```

All sockets accumulate into a single `totalBytes` counter. The final speed is computed from the aggregate data across all connections. Speeds are rounded to 3 decimal places.

The ramp-up at the start of a stage, while the connections speed up, is left out of `speedMbps`: it is measured from 250 ms after the first bytes are counted (the first download bytes to arrive, or the first whole binary frame where bytes count per frame; the first `ACK` for upload) to the stage's end. Everything after that point counts, so a ramp-up longer than the exclusion still lowers the speed, and the wait for the first byte is already excluded, so no latency bias is subtracted. Before that point, or when the stage ends before it, the speed is the whole stage's. Snapshots switch formula at the same point, so the final value continues the last progress values. The progress callbacks get a live speed instead, so a gauge does not jump at that point: it is the whole stage's speed until the measurement start, then moves in a straight line to the measured speed over the next 1,000 ms (`LIVE_SPEED_BLEND_MS`), and is the measured speed from then on. Right after the start the measured window is only milliseconds long and holds no message or `ACK` at all, or a whole one, so its speed would read about 0 or spike. When a scale-up restarts the measurement, the live speed blends the same way, from the value it showed at that moment. The snapshots stored in the result keep the measured speed. Both the 250 ms exclusion and the 1 s loaded latency delay are fixed; applications cannot configure them. With worker threads, each worker tells the main thread once when its lane counts its first bytes, and the main thread does all the timing.

#### Loaded Latency Monitor

A dedicated WebSocket connection is opened to the same server at the start of Stage 3. Its first `PING` text frame waits until the link carries the stage's traffic: 1,000 ms after the stage's first bytes are counted. This delay is separate from the ramp-up exclusion of the speed (see [Measurement Model](#measurement-model)). Pinging from the stage start would measure a link that is still idle. If the socket is not open yet at that point, it pings as soon as it opens. It then sends another `PING` 500 ms after each `PONG` is received. RTT is measured with `performance.now()` at send and receive time.

```
[Stage 3 starts]                 → open LoadedLatencySocket, no PING yet
[1,000 ms after the first bytes]
LoadedLatencySocket ──── "PING" ──────────────────────────────► Server
LoadedLatencySocket ◄─── "PONG" ───────────────────────────── Server
  [wait 500 ms]
LoadedLatencySocket ──── "PING" ──────────────────────────────► Server
LoadedLatencySocket ◄─── "PONG" ───────────────────────────── Server
  ... (repeated until stage timer fires)

[durationMs timer fires → finishTest() called]
  → take the stage's bytes and speed; stop download requests (no more START),
    but keep the transfer sockets open so the link stays loaded
  → if a PING is in flight: wait up to 100 ms for final PONG (grace period)
  → close LoadedLatencySocket, then the transfer sockets
  → compute LatencyTestData from collected RTTs
  → attach as SpeedTestData.loadedLatency (null if no pings completed)
```

Because these probes run while the download sockets are saturating the link, the resulting RTT values reflect latency **under load** rather than idle baseline latency. Compare `loadedLatency.minLatency` against the pre-test `LatencyTestData.minLatency` to measure the latency increase caused by congestion.

`loadedLatency` is `null` in the result if no PONG was received before the monitor stopped (e.g. the stage ended less than 1,000 ms after its first bytes, or the connection took longer to open than the stage).

#### Defaults

| Parameter | Default | Configurable range |
|---|---|---|
| `downloadDurationMs` | 7,000 ms | 3,000 – 30,000 ms |
| `snapshotIntervalMs` | 100 ms | 50 – 5,000 ms |
| Ramp-up exclusion after the first bytes | 250 ms | (fixed) |
| Loaded latency delay after the first bytes | 1,000 ms | (fixed) |
| Messages per START | 200 | (fixed) |
| Message size | 10 ms of the connection's speed (2.5 ms for the first batch), 1 KB – 5 MB | (fixed) |
| Scale-up checks after the first bytes | 1, 2, 3 s | (fixed) |
| Scale-up margin | 1.25 × the tier threshold | (fixed) |
| Loaded latency ping interval | 500 ms | (fixed) |
| Loaded latency grace period | 100 ms | (fixed) |

---

### Stage 4 — Upload Estimation

**Purpose:** Mirror of download estimation, but for upstream. Determine the optimal payload size and expected upload speed before the full upload test.

#### Message Exchange

```
Client ──── Uint8Array(<bytes>) ─────────────────────► Server
  [chunked into ≤ 1 MB pieces if bytes > 1 MB]
Client ◄─── "ACK" (text frame, one per chunk) ──────── Server

  [if adjustedMs < 100ms, or the round stalled: three times the bytes, repeat]
Client ──── Uint8Array(<bytes * 3>) ────────────────► Server
Client ◄─── "ACK" ... "ACK" ───────────────────────── Server
  [until a clean round of ≥ 100ms, 5 MB, or 2 s since the first round]
```

**Chunking rule:** If the target `bytes` exceeds 1 MB, the payload is split into 1 MB chunks. The server sends one `ACK` per chunk. The stage waits for all ACKs before evaluating the duration.

#### Adaptive Growth Algorithm

The same as download estimation (see [Stage 2](#stage-2--download-estimation)), from 5 KB: 5, 15, 45, 135, 405, 1215, 3645, 5120 KB. A round is every chunk of its bytes, sent at once, and ends when every `ACK` has arrived:

```
bytes = 5 KB (initial)

loop:
  chunks = split bytes into ≤ 1 MB pieces
  startTime = now
  for each chunk: socket.send(chunk)
  wait for one ACK per chunk
  durationMs = max(now - startTime - (latencyMs + jitterMs), 1)
  then as download estimation: repeat a blocked round, grow while under 100 ms or stalled,
  stop on a clean round, at 5 MB, or after 2 s; resolve the fastest of the last 3 rounds
```

#### Timeout

Default: **15,000 ms** (configurable 3,000–30,000 ms).

---

### Stage 5 — Upload Throughput

**Purpose:** Saturate available upstream bandwidth by continuously sending binary data bursts across multiple parallel WebSocket connections.

#### Connection Count and Chunk Size

Same lookup tables as download (see [Stage 3](#stage-3--download-throughput)), using the upload estimation result as the input.

**Upload chunk size.** Each chunk holds about 10 ms of its connection's acknowledged speed, as a power of two from 1 KB to 1 MB (`UPLOAD_CHUNK_SIZES_KB`). The first chunks hold 2.5 ms of the connection's share of the estimate (`getUploadMessageSizeKb`), for the same reason as download's first batch: chunks too large for the link would sit queued for the whole stage and be credited in lumps. Every 500 ms each connection resizes its chunks from what it had acknowledged over the last 500 ms (`getNextUploadChunkSizeKb`).

#### Message Exchange

```
Client ──── Uint8Array(chunk) ──────────────────────► Socket 0  ─┐
Client ──── Uint8Array(chunk) ──────────────────────► Socket 1   │ kept topped up
Client ──── Uint8Array(chunk) ──────────────────────► Socket N   │ for durationMs
Client ◄─── "ACK" (one per chunk, counted for throughput) ◄─────┘
```

#### Backpressure Control

The sockets share one preallocated chunk per size, and each keeps its send buffer topped up to two of its chunks (at least 16 KB). The WebSocket API has no drain event, so sockets are refilled after acknowledgements arrive and on a 5 ms timer:

```
target = max(2 × chunkBytes, 16 KB)

refill(socket):
  mbps = acknowledged Mbps over the last 500 ms (null under 50 ms of history)
  every 500 ms: chunkBytes = getNextUploadChunkSizeKb(chunkBytes, mbps)
  limit = max(64 × chunkBytes, mbps ? min(mbps × 125 × 8 × max(latencyMs, 50), 64 MiB) : 0)
  while socket.bufferedAmount < target
    and unacknowledged bytes + chunkBytes <= limit:
    socket.send(chunk of chunkBytes); remember its size

on ACK:
  credit the oldest unacknowledged chunk's size
```

Chunk sizes differ over a stage, so each `ACK` credits the oldest chunk still unacknowledged (the server answers in order, one `ACK` per message).

**Data in flight** (`getUploadInFlightLimitBytes`) is limited in bytes: 64 of the connection's current chunks, or 8 round trips (at the minimum latency, at least 50 ms) of the speed it acknowledged over the last 500 ms, whichever is more, at most 64 MiB (as before: 1.7 Gbps per connection at a 300 ms round trip). The chunks stay small, so the gauge moves smoothly on a slow link, while the data in flight follows the link: a connection held back by the limit acknowledges about 8 round trips' worth per round trip, so the limit grows about 8 times per round trip until the link is what limits it. With 64 chunks alone, a connection that started on 1 KiB chunks had 64 KiB in flight, 1.7 Mbps at a 300 ms round trip; measured at 300 ms, upload had fallen from 417 to 210 Mbps. On a slow link whose buffers take whatever is sent, the limit stays near 8 round trips, so the backlog left when the stage ends stays small. Counting bytes also means a connection that shrank its chunks adds no more behind the larger ones still in flight.

A refill stops after 4 ms of work, and acknowledgements that arrive together share one refill, so a client that is short of CPU still emits snapshots and loaded latency probes on time. The in-flight limit, at most 64 MiB, also bounds memory with WebSocket implementations that do not report `bufferedAmount`.

**Throughput is computed from acknowledged bytes**: a chunk counts once the server's `ACK` for it arrives, so data still queued on the client is never counted.

#### Loaded Latency Monitor

Identical in design to the download stage loaded latency monitor. A dedicated PING/PONG WebSocket connection opens when Stage 5 starts and probes from 1,000 ms after the first `ACK`, then 500 ms after each `PONG`. The collected RTTs are attached to the upload result as `SpeedTestData.loadedLatency`. See the [download stage loaded latency description](#loaded-latency-monitor) for the full exchange sequence and timing details.

#### Measurement Model

Identical to download: `snapshotIntervalMs` periodic snapshots, a wall-clock `durationMs` deadline, and the speed measured from 250 ms after the first bytes, which for upload is the first `ACK`.

#### Defaults

| Parameter | Default | Configurable range |
|---|---|---|
| `uploadDurationMs` | 7,000 ms | 3,000 – 30,000 ms |
| `snapshotIntervalMs` | 100 ms | 50 – 5,000 ms |
| Refill timer | 5 ms | (fixed) |
| Ramp-up exclusion after the first `ACK` | 250 ms | (fixed) |
| Loaded latency delay after the first `ACK` | 1,000 ms | (fixed) |
| Chunk size | 10 ms of the connection's speed (2.5 ms at first), 1 KB – 1 MB | (fixed) |
| Scale-up checks after the first `ACK` | 1, 2, 3 s | (fixed) |
| Loaded latency ping interval | 500 ms | (fixed) |
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

Raw measured durations include network round-trip overhead that isn't part of the data transfer itself. The estimation stages, and the throughput stages' `speedMbps` until the measurement start (or for a stage that ends before it), remove this bias by subtracting the latency and jitter baselines measured in Stage 1. A throughput `speedMbps` measured from 250 ms after the first bytes needs no correction, since that point is already past the wait for the first byte:

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

The estimation stages grow their rounds threefold until one takes **100 ms** beyond the latency (and didn't stall), reaches 5 MB, or 2 s have passed:

| Connection speed | First round (10 KB) beyond the latency | Rounds |
|---|---|---|
| 100 kbps | ~820 ms | 2 (10, 30 KB) |
| 1 Mbps | ~80 ms | 2 (10, 30 KB) |
| 10 Mbps | ~8 ms | 4 (up to 270 KB) |
| 100 Mbps | ~0.8 ms | 6 (up to 2430 KB) |
| 1 Gbps | ~0.08 ms | 7 → capped at 5 MB |

At the 5 MB cap the estimate reflects the transfer time of the largest rounds, which still provides a reliable throughput estimate even if the target duration wasn't reached.

The throughput stages then size every message from the speed each connection measures, about 10 ms of it (see [Stage 3](#connection-count-and-message-size) and [Stage 5](#connection-count-and-chunk-size)), and the [scale-up](#scale-up) adds connections when the estimate was far too low.

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

1. `failedReason` is set to `"<reason>: <message>"`, where `<reason>` is the error's failure reason (below) and `<message>` its message.
2. `failedStage` is the start marker of the phase that failed:

| Engine stage | `failedStage` recorded |
|---|---|
| `latency` | `"latencyStart"` |
| `downloadEstimation` or `download` | `"downloadStart"` |
| `uploadEstimation` or `upload` | `"uploadStart"` |

   With the latency stage disabled, a failed latency normalization ping fails the phase it runs in (`downloadStart` or `uploadStart`).
3. The failed phase's end marker (`latencyEnd`, `downloadEnd`, or `uploadEnd`) is recorded.
4. `engine.callbacks.onError(error, stage)` fires.
5. The engine continues to the result assembly step and uploads the partial result.

Failure reasons are the native engine's `FailureReason` values, so failures from every CoverageMap client group the same way. Errors are tagged where they are created (`SpeedTestError.reason`), including across the browser Web Worker and Node.js worker threads:

| Reason | When |
|---|---|
| `unreachable` | No transport the server offers can be used from this runtime |
| `connectionFailed` | A connection was refused, could not be created, or dropped |
| `connectionTimeout` | A connection did not open in time (the first connection's 3 s window, or a stage timeout before it connected) |
| `transferTimeout` | A throughput stage did not move data: none within 10 s, or none by the end of a shorter stage (as in the native engines) |
| `timeout` | A stage did not finish in time after it connected |
| `protocolError` | The server answered with something the protocol does not allow |
| `unknown` | Any other error |

For example: `"connectionTimeout: Connection not open after 3000ms"`, `"connectionFailed: Download WebSocket connection 3 failed"`. A cancelled run is the exception: `failedReason` is `"Cancelled"` and `failedStage` is the engine stage it was cancelled in (`latency`, `downloadEstimation`, `download`, `uploadEstimation`, or `upload`), as in the native engines. Cancelled runs are never uploaded, so only the `run()` result and `onComplete` carry these values.

Partial results (where a stage failed) still include all data that was collected up to the point of failure. For example, if download succeeds but upload fails, the result contains valid `downloadSpeed` and `latency` but `uploadSpeed: null`.

The `testStatus` field is `"passed"` when `failedStage` is null, and `"failed"` otherwise.

---

## Phase 3: Result Upload

When a run ends, passed or failed, the engine uploads the assembled result to:

```
POST https://map.coveragemap.com/api/v1/speedTests
Content-Type: application/json

[NetworkTestResultTestResults, ...]
```

The body is a JSON array (batch format), containing a single result per standard test run.

A failed run is uploaded too, with `failedStage` and `failedReason`. A cancelled run is not uploaded. This upload is fire-and-forget from the engine's perspective — it does not block the resolved `run()` promise.

### Upload Queue Fallback

If the upload POST fails (network error, server unavailable, etc.), the result is saved to `localStorage` under the key `coveragemap-test-results-queue`.

```
coveragemap-test-results-queue → JSON array of NetworkTestResultTestResults
```

On the **next call** to `engine.run()`, the engine retries the queue in the background, alongside the new test; it does not wait for the retry:

```
engine.run() called
  → flushUploadQueue()  // started, not awaited: retries previously failed uploads
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
| `pingCount` | 15 | 5 | 50 | Number of PING/PONG probes per latency stage |
| `downloadDurationMs` | 7,000 | 3,000 | 30,000 | Download throughput stage wall time (ms) |
| `uploadDurationMs` | 7,000 | 3,000 | 30,000 | Upload throughput stage wall time (ms) |
| `snapshotIntervalMs` | 100 | 50 | 5,000 | Progress snapshot interval (ms) |
| `latencyTimeoutMs` | 10,000 | 3,000 | 30,000 | Timeout for latency stage (ms) |
| `estimationTimeoutMs` | 15,000 | 3,000 | 30,000 | Timeout for estimation stages (ms) |
| `throughputThreads` | 0 | 0 | 64 | Threads for stages estimated at 1 Gbps or more: `0` picks automatically (6), `1` keeps every socket on the calling thread. Node.js only (see [Threads](#threads)) |
| `transport` | `'auto'` | | | `'auto'`, `'tcp'`, `'ws'`, or `'wss'`. `auto` uses raw TCP in Node.js, then WebSocket, then secure WebSocket only where required (see [Raw TCP Transport](#raw-tcp-transport)) |
| `browserWorker` | `true` | | | In browsers, run the stages in a Web Worker (see [Browser Worker](#browser-worker)). `false` uses the page's main thread |

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

The protocol runners use the WebSocket API and `globalThis.fetch` — no browser-specific APIs. In Node.js the sockets come from the library's [Node.js WebSocket client](#nodejs-websocket-client), or from `@coveragemap/speed-transport` when the run uses [raw TCP](#raw-tcp-transport). In Node.js environments:

- No WebSocket implementation or polyfill is needed on any supported Node.js version, for raw TCP, WebSocket, and secure WebSocket servers alike (including CDN servers). A `globalThis.WebSocket` polyfill is only used if the library's client cannot load, or with `config.nodeWebSocket: false`.
- Multi-gigabit stages run their sockets on worker threads (see [Threads](#threads)).
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
