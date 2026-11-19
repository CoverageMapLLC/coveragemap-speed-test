# Changelog

## 0.7.0

Results now follow the standard result format shared by every CoverageMap client (the Android and iOS libraries, the CoverageMap app, and the Core API). Every new field is nullable and `version` stays `1`, so payloads from earlier versions stay valid.

### Improvements

- **Throughput stages adapt to the link**: Measured from a Mac on a 940 Mbps link against a Node.js server, with the server's traffic shaped, old library against new (results not uploaded):

  | Condition | Download, old → new | Upload, old → new |
  |---|---|---|
  | Clean, 17 ms | 938–942 → 937–941 Mbps | 932–947 → 925–932 Mbps |
  | 1% loss, +40 ms | 796–940 → 922–933 Mbps | 17–30 → 21–31 Mbps |
  | 300 ms round trip | 273–319 → 555–600 Mbps | 174–417 → 510–529 Mbps (raw TCP) |
  | 10 Mbps | 9.6 → 9.5–9.6 Mbps | 6.8–7.3 → 9.4–9.6 Mbps |
  | 1 Mbps | 0.9–1 → 0.9–1 Mbps | 0.4–0.6 → 0.8–0.9 Mbps |
  | 20 Mbps / 5 Mbps policer with a burst | 18.2–19.1 → 19.0–19.1 Mbps | 0, 4.7, or failed → 4.6 Mbps |

  On loopback (12 connections, CPU-bound on two cores) download and raw TCP upload stayed within run-to-run variation (about 24 and 15.6 Gbps); secure WebSocket upload measured 6.5 to 6.9 Gbps against 6.8 to 7.3.
  - **Estimation** grows its rounds threefold (10, 30, 90 … 5120 KB), goes on past a round that stalled on a lost packet instead of settling on it, never settles on a slow first round alone, settles 2 s after its first round at the latest, and estimates the fastest of its last three rounds. Stopping on the first slow round had made a 940 Mbps link with 1% loss estimate 1 to 90 Mbps.
  - **Scale-up**: at 1, 2, and 3 s into a download or upload stage, a stage whose speed over the last 500 ms calls for more connections (the estimate's table, with a 25% margin) opens them, up to 12, and measures again once they carry data. A bad estimate no longer leaves a fast link on 2 to 4 connections.
  - **Message sizes follow each connection's speed**: about 10 ms of it, as a power of two (1 KB to 5 MB down, 1 KB to 1 MB up). Too large a message on a slow link arrived in one lump: the upload gauge jumped with every acknowledged chunk, and on a 1 Mbps link 67% to 88% of the 100 ms snapshots counted nothing (now 20% to 41%, where the test's own shaping clumps packets). A connection's first messages are sized for 2.5 ms of its share of the estimate, so an estimate that read high corrects itself at once. Download batches are 200 messages, asked for two round trips (at least 300 ms) ahead.
  - **Upload data in flight follows the link**: 64 chunks, or 8 round trips of what the connection acknowledged, whichever is more, at most 64 MiB, and each `ACK` credits the oldest chunk. With 128 KB chunks on a 10 Mbps link, and the chunks still queued when the stage ended, upload had measured 25% low.
- **Steady live speed at the measurement start**: `onDownloadProgress` and `onUploadProgress` no longer switch at once from the whole-stage speed to the measured speed 250 ms after the first bytes. The live speed now moves from one to the other over the next second. Right after the switch the measured window was only milliseconds long and held no message or `ACK`, or a whole one, so a gauge jumped there and then read about 0 or spiked for a moment. The snapshots in `SpeedTestData.snapshots` and the result, and every final speed, are unchanged. During that second a progress snapshot's `speedMbps` can differ from the stored snapshot at the same time. This matches the CoverageMap Android and iOS speed test libraries.
- **Download bytes count as they arrive in Node.js**: Raw TCP sockets and the library's Node.js WebSocket client report each frame's bytes as they are read, so progress snapshots and the stage total also count the frames still arriving (1 to 5 MiB per socket), as the native libraries do, and the ramp-up exclusion starts from the first bytes to arrive. Before, only whole frames counted. The work is per socket read, not per byte: on loopback with 12 sockets on 6 threads, throughput and CPU per byte stayed within run-to-run variation (raw TCP about 22 Gbps, WebSocket about 33 to 35 Gbps). Browsers, and `config.nodeWebSocket: false`, still count whole frames: the WebSocket API only delivers whole messages. The bytes come from speed-transport's public payload progress hook (`@coveragemap/speed-transport` 0.3.0 and later).

