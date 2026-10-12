import type { SpeedTestServer } from '../types/speed-server.js';
import type { SpeedTestTransport } from '../types/speed-test.js';

/**
 * Sockets for every test stage. The URL picks the transport: `ws://` and `wss://` use the
 * global `WebSocket`, `tcp://` uses the raw TCP socket from `@coveragemap/speed-transport`,
 * which has the same API and speaks the same protocol without WebSocket masking. Raw TCP is
 * Node.js only and needs {@link loadTcpTransport} first.
 */

/** `readyState` values, the same for both socket types. Avoids the global `WebSocket`, which Node.js 20 lacks. */
export const SOCKET_CONNECTING = 0;
export const SOCKET_OPEN = 1;
export const SOCKET_CLOSED = 3;

interface TcpSocketOptions {
  binaryPayloads: 'copy' | 'discard';
  connectTimeoutMs?: number;
}

interface TcpTransportModule {
  SpeedTransportSocket: new (url: string, options?: TcpSocketOptions) => unknown;
}

export interface OpenSocketOptions {
  /** Raw TCP only: fail if the connection is not open by then. Defaults to the transport's 10 s. */
  connectTimeoutMs?: number;
}

// Kept in a variable so browser bundlers never try to resolve the Node-only module.
const TCP_TRANSPORT_MODULE = '@coveragemap/speed-transport/client';

/**
 * Protocols assumed for servers that do not report any: they predate the field and speak
 * secure WebSocket, or plain WebSocket for local servers (`id === "local"`).
 */
export const DEFAULT_SERVER_PROTOCOLS: readonly string[] = ['WSSv1'];
export const DEFAULT_LOCAL_SERVER_PROTOCOLS: readonly string[] = ['WSv1'];

/**
 * How long the first connection of a run may take to open before the run moves on to the
 * next transport. Covers the TCP, TLS, and handshake round trips at several hundred ms of
 * latency.
 */
export const FIRST_CONNECTION_TIMEOUT_MS = 3000;

/** A socket failed before it opened: refused, unreachable, or not answered in time. */
export class SocketConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocketConnectError';
  }
}

let tcpTransport: TcpTransportModule | null = null;

export function isTcpUrl(url: string): boolean {
  return url.startsWith('tcp://');
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
export function openSocket(url: string, options: OpenSocketOptions = {}): WebSocket {
  if (isTcpUrl(url)) {
    if (!tcpTransport) throw new Error('The raw TCP transport is not loaded');
    return new tcpTransport.SpeedTransportSocket(url, {
      binaryPayloads: 'discard',
      ...(options.connectTimeoutMs ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
    }) as WebSocket;
  }
  return new WebSocket(url);
}

/** The transports a server reported, or the ones assumed for servers that predate the field. */
export function getServerProtocols(server: SpeedTestServer): readonly string[] {
  if (server.protocols && server.protocols.length > 0) return server.protocols;
  return server.id === 'local' ? DEFAULT_LOCAL_SERVER_PROTOCOLS : DEFAULT_SERVER_PROTOCOLS;
}

function defaultPort(server: SpeedTestServer, secure: boolean): number {
  return server.port ?? (secure ? 443 : 80);
}

/** Raw TCP URL for a server: the same port as its WebSocket endpoint. */
export function getServerTcpUrl(server: SpeedTestServer): string {
  return `tcp://${server.domain}:${defaultPort(server, false)}`;
}

/** WebSocket URL for a server, plain (`ws://`) or secure (`wss://`), on the same port. */
export function getServerWebSocketUrl(server: SpeedTestServer, secure: boolean): string {
  return `${secure ? 'wss' : 'ws'}://${server.domain}:${defaultPort(server, secure)}/v1/ws`;
}

/**
 * True where only secure WebSockets may be opened: browsers block `ws://` from HTTPS pages
 * (and treat other non-HTTP pages the same way). Node.js and runtimes without a page can
 * open plain WebSockets.
 */
export function requiresSecureWebSocket(): boolean {
  if (isNodeRuntime()) return false;
  const protocol = (globalThis as { location?: { protocol?: unknown } }).location?.protocol;
  return typeof protocol === 'string' && protocol !== 'http:';
}

export interface ResolvedServerUrl {
  url: string;
  /** Value reported as the result's `testProtocol`. */
  protocol: 'TCP' | 'WS' | 'WSS';
}

export interface ServerUrlSelection {
  /** The URL every stage connects to. */
  primary: ResolvedServerUrl;
  /** Where to switch the run, in order, if the first connection to `primary` cannot open. */
  fallbacks: ResolvedServerUrl[];
}

/**
 * Chooses the URLs a run may use from the protocols the server reports, fastest first. The
 * speed test carries no private data, so encryption is only used where it is required:
 * `auto` uses raw TCP (`TCPv1`, Node.js only), then plain WebSocket (`WSv1`, unless the page
 * only allows secure WebSockets), then secure WebSocket (`WSSv1`). The first entry is the
 * primary URL and the rest are fallbacks for a first connection that cannot open, for
 * example on a network that only passes HTTPS. `tcp`, `ws`, and `wss` force one transport.
 */
export async function selectServerUrl(
  server: SpeedTestServer,
  transport: SpeedTestTransport = 'auto'
): Promise<ServerUrlSelection> {
  const tcp: ResolvedServerUrl = { url: getServerTcpUrl(server), protocol: 'TCP' };
  const ws: ResolvedServerUrl = { url: getServerWebSocketUrl(server, false), protocol: 'WS' };
  const wss: ResolvedServerUrl = { url: getServerWebSocketUrl(server, true), protocol: 'WSS' };

  if (transport === 'tcp') {
    if (!(await loadTcpTransport())) throw new Error('The raw TCP transport needs Node.js');
    return { primary: tcp, fallbacks: [] };
  }
  if (transport === 'ws') {
    if (requiresSecureWebSocket()) throw new Error('This page only allows secure WebSockets (wss://)');
    return { primary: ws, fallbacks: [] };
  }
  if (transport === 'wss') return { primary: wss, fallbacks: [] };

  const protocols = getServerProtocols(server);
  const candidates: ResolvedServerUrl[] = [];
  if (protocols.includes('TCPv1') && (await loadTcpTransport())) candidates.push(tcp);
  if (protocols.includes('WSv1') && !requiresSecureWebSocket()) candidates.push(ws);
  if (protocols.includes('WSSv1')) candidates.push(wss);
  if (candidates.length === 0) {
    throw new Error(`The server offers no transport this runtime can use (${protocols.join(', ')})`);
  }
  return { primary: candidates[0], fallbacks: candidates.slice(1) };
}
