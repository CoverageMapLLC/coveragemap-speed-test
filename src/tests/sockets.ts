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

/** Protocols assumed for servers that do not report any: they predate the field. */
export const DEFAULT_SERVER_PROTOCOLS: readonly string[] = ['WSSv1'];

/**
 * How long the first raw TCP connection of a run may take before the run switches to
 * WebSocket. Covers TCP, TLS, and the preamble round trips at several hundred ms of latency.
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

/** Raw TCP URL for a server: the same port as its WebSocket endpoint. */
export function getServerTcpUrl(server: SpeedTestServer): string {
  const secure = server.id !== 'local';
  const port = server.port ?? (secure ? 443 : 80);
  return `${secure ? 'tcps' : 'tcp'}://${server.domain}:${port}`;
}

export interface ResolvedServerUrl {
  url: string;
  /** Value reported as the result's `testProtocol`. */
  protocol: 'WSS' | 'TCP';
}

export interface ServerUrlSelection {
  /** The URL every stage connects to. */
  primary: ResolvedServerUrl;
  /** Where to switch the run if the first connection to `primary` fails, or null. */
  fallback: ResolvedServerUrl | null;
}

/** True when the server lists raw TCP: `TCPSv1`, or `TCPv1` for local servers without TLS. */
export function serverSupportsRawTcp(server: SpeedTestServer): boolean {
  const protocols = server.protocols ?? DEFAULT_SERVER_PROTOCOLS;
  return protocols.includes(server.id === 'local' ? 'TCPv1' : 'TCPSv1');
}

/**
 * Chooses the URL every stage connects to from the protocols the server reports. `auto` uses
 * raw TCP in Node.js when the server lists it, with WebSocket as the fallback if the first
 * connection fails (a network that only passes HTTP, for example), and WebSocket otherwise.
 * Servers that report no protocols only speak WebSocket. `websocket` and `tcp` force one
 * transport; `tcp` fails outside Node.js.
 */
export async function selectServerUrl(
  server: SpeedTestServer,
  transport: SpeedTestTransport = 'auto'
): Promise<ServerUrlSelection> {
  const webSocket: ResolvedServerUrl = { url: getServerWsUrl(server), protocol: 'WSS' };
  const tcp: ResolvedServerUrl = { url: getServerTcpUrl(server), protocol: 'TCP' };
  if (transport === 'websocket') return { primary: webSocket, fallback: null };
  if (transport === 'tcp') {
    if (!(await loadTcpTransport())) throw new Error('The raw TCP transport needs Node.js');
    return { primary: tcp, fallback: null };
  }
  if (!serverSupportsRawTcp(server) || !(await loadTcpTransport())) {
    return { primary: webSocket, fallback: null };
  }
  return { primary: tcp, fallback: webSocket };
}
