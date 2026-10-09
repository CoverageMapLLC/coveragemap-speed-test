import type { SpeedTestServer } from '../types/speed-server.js';
import { getServerWsUrl } from '../types/speed-server.js';
import type { SpeedTestTransport } from '../types/speed-test.js';

/**
 * Sockets for every test stage. The URL picks the transport: `ws://` and `wss://` use the
 * global `WebSocket`, `tcp://` and `tcps://` use the raw TCP socket from
 * `@coveragemap/speed-transport`, which has the same API and speaks the same protocol
 * without WebSocket masking. Raw TCP is Node.js only and needs {@link loadTcpTransport} first.
 */

/** `readyState` values, the same for both socket types. Avoids the global `WebSocket`, which Node.js 20 lacks. */
export const SOCKET_CONNECTING = 0;
export const SOCKET_OPEN = 1;
export const SOCKET_CLOSED = 3;

interface TcpSocketOptions {
  binaryPayloads: 'copy' | 'discard';
}

interface TcpTransportModule {
  SpeedTransportSocket: new (url: string, options?: TcpSocketOptions) => unknown;
  probeTcpTransport(host: string, port: number, options?: { secure?: boolean; timeoutMs?: number }): Promise<boolean>;
}

// Kept in a variable so browser bundlers never try to resolve the Node-only module.
const TCP_TRANSPORT_MODULE = '@coveragemap/speed-transport/client';
/** Covers TCP, TLS, and the preamble round trips on links with several hundred ms of latency. */
const TCP_PROBE_TIMEOUT_MS = 3000;

let tcpTransport: TcpTransportModule | null = null;

export function isTcpUrl(url: string): boolean {
  return url.startsWith('tcp://') || url.startsWith('tcps://');
}

/** True in Node.js. False in browsers, including test environments that emulate a DOM. */
export function isNodeRuntime(): boolean {
  return (
    typeof process !== 'undefined' &&
    typeof process.versions?.node === 'string' &&
    typeof (globalThis as { window?: unknown }).window === 'undefined'
  );
}

/** Loads the raw TCP transport. Resolves null outside Node.js or when it cannot be loaded. */
export async function loadTcpTransport(): Promise<TcpTransportModule | null> {
  if (tcpTransport) return tcpTransport;
  if (!isNodeRuntime()) return null;
  try {
    tcpTransport = (await import(/* webpackIgnore: true */ /* @vite-ignore */ TCP_TRANSPORT_MODULE)) as TcpTransportModule;
  } catch {
    return null;
  }
  return tcpTransport;
}

/**
 * Opens a test socket. Raw TCP sockets discard large binary payloads: tests only count their
 * bytes, so the client never copies download data.
 */
export function openSocket(url: string): WebSocket {
  if (isTcpUrl(url)) {
    if (!tcpTransport) throw new Error('The raw TCP transport is not loaded');
    return new tcpTransport.SpeedTransportSocket(url, { binaryPayloads: 'discard' }) as WebSocket;
  }
  return new WebSocket(url);
}

function getTcpEndpoint(server: SpeedTestServer): { secure: boolean; host: string; port: number } {
  const secure = server.id !== 'local';
  return { secure, host: server.domain, port: server.port ?? (secure ? 443 : 80) };
}

/** Raw TCP URL for a server: the same port as its WebSocket endpoint. */
export function getServerTcpUrl(server: SpeedTestServer): string {
  const { secure, host, port } = getTcpEndpoint(server);
  return `${secure ? 'tcps' : 'tcp'}://${host}:${port}`;
}

export interface ResolvedServerUrl {
  url: string;
  /** Value reported as the result's `testProtocol`. */
  protocol: 'WSS' | 'TCP';
}

/**
 * Chooses the URL every stage connects to. `auto` uses raw TCP in Node.js when the server
 * answers the raw TCP preamble and the WebSocket otherwise, so servers that predate it keep
 * working. CDN servers only speak WebSocket and are never probed. `tcp` requires raw TCP.
 */
export async function resolveServerUrl(
  server: SpeedTestServer,
  transport: SpeedTestTransport = 'auto'
): Promise<ResolvedServerUrl> {
  const webSocket: ResolvedServerUrl = { url: getServerWsUrl(server), protocol: 'WSS' };
  if (transport === 'websocket') return webSocket;
  if (transport === 'auto' && server.isCDN) return webSocket;

  const module = await loadTcpTransport();
  if (!module) {
    if (transport === 'tcp') throw new Error('The raw TCP transport needs Node.js');
    return webSocket;
  }

  const tcp: ResolvedServerUrl = { url: getServerTcpUrl(server), protocol: 'TCP' };
  if (transport === 'tcp') return tcp;

  const { secure, host, port } = getTcpEndpoint(server);
  const supported = await module.probeTcpTransport(host, port, {
    secure,
    timeoutMs: TCP_PROBE_TIMEOUT_MS,
  });
  return supported ? tcp : webSocket;
}