### New Features

- **`initialDownloadConnectionCount` and `initialUploadConnectionCount`** in `testType`: the connections each throughput stage started with, from its estimate. `downloadConnectionCount` / `uploadConnectionCount` and the established counts include the connections the scale-up added, and the requested counts the ones it asked for. `SpeedTestData` has `initialConnectionCount`, `requestedConnectionCount`, and `connectionCount`.
- **The adaptive rules are exported**: `DOWNLOAD_MESSAGE_SIZES_KB`, `UPLOAD_CHUNK_SIZES_KB`, `MESSAGE_TARGET_MS`, `DOWNLOAD_BATCH_MESSAGES`, `ESTIMATION_TIME_CAP_MS`, `getDownloadMessageSizeForSpeedKb`, `getUploadChunkSizeForSpeedKb`, `getFirstDownloadMessageSizeKb`, `nextEstimationStep`, and `estimationReference`.

- **`estimatedDownloadSpeed` and `estimatedUploadSpeed`** in `results.measurements`: the Mbps measured by each estimation stage, rounded to 3 decimals, `null` when estimation did not complete.
- **`requestedDownloadConnectionCount`, `establishedDownloadConnectionCount`, `requestedUploadConnectionCount`, `establishedUploadConnectionCount`** in `testType`: the connections each throughput stage asked for (its tier, and the ones its scale-up added) and the ones that opened. A stage only starts once every one of its first connections is open; an added connection that never opens is dropped, so established can be lower than requested. Established is `null` for a stage that did not complete.
- **`latencyEnd` stage marker** after the latency stage, and the failing phase now records its end marker too (`latencyEnd`, `downloadEnd`, or `uploadEnd`), not only `failedStage`. A cancelled run records none.
- **`SpeedTestError`, `getFailureReason`, `formatFailedReason`, and the `SpeedTestFailureReason` type** are exported. Errors the stages raise, and pass to `onError`, carry a `reason`.

### Breaking Changes

- **`getDownloadMessageSizeKb` and `getUploadMessageSizeKb`** return the first message size for an estimate spread over the stage's connections (2.5 ms of each connection's share), and take the connection count as an optional second argument. They returned a size from a fixed speed table.
- **`downloadPacketSize` / `uploadPacketSize`** are the first message and chunk sizes; each connection then sizes its messages from its speed.
- **Download batches are `START <kb> 200`** (were 500). Servers accept any count up to 1000, so nothing changes for them.

- **Defaults: 15 pings and 7 s stages**: `pingCount` is 15 (was 10) and `downloadDurationMs` / `uploadDurationMs` are 7000 (were 10000), the same as the CoverageMap app and native libraries. Pass the old values in `config` to keep them.
- **`failedReason` is `"<reason>: <message>"`** (or `"Cancelled"`), where `<reason>` is one of `unreachable`, `connectionFailed`, `connectionTimeout`, `transferTimeout`, `timeout`, `protocolError`, `unknown`, the native engine's failure reasons. It was the bare error message.
- **`downloadConnectionCount` / `uploadConnectionCount`** are now the established count, `null` when the throughput stage did not complete (they were set once estimation finished).
- **With the latency stage disabled, `latency`, `jitter`, and `latenciesList` are `null`**, and `onComplete` receives `null` latency data. The single ping that still runs to normalize the later stages' timing now runs inside the first download or upload phase, after its start marker, and is no longer reported as the result's latency.

### Bug Fixes

- **`@coveragemap/speed-transport` 0.3.1 is the minimum version**. 0.3.1 bounds the zero-filled buffers its server keeps per message size at 32 MiB; before, a client asking for every size could make a server worker hold about 50 GiB. The library's own client code is unchanged by it.

- **A throughput stage that moves no data fails**: A download or upload stage that counted no bytes passed with 0 Mbps. It now fails with `transferTimeout` (`"transferTimeout: No download data in 7000 ms"`), like the native engines: after 10 s with no data, or at the end of a shorter stage. The loaded latency socket of a stage that fails is now closed too.

- **Upload after download on slow links against the CDN, in browsers**: The CDN server cannot reset a connection on `CLOSE`, so Cloudflare kept delivering the download frames it had queued, and a browser could only close those sockets gracefully. On a 1 Mbps link the upload stage then measured about 60% of the link (three runs: 40 to 73%), while an upload on its own measured 91%. The engine now runs the upload phase in a new stage worker and terminates the one that ran the download, which drops its sockets at once. The upload after a download now measures the same as on its own (0.90 to 0.92 Mbps, against 0.91 to 0.93). Against the Node.js servers, which reset the connection, nothing changes.

