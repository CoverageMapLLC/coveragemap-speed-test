# Self-Hosted Servers

CoverageMap publishes an open source, self-hosted speed test server, [`@coveragemap/speed-test-server`](https://github.com/CoverageMapLLC/coveragemap-speed-test-server), that implements the same protocol as the CoverageMap network. This library can run a full test against one. This page covers how clients discover such a server, how to validate it, and what happens to the results.

---

## Table of Contents

- [Overview](#overview)
- [Manual entry flow](#manual-entry-flow)
- [The server object](#the-server-object)
- [Validating a server](#validating-a-server)
- [Running the test](#running-the-test)
- [Results and mapping](#results-and-mapping)
- [CoverageMap clients](#coveragemap-clients)
- [Node.js considerations](#nodejs-considerations)

---

## Overview

Self-hosted servers are not part of the CoverageMap network. They never appear in `getServers()` and the speed API does not know about them. Instead, the user enters the server's host and port in the client, the client fetches the server's own `GET /v1/server` route, and the returned object is passed to `engine.run(server)`.

No engine changes are required. `getServerWsUrl` already uses `wss://` for any server whose `id` is not `local`, and the server object flows into `results.server` untouched.

## Manual entry flow

Every client, web and mobile alike, follows the same steps:

1. The user enters the host and port (default 443).
2. The client requests `https://<host>:<port>/v1/server`.
3. The client checks that `selfHosted` is `true` and that `protocolVersion` is supported (currently `1`).
4. The client calls `engine.run(server)` with the returned object.
5. The library runs the test and uploads the result as usual.

## The server object

`GET /v1/server` returns the library's `SpeedTestServer` shape plus three fields:

```json
{
  "id": "6f1c2c4e-0a4b-4d0f-9a5e-3c2b1d0e9f8a",
  "domain": "speedtest.example.com",
  "port": 443,
  "provider": "Example Operator",
  "city": "Philadelphia",
  "region": "PA",
  "country": "US",
  "latitude": 39.9526,
  "longitude": -75.1652,
  "location": "Philadelphia, PA",
  "distance": null,
  "isCDN": false,
  "selfHosted": true,
  "version": "0.1.0",
  "protocolVersion": 1
}
```

| Field | Meaning |
|---|---|
| `selfHosted` | Always `true`. Declared as an optional boolean on `SpeedTestServer`. Absent for network servers. |
| `version` | The server package version. Informational. |
| `protocolVersion` | The speed test protocol version the server implements. Compare it with the versions your client supports. |

`distance` is always `null` because the server does not know where the client is. `isCDN` is always `false`.

## Validating a server

```ts
import type { SpeedTestServer } from '@coveragemap/speed-test';

interface SelfHostedServer extends SpeedTestServer {
  selfHosted: true;
  version: string;
  protocolVersion: number;
}

const SUPPORTED_PROTOCOL_VERSIONS = [1];

export async function fetchSelfHostedServer(host: string, port = 443): Promise<SelfHostedServer> {
  const origin = port === 443 ? `https://${host}` : `https://${host}:${port}`;
  const response = await fetch(`${origin}/v1/server`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    throw new Error(`Server responded with ${response.status}`);
  }

  const server = (await response.json()) as Partial<SelfHostedServer>;
  if (server.selfHosted !== true) {
    throw new Error('This is not a self-hosted CoverageMap speed test server');
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(server.protocolVersion ?? 0)) {
    throw new Error(`Unsupported protocol version ${server.protocolVersion}`);
  }
  if (typeof server.id !== 'string' || typeof server.domain !== 'string' || typeof server.port !== 'number') {
    throw new Error('Malformed server object');
  }
  return server as SelfHostedServer;
}
```

The route allows any origin, so browsers can call it directly. Use the object exactly as returned; `domain` and `port` in it are what the library uses to build the WebSocket URL.

## Running the test

```ts
import { SpeedTestEngine } from '@coveragemap/speed-test';

const server = await fetchSelfHostedServer('speedtest.example.com', 443);

const engine = new SpeedTestEngine({
  application: {
    id: 'your-static-application-uuid',
    name: 'My App',
    version: '1.0.0',
    organization: 'My Org',
    type: 'web',
  },
});

const result = await engine.run(server);
console.log(result.results.server?.selfHosted); // true
```

Passing the server object skips discovery. The engine still requests `/v1/connection` from the speed API for the client's IP and location, which is unrelated to the target server. Show `server.provider` and `server.location` in the UI as you would for a network server, and hide the distance since it is always `null`.

## Results and mapping

Results from self-hosted servers upload to CoverageMap like any other test. The CoverageMap API reads `results.server.selfHosted`, stores the flag, and skips map and square processing when it is `true`. The result appears in the user's history but never on the public map, because a test against a private server says nothing about the CoverageMap network's reach.

## CoverageMap clients

- **Web:** the server picker has a "Use a self-hosted server" option that asks for host and port and remembers recent entries.
- **Mobile:** the server selection screen has the same option, saved with the device settings.

Both perform the validation above and label the results as self-hosted.

## Node.js considerations

Nothing changes for backend usage. Node 22 and later have a native `WebSocket`; on Node 20 and 21 assign the `ws` package to `globalThis.WebSocket` before creating the engine, as described in [Backend Integration](./backend-integration.md). The self-hosted server must present a certificate the Node process trusts. It never offers plaintext WebSockets.
