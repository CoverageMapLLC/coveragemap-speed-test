import type { SpeedTestServer } from '../types/speed-server.js';
import type { SpeedTestTransport } from '../types/speed-test.js';
import { SpeedTestError } from '../utils/failure.js';

/**
 * Sockets for every test stage. The URL picks the transport: `ws://` and `wss://` use the
 * global `WebSocket`, or in Node.js the library's own WebSocket client once
 * {@link loadNodeWebSocket} has loaded it; `tcp://` uses the raw TCP socket from
 * `@coveragemap/speed-transport`, which has the same API and speaks the same protocol without
 * WebSocket masking. Raw TCP is Node.js only and needs {@link loadTcpTransport} first.
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

interface NodeWebSocketModule {
  NodeWebSocket: new (url: string, options?: { connectTimeoutMs?: number }) => unknown;
}

/** A socket that can send zero-filled binary messages without building them. */
interface ZeroFilledSender {
  sendZeroFilled(byteLength: number): void;
}

export interface OpenSocketOptions {
  /** Raw TCP and the Node.js WebSocket client: fail if the connection is not open by then (10 s by default). */
  connectTimeoutMs?: number;
  /**
   * `ws://` and `wss://` in Node.js: use the library's WebSocket client once it is loaded
   * (`true`, the default) or always `globalThis.WebSocket` (`false`). See
   * `SpeedTestConfig.nodeWebSocket`.
   */
  nodeWebSocket?: boolean;
}

// Kept in variables so browser bundlers never try to resolve the Node-only modules.
const TCP_TRANSPORT_MODULE = '@coveragemap/speed-transport/client';
const NODE_WEBSOCKET_MODULE = './node-websocket.js';

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

/**
 * A socket failed before it opened: refused or unreachable (`connectionFailed`), or not
 * answered in time (`connectionTimeout`).
 */
export class SocketConnectError extends SpeedTestError {
  constructor(message: string, reason: 'connectionFailed' | 'connectionTimeout' = 'connectionFailed') {
    super(reason, message);
    this.name = 'SocketConnectError';
  }
}

let tcpTransport: TcpTransportModule | null = null;
let nodeWebSocket: NodeWebSocketModule | null = null;

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
 * Loads the library's WebSocket client for Node.js (`node-websocket.ts`), which `openSocket`
 * then uses for `ws://` and `wss://` instead of the global `WebSocket`. Node's built-in
 * `WebSocket` masks every upload byte and copies every download byte in JavaScript, which
 * holds a thread to a few Gbps. Resolves null outside Node.js (Bun and Deno keep their native
 * `WebSocket`) or when it cannot be loaded, and the global `WebSocket` is used as before.
 */
export async function loadNodeWebSocket(): Promise<NodeWebSocketModule | null> {
  if (nodeWebSocket) return nodeWebSocket;
  if (!isNodeRuntime() || 'bun' in process.versions || 'Deno' in globalThis) return null;
  try {
    nodeWebSocket = (await import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_WEBSOCKET_MODULE)) as NodeWebSocketModule;
  } catch {
    return null;
  }
  return nodeWebSocket;
}

/**
 * True when `openSocket` opens `url` with the library's own Node.js WebSocket client: a
 * WebSocket URL, the client is loaded, and `enabled` (the `nodeWebSocket` option) is not false.
 */
export function usesNodeWebSocket(url: string, enabled = true): boolean {
  return enabled && !isTcpUrl(url) && nodeWebSocket !== null && isNodeRuntime();
}

/**
 * Opens a test socket. Raw TCP sockets, and WebSockets from the Node.js client, discard large
 * binary payloads: tests only count their bytes, so the client never copies download data.
 */
export function openSocket(url: string, options: OpenSocketOptions = {}): WebSocket {
  const connectTimeout = options.connectTimeoutMs ? { connectTimeoutMs: options.connectTimeoutMs } : {};
  if (isTcpUrl(url)) {
    if (!tcpTransport) throw new SpeedTestError('unreachable', 'The raw TCP transport is not loaded');
    return new tcpTransport.SpeedTransportSocket(url, { binaryPayloads: 'discard', ...connectTimeout }) as WebSocket;
  }
  if (usesNodeWebSocket(url, options.nodeWebSocket !== false)) {
    return new nodeWebSocket!.NodeWebSocket(url, connectTimeout) as WebSocket;
  }
  return new WebSocket(url);
}

/**
 * Sends `chunk`, which must be all zeros, as a binary message. Sockets that can send zeros
 * without masking or copying them (the Node.js WebSocket client) do; others get `chunk`.
 */
export function sendZeroFilled(socket: WebSocket, chunk: Uint8Array): void {
  const sender = socket as WebSocket & Partial<ZeroFilledSender>;
  if (typeof sender.sendZeroFilled === 'function') sender.sendZeroFilled(chunk.byteLength);
  else socket.send(chunk);
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
 * Unless `options.nodeWebSocket` is false, it also loads the Node.js WebSocket client, which
 * the run's WebSockets then use.
 */
export async function selectServerUrl(
  server: SpeedTestServer,
  transport: SpeedTestTransport = 'auto',
  options: { nodeWebSocket?: boolean } = {}
): Promise<ServerUrlSelection> {
  if (options.nodeWebSocket !== false) await loadNodeWebSocket();
  const tcp: ResolvedServerUrl = { url: getServerTcpUrl(server), protocol: 'TCP' };
  const ws: ResolvedServerUrl = { url: getServerWebSocketUrl(server, false), protocol: 'WS' };
  const wss: ResolvedServerUrl = { url: getServerWebSocketUrl(server, true), protocol: 'WSS' };

  if (transport === 'tcp') {
    if (!(await loadTcpTransport())) throw new SpeedTestError('unreachable', 'The raw TCP transport needs Node.js');
    return { primary: tcp, fallbacks: [] };
  }
  if (transport === 'ws') {
    if (requiresSecureWebSocket()) {
      throw new SpeedTestError('unreachable', 'This page only allows secure WebSockets (wss://)');
    }
    return { primary: ws, fallbacks: [] };
  }
  if (transport === 'wss') return { primary: wss, fallbacks: [] };

  const protocols = getServerProtocols(server);
  const candidates: ResolvedServerUrl[] = [];
  if (protocols.includes('TCPv1') && (await loadTcpTransport())) candidates.push(tcp);
  if (protocols.includes('WSv1') && !requiresSecureWebSocket()) candidates.push(ws);
  if (protocols.includes('WSSv1')) candidates.push(wss);
  if (candidates.length === 0) {
    throw new SpeedTestError(
      'unreachable',
      `The server offers no transport this runtime can use (${protocols.join(', ')})`
    );
  }
  return { primary: candidates[0], fallbacks: candidates.slice(1) };
}