- With the latency stage disabled, a failed latency normalization ping on an engine that had already run a test was reported with `failedStage: null` and `testStatus: "passed"`. It now fails the phase it runs in.

## 0.6.0

### Improvements

- **10 Gbps over secure WebSocket in Node.js**: `ws://` and `wss://` sockets in Node.js now come from the library's own WebSocket client instead of `globalThis.WebSocket`. Node's built-in client masked every upload byte and copied every download byte in JavaScript, which took half of the upload thread. The new client counts download messages without copying them and sends upload chunks from one premasked zero frame per size (see the protocol docs). Multi-gigabit stages also use up to one worker thread per CPU core instead of half the cores, so two core machines now use two threads instead of one. On a two core VM against the Cloudflare CDN server, a full run went from about 7 Gbps down and 3.3 Gbps up to 14.5 to 17.7 Gbps down and 16 Gbps up, loaded latency from 20 to 90 ms to 2 to 3 ms, and peak memory from 270 to 195 MB. No `ws` polyfill is needed on Node.js 20 any more; one that is installed is only used if the library's client cannot load, or with the new `config.nodeWebSocket: false`. Bun and Deno keep their native `WebSocket`.
- **Ramp-up left out of throughput speeds**: Download and upload speeds are now measured from 250 ms after the stage's first bytes are counted (the first `ACK` for upload) to the stage's end, so the slow start of the connections no longer lowers the result. Everything after that point counts, so a ramp-up that lasts longer still lowers the speed. The stage still lasts its full duration from when the sockets opened. Progress snapshots use the same rule, so the final speed continues the last progress values. A stage that ends before that point measures the whole stage as before. The 250 ms is fixed, not a configuration option. This matches the CoverageMap Android and iOS speed test libraries.
- **Loaded latency measures a loaded link**: The loaded latency socket still connects when the stage starts, but sends its first `PING` 1 s after the stage's first bytes, instead of while the link is still idle. The delay is fixed and independent of the ramp-up exclusion. Pings now go 500 ms after each `PONG` (was 1000 ms). Transfer sockets stay open until the last ping is answered, so that ping still measures a loaded link. A stage that ends before the delay reports no loaded latency (`null`).
- **Download refills overlap**: Each download socket now asks for its next 500 messages when 100 of the current request are still due, instead of after the last one arrived, so the server never runs out of data to send between batches. The server sends overlapping batches side by side; the client keeps a running count of the messages still due, so interleaved messages of different sizes all count. Each refill asks for three times the previous message size (was twice), still at most 5 MB. Servers built on `@coveragemap/speed-transport` 0.2.0 accept a `START` while a batch is still sending.

### New Features

- **`config.nodeWebSocket`**: `true` (default) uses the library's own WebSocket client in Node.js; `false` uses `globalThis.WebSocket` for every socket of the run, for applications that rely on their own implementation (an HTTP proxy, extra headers, custom TLS options). Ignored outside Node.js.

### Breaking Changes

- **Result uploads can't be turned off**: Completed results are always uploaded, even from subclasses or when `onComplete` throws. `api.coverageMapApiBaseUrl` must now be an `https://` URL on `coveragemap.com` or a subdomain (or loopback for a fully local setup).
- `SpeedTestData.speedMbps`, and with it `downloadSpeed`, `uploadSpeed`, `downloadList`, and `uploadList` in the result, now leave out the ramp-up and read higher on most links.

### Bug Fixes

- The Node.js WebSocket client reports dropped connections as errors so latency fails fast and download estimation can reconnect, instead of waiting out the stage timeout.

## 0.5.0

### Improvements

