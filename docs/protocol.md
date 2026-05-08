# Speed Test Protocol

This document describes the transport protocol and runtime behavior used by
`@coveragemap/speed-test` when executing a full speed test run.

The protocol is designed around a CoverageMap WebSocket endpoint:

- Path: `/v1/ws`
- Transport: `wss://` for remote servers, `ws://` for local server id `local`
- Session model: short-lived sockets per stage (or per connection lane in throughput stages)

## Protocol goals

The protocol aims to:

- produce stable, repeatable download/upload estimates across varying network conditions,
- separate low-cost "estimation" from full-throughput stages,
- capture enough timing detail to create telemetry snapshots and robust failure metadata,
- support browser and backend runtimes with the same result schema.

## End-to-end stage sequence

By default, `SpeedTestEngine.run()` executes stages in this order:

1. `latency`
2. `downloadEstimation`
3. `download`
4. `uploadEstimation`
5. `upload`

When tests are enabled, the engine records stage transitions and maps them to result-stage markers:

- `latency` -> `latencyStart`
- `downloadEstimation` and `download` -> `downloadStart` / `downloadEnd`
- `uploadEstimation` and `upload` -> `uploadStart` / `uploadEnd`

## Stage-by-stage protocol details

## 1) Latency stage

Purpose:

- estimate base RTT and jitter to normalize later throughput timing.

Message exchange:

- client sends text frame: `PING`
- server responds text frame: `PONG`

Completion:

- repeats for `pingCount` probes,
- returns latency stats (`min`, `avg`, `median`) and jitter stats.

Timeout/failure behavior:

- default timeout is `latencyTimeoutMs`,
- if fewer than 3 valid RTTs are collected by timeout, stage fails,
- cancellation raises `CancellationError`.

## 2) Download estimation stage

Purpose:

- identify reasonable payload sizing for the full download stage.

Message exchange:

- client sends text command: `START <kb> 1`
- server responds with binary payload near requested size.

Adaptive behavior:

- starts with small payload (`10 KB`),
- if adjusted duration is below target (`100ms`) payload doubles,
- capped by max payload (`5 MB`).

Return values:

- measured bytes,
- adjusted duration,
- estimated throughput in Mbps.

## 3) Download throughput stage

Purpose:

- run sustained downstream transfer using multiple parallel sockets.

Message exchange:

- opens `N` sockets (derived from estimation),
- each socket sends `START <kb> <iterations>`,
- server streams binary frames continuously.

Measurement model:

- aggregates `byteLength` of incoming binary frames,
- samples progress every `snapshotIntervalMs`,
- completes after configured duration (`downloadDurationMs`).

## 4) Upload estimation stage

Purpose:

- estimate upstream throughput with short adaptive bursts.

Message exchange:

- client sends binary chunk payloads,
- server acknowledges with text frame `ACK` for each chunk.

Adaptive behavior:

- starts at small payload (`5 KB`),
- scales upward until adjusted transfer duration exceeds target (`100ms`),
- capped at `5 MB`.

## 5) Upload throughput stage

Purpose:

- run sustained upstream transfer with backpressure-aware burst sending.

Message exchange:

- opens `N` sockets,
- repeatedly sends binary bursts,
- optional ACKs may be returned, but throughput is computed from sent bytes.

Backpressure behavior:

- skips send loop on a socket when `bufferedAmount` exceeds threshold,
- threshold is derived from message size (`max(messageSizeKb * 8, 1024)` KB).

## Timing normalization

Estimation and throughput stages remove latency bias by subtracting:

`latencyMs + jitterMs`

from observed durations.

Important:

- adjusted duration is clamped to at least `1ms`,
- this prevents division-by-zero and runaway Mbps values on fast local loops.

## Throughput formula

Library speed calculation is:

`Mbps = bytes / (durationMs * 125)`

Rationale:

- `1 Mbps` equals `125,000 bytes/sec`,
- which is `125 bytes/ms`.

## Socket lifecycle expectations

All protocol runners follow this contract:

- establish socket(s),
- run stage-specific message exchange,
- clean up sockets/timers on success, error, or cancellation,
- settle promise exactly once.

This single-settle behavior is important for deterministic integration and testing.

## Cancellation and timeout contract

Every stage accepts a `CancellationToken`.

When cancelled:

- pending timers are cleared,
- sockets are closed,
- `CancellationError` is thrown or used to reject.

Stage-specific timeout defaults:

- latency: `10s` (configurable),
- estimation: `15s` (configurable),
- throughput: duration-driven (no extra timeout guard by default).

## Failure semantics and result mapping

The final `NetworkTestResultTestResults` payload includes:

- `testStatus` (`passed` or `failed`),
- `failedReason`,
- `failedStage`.

Mapping behavior:

- cancellation sets `failedReason` to `"Cancelled"`,
- non-cancellation errors map current engine stage to protocol stage family,
- errors are surfaced via `onError(error, stage)` callback.

## Upload behavior and queue fallback

On successful test completion:

- engine attempts immediate upload via `CoverageMapApiClient.uploadSpeedTestResults`.

If upload fails:

- result is stored in the internal local queue,
- `retryQueuedUploads()` attempts batch re-upload later,
- successful retry clears queued entries.

## Backend runtime considerations

For backend workers/services:

- protocol runners still require a `WebSocket` implementation on `globalThis`,
- browser-only metadata may be unavailable,
- result payload still includes `device.coreSystem` so host/runtime fields remain populated.

See also:

- [Library API](./library-api.md)
- [Testing Guide](./testing.md)
- [Result Schema](./result-schema.md)