- **Multi-gigabit throughput in Node.js**: Download and upload stages estimated at 1 Gbps or more open 12 sockets (was 10) and, with Node's built-in WebSocket, spread them over 6 worker threads that report bytes through a `SharedArrayBuffer`. Against `@coveragemap/speed-test-server` on loopback this measures 11 Gbps each way over TLS and 15/13 Gbps without TLS (was 4.4/3.4 and 6.3/4.1). Applications that install a WebSocket polyfill keep every socket on the calling thread. No message changed; the only addition is the `CLOSE` command below, which servers that do not know it ignore.
- **Continuous upload**: Each upload socket keeps two chunks queued and refills after acknowledgements instead of sending one message every 5 ms, reusing one preallocated chunk. Unacknowledged chunks are capped per socket and refills are time boxed so progress stays real time on busy clients.
- **Tests in browsers run in a Web Worker**: Every stage's sockets and timing run in a dedicated worker started from a `blob:` URL embedded in the library, so the page's own work no longer slows the measurement or inflates latency. Applications need no changes or bundler setup. Where a worker cannot start (for example a Content Security Policy without `worker-src blob:`), or the page installed its own `WebSocket`, the test runs on the main thread as before. Set `config.browserWorker: false` to opt out.
- **Estimation ignores a blocked thread**: Download and upload estimation settle on their first slow round. A round that ran while the thread was blocked, for example by a page rendering its results between stages, is now repeated (up to 3 times) instead of being used. Previously such a block could make a gigabit link estimate below 1 Mbps and run the next stage on one socket of 1 KB messages.
- **Slow links**: Download sockets send `CLOSE` when the stage ends, so leftover download frames no longer starve the upload stage. On 100 kbps to 1 Mbps links upload went from 0 to 7 kbps (or a timeout) to 95 to 99% of the link.

### Bug Fixes

- A throughput stage now fails when one of its sockets cannot connect. Previously the stage waited forever.

### New Features

- **`protocols` on `SpeedTestServer`**: The transports a server accepts, with the speed test protocol version on each (`TCPv1`, `WSv1`, `WSSv1`), as reported by the CoverageMap server list and by self-hosted servers. Servers that report none are treated as `["WSSv1"]`.
- **Fastest transport first**: With the new `config.transport` (`auto` by default), the engine uses the fastest transport the server lists in its new `protocols` field: raw TCP (`tcp://`, Node.js only), then WebSocket (`ws://`), then secure WebSocket (`wss://`), which browsers need on HTTPS pages. Speed test traffic carries no private data, so it is only encrypted where it must be. Servers built on `@coveragemap/speed-transport` offer all three on the same port. If the first connection cannot open within 3 seconds, the run moves on to the next transport. Over raw TCP the protocol and stages are unchanged; the frames are unmasked and download payloads are never copied. `testType.testProtocol` reports `TCP`, `WS`, or `WSS`. Set `transport` to `tcp`, `ws`, or `wss` to use one transport.
- **`config.browserWorker`**: `true` (default) runs the test in a Web Worker in browsers; `false` keeps it on the page's main thread.
- **`config.throughputThreads`**: Threads for multi-gigabit stages. `0` (default) picks automatically, `1` disables worker threads.
- **`selfHosted` on `SpeedTestServer`**: New optional boolean, set to `true` by self-hosted `@coveragemap/speed-test-server` instances in their `GET /v1/server` response. Pass that object to `engine.run(server)` to test against a self-hosted server. The flag travels through `results.server` untouched so CoverageMap can store the result without mapping it. No engine changes were needed: `wss://` is already used for every server whose `id` is not `local`.

## 0.4.0

### New Features

- **Loaded latency monitoring** — Download and upload speed tests now run a concurrent PING/PONG WebSocket connection throughout each stage. The measured RTTs (latency under load) are exposed as `SpeedTestData.loadedLatency` (`LatencyTestData | null`) on the download and upload results, enabling bufferbloat / under-load latency analysis.
- **`loadedDownloadLatencies` and `loadedUploadLatencies` in result schema** — The `NetworkTestResultMeasurements` object now includes individual RTT sample arrays (`number[] | null`) collected by the loaded latency monitor during each throughput stage.

### Breaking Changes

- **`onComplete` callback signature changed** — The callback now receives structured stage result objects instead of raw numbers: `(latencyData: LatencyTestData | null, downloadData: SpeedTestData | null, uploadData: SpeedTestData | null, result: NetworkTestResultTestResults)`. Update any existing `onComplete` handlers accordingly.

### Bug Fixes

- **Jitter now reports median jitter** — The `jitterMs` field in test results was previously reporting `minJitter`; it now correctly reports `medianJitter`.
- Fixed bug where download speed would drop near the end of the test if the download buffer ended

### Improvements

- **Upload performance** — Burst interval reduced from 10 ms to 5 ms and buffer size multiplier increased from ×8 to ×32, keeping the send pipeline full at higher link speeds.
- **Measurement precision** — Numeric measurements (speed, latency, jitter) are now rounded to 3 decimal places before being submitted.

## 0.3.1

### Bug Fixes

- **Prevent stale latency and jitter in live UI updates** — When a test completes, latency and jitter values from the latency test stage are now preserved rather than being overwritten by the final result snapshot. This eliminates a race condition where a later, less accurate value could replace the already-settled measurement visible in the UI.

### Demo & Developer Experience

- Extracted the `LiveMeasurements` type, `EMPTY_MEASUREMENTS` constant, and new `mergeCompletedMeasurements` helper into a dedicated `live-measurements.ts` module in the React Vite demo for better separation of concerns and reusability.

### Tests

- Added `test/live-measurements.test.ts` to cover both cases of `mergeCompletedMeasurements`: when the latency test is enabled (preserves latency-stage values) and when it is disabled (falls back to completed result values).
- Added a regression test in `test/engine-regression.test.ts` verifying that the engine uses the latency-stage result as the source of truth for final latency and jitter values.

## 0.3.0

### New Features

- **`getDevice()` on `SpeedTestEngine`** — Returns a `NetworkTestResultDevice` snapshot of the current device metadata without running a full test. Useful for previewing what device context will be attached to test results.
- **`getLocation()` on `SpeedTestEngine`** — Async method that resolves and returns the current `NetworkTestResultLocation` (or `null`) independently of a test run, using the configured location provider.
- **`getNetwork()` on `SpeedTestEngine`** — Async method that resolves and returns the current `ResolvedSpeedTestNetwork` independently of a test run, using the configured network provider.
- **Device formatting utilities** — New `src/utils/device-format.ts` module with exported helpers: `formatDeviceOS`, `formatDeviceType`, `formatBrowserName`, `formatBrowserDisplay`, `formatOSDisplay`, and `formatDisplayName`. These are now part of the public API via `src/utils/index.ts`.

### Improvements

- **Normalized device display names** — `DefaultDeviceMetadataProvider` now uses the new formatting helpers to produce consistent, human-readable values for OS name, browser name, browser engine, device type, and device vendor across all runtimes (browser and Node.js).

### Bug Fixes

- **Fix inaccurate upload speed snapshots** — Replaced the sliding acknowledgement-window calculation with a simpler total-acknowledged-bytes-over-elapsed-duration approach, removing the moving window state (`ackEvents`, `ackBytesInWindow`, `MIN_SNAPSHOT_WINDOW_MS`). This produces more stable and accurate real-time upload speed readings.

### Demo & Developer Experience

- Enhanced the React Vite demo with a new "Device & Location" panel that displays resolved device and location metadata using the new `getDevice()` and `getLocation()` methods.
- Added Vite and TypeScript path aliases in the demo to resolve `@coveragemap/speed-test` directly from the local source, eliminating the need to publish before testing locally.

## 0.2.2

### Bug Fixes & Refinements

- **Rename `ethernet` → `wired` connection type** — The connection type value `"ethernet"` has been renamed to `"wired"` across the codebase, documentation, and tests for consistent terminology. Existing usages of `"ethernet"` should be updated to `"wired"`.
- **Refactor `DeviceMetadataProvider` interface** — Removed the `reset` method from the `DeviceMetadataProvider` interface. To restore the built-in default provider, pass `null` to `setDeviceMetadataProvider` instead. Updated documentation and examples to reflect this change.

## 0.2.1

### Bug Fixes

- **Fix upload results submitted on cancellation** — `SpeedTestEngine` no longer calls `uploadResults` when a test run is cancelled mid-flight. A `wasCancelled` guard was added so partial results are not sent to the backend.
- **Fix inaccurate upload speed snapshots** — Upload throughput is now measured from server-acknowledged bytes (WebSocket ACK events) rather than raw bytes dispatched to the send buffer. Snapshots use a sliding acknowledgement window (`snapshotIntervalMs × 3`, minimum 300 ms) so real-time readings reflect actual throughput rather than buffered-but-unconfirmed data.

### New Features

- **`testsRun` result field** — `NetworkTestResult` now contains a `testsRun` object (`{ latency: boolean; download: boolean; upload: boolean }`) that records which test phases were enabled for the run.
- **`ispName` result field** — `NetworkTestResult.results` and per-stage objects now expose `ispName: string | null`, populated from connection info returned by the network provider.
- **`setDeviceMetadataProvider` on `SpeedTestEngine`** — Callers can now inject a custom `DeviceMetadataProvider` directly on the engine instance, consistent with `setNetworkProvider` and `setLocationProvider`. Pass `null` to restore the built-in `DefaultDeviceMetadataProvider`.

### CI / Internal

- Updated GitHub Actions publish workflow to Node.js 24 and `actions/setup-node@v6`.
- Added `production` environment to the npm publish job and enabled verbose logging with provenance.

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
