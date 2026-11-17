/**
 * WebSocket client for Node.js (`ws://` and `wss://`), loaded by `loadNodeWebSocket` in
 * `sockets.ts` and never bundled for browsers. It has the browser `WebSocket` API the test
 * stages use and is built for throughput, where Node's built-in `WebSocket` spends most of a
 * thread on per-byte work the test throws away:
 *
 * - **Downloads are counted, not copied.** Messages above `bulkThresholdBytes` are skipped by
 *   the frame parser and delivered as a zero-filled `ArrayBuffer` of their length, so download
 *   data is never copied out of the TLS layer or assembled into messages.
 * - **Uploads are not masked per byte.** `sendZeroFilled` sends frames from one premasked
 *   buffer per size. A client must mask every frame, and the built-in client XORs each upload
 *   byte in JavaScript, which took half of the upload thread. Masking zeros with a key just
 *   repeats the key, so the masked frame is built once and sent again and again.
 * - **Reads go into one buffer per socket** (`onread`), with no allocation or stream
 *   machinery per read.
 * - **Download bytes are reported as they arrive** (`onpayloadprogress`): for each read,
 *   once per message it carries bytes of, so a snapshot or the end of a stage also counts the
 *   message still arriving.
 *
 * The masking key of the premasked frames is random but reused for every frame of that size.
 * RFC 6455 asks for a fresh key per frame so that page scripts cannot choose the bytes that
 * reach intermediaries; here the payload is always zeros chosen by the library, so a reused key
 * reveals and enables nothing. Every other frame gets a fresh key.
 */
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import {
  CloseCode,
  FrameParser,
  Opcode,
  computeAcceptKey,
  encodeClosePayload,
  encodeFrameHeader,
  encodeMaskedFrame,
} from '@coveragemap/speed-transport';

export interface NodeWebSocketOptions {
  /** Fail if the connection and handshake have not completed by then. Defaults to 10 s. */
  connectTimeoutMs?: number;
  /**
   * Binary messages larger than this are counted, not read: they arrive as a zero-filled
   * `ArrayBuffer` of their length. Defaults to 64 KiB.
   */
  bulkThresholdBytes?: number;
  /**
   * `wss://` only: the certificate authorities to trust, as `tls.connect`'s `ca` (replaces the
   * default set). For private servers and tests; the engine never sets it.
   */
  ca?: string | Buffer | Array<string | Buffer>;
}

/** Close event with the fields of the WebSocket `CloseEvent`, which Node.js 20 lacks. */
export class NodeWebSocketCloseEvent extends Event {
  constructor(
    readonly code: number,
    readonly reason: string,
    readonly wasClean: boolean
  ) {
    super('close');
  }
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_BULK_THRESHOLD = 64 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_HANDSHAKE_RESPONSE_BYTES = 16 * 1024;
const CLOSE_TIMEOUT_MS = 1_000;
/** Bytes each socket reads at a time. */
const READ_BUFFER_BYTES = 256 * 1024;
/** Frame sizes whose premasked frames are kept; uploads use one or two. */
const MAX_CACHED_ZERO_FRAMES = 8;
const MAX_CACHED_BULK_BUFFERS = 8;

const premaskedZeroFrames = new Map<number, Buffer>();

/**
 * A complete masked binary frame carrying `length` zero bytes. Zeros masked with a key are the
 * key repeated, so the payload is filled with the key once and the frame reused.
 */
export function getPremaskedZeroFrame(length: number): Buffer {
  let frame = premaskedZeroFrames.get(length);
  if (frame) return frame;
  const header = encodeFrameHeader(Opcode.Binary, length);
  header[1] |= 0x80;
  const key = randomBytes(4);
  frame = Buffer.allocUnsafe(header.length + 4 + length);
  header.copy(frame, 0);
  key.copy(frame, header.length);
  if (length > 0) frame.fill(key, header.length + 4);
  if (premaskedZeroFrames.size < MAX_CACHED_ZERO_FRAMES) premaskedZeroFrames.set(length, frame);
  return frame;
}

function toBuffer(data: string | ArrayBufferLike | ArrayBufferView | Blob): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer)) {
    return Buffer.from(data);
  }
  throw new TypeError('Unsupported WebSocket message type');
}

interface ParsedUrl {
  secure: boolean;
  host: string;
  port: number;
  hostHeader: string;
  path: string;
}

/** Parses `ws://` and `wss://` URLs. */
export function parseWebSocketUrl(url: string): ParsedUrl {
  const parsed = new URL(url);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new SyntaxError(`Unsupported URL scheme ${parsed.protocol} (expected ws: or wss:)`);
  }
  const secure = parsed.protocol === 'wss:';
  const port = parsed.port ? Number(parsed.port) : secure ? 443 : 80;
  return {
    secure,
    host: parsed.hostname.replace(/^\[(.*)\]$/, '$1'),
    port,
    hostHeader: parsed.host,
    path: `${parsed.pathname || '/'}${parsed.search}`,
  };
}

/**
 * WebSocket client with the browser `WebSocket` API, for the speed test stages in Node.js.
 * See the module comment for what it does differently.
 *
 * Errors follow Node's built-in `WebSocket`: a connection that ends without a close frame from
 * the server (a failed connect or handshake, a reset, a server that drops the socket, a
 * protocol error) fires `error` once, then `close` with code 1006. A clean close fires only
 * `close`. The stages rely on this: latency fails fast and download estimation reconnects on
 * `error`.
 */
export class NodeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readonly protocol = '';
  readonly extensions = '';
  binaryType: 'arraybuffer' | 'blob' | 'nodebuffer' = 'arraybuffer';
  readyState: number = NodeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: NodeWebSocketCloseEvent) => void) | null = null;
  /** Binary message payload bytes as they arrive (see `PayloadProgressSocket`). */
  onpayloadprogress: ((bytes: number) => void) | null = null;

  private readonly socket: net.Socket;
  private readonly parser: FrameParser;
  private readonly key = randomBytes(16).toString('base64');
  private readonly bulkBuffers = new Map<number, ArrayBuffer>();
  /** Response bytes until the handshake completes; null afterwards. */
  private handshake: Buffer | null = Buffer.alloc(0);
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private closeSent = false;
  private closeReceived = false;
  private errorDispatched = false;
  private closeCode: number = CloseCode.Abnormal;
  private closeReason = '';

  constructor(url: string, options: NodeWebSocketOptions = {}) {
    super();
    this.url = url;
    const target = parseWebSocketUrl(url);
    const bulkThreshold = options.bulkThresholdBytes ?? DEFAULT_BULK_THRESHOLD;

    this.parser = new FrameParser(
      { requireMask: false, maxMessageBytes: MAX_MESSAGE_BYTES, maxBufferedMessageBytes: bulkThreshold },
      {
        onMessage: (data, binary) => this.deliver(binary ? this.toBinary(data) : data.toString('utf8')),
        onBulkMessage: (length, binary) => this.deliver(binary ? this.bulkPayload(length) : ''),
        onPing: (payload) => {
          if (this.readyState === NodeWebSocket.OPEN) this.writeControl(Opcode.Pong, payload);
        },
        onPong: () => {},
        onClose: (code, reason) => this.onPeerClose(code, reason),
        onError: (code, reason) => this.failConnection(code, reason),
        // speed-transport reports the bytes of each read per message, before that message itself.
        onPayloadProgress: (bytes, binary) => {
          if (binary && this.readyState === NodeWebSocket.OPEN) this.onpayloadprogress?.(bytes);
        },
      }
    );

    const readBuffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    const onread = {
      buffer: readBuffer,
      callback: (bytes: number) => {
        this.onData(readBuffer.subarray(0, bytes));
        return true;
      },
    };
    const onConnect = () => {
      this.socket.setNoDelay(true);
      this.socket.write(
        `GET ${target.path} HTTP/1.1\r\n` +
          `Host: ${target.hostHeader}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${this.key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    };
    this.socket = target.secure
      ? tls.connect(
          {
            host: target.host,
            port: target.port,
            servername: net.isIP(target.host) ? undefined : target.host,
            ALPNProtocols: ['http/1.1'],
            ...(options.ca ? { ca: options.ca } : {}),
            onread,
          } as tls.ConnectionOptions,
          onConnect
        )
      : net.connect({ host: target.host, port: target.port, onread }, onConnect);

    this.connectTimer = setTimeout(
      () => this.abort('Connection timed out'),
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    );
    this.connectTimer.unref?.();
    // Runtimes that ignore `onread` emit data events instead.
    this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    this.socket.on('error', () => {
      // While closing, abort() and destroy() can emit errors of their own; the close reports
      // an unclean end once the socket is gone.
      if (this.readyState === NodeWebSocket.CLOSING || this.readyState === NodeWebSocket.CLOSED) return;
      // CLOSING first: an error handler that calls close() must not fail the connection again.
      this.readyState = NodeWebSocket.CLOSING;
      this.dispatchError();
    });
    this.socket.on('end', () => this.socket.end());
    this.socket.once('close', () => this.onSocketClose());
  }

  /** Bytes queued in the socket and not yet handed to the kernel. */
  get bufferedAmount(): number {
    return this.socket.writableLength;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    if (this.readyState === NodeWebSocket.CONNECTING) {
      throw new DOMException('Still in CONNECTING state', 'InvalidStateError');
    }
    if (this.readyState !== NodeWebSocket.OPEN) return;
    const opcode = typeof data === 'string' ? Opcode.Text : Opcode.Binary;
    this.socket.write(encodeMaskedFrame(opcode, toBuffer(data), randomBytes(4)));
  }

  /** Sends a binary message of `byteLength` zero bytes, as `send(new Uint8Array(byteLength))` would. */
  sendZeroFilled(byteLength: number): void {
    if (this.readyState === NodeWebSocket.CONNECTING) {
      throw new DOMException('Still in CONNECTING state', 'InvalidStateError');
    }
    if (this.readyState !== NodeWebSocket.OPEN) return;
    this.socket.write(getPremaskedZeroFrame(byteLength));
  }

  close(code: number = CloseCode.Normal, reason = ''): void {
    if (this.readyState === NodeWebSocket.CLOSING || this.readyState === NodeWebSocket.CLOSED) return;
    if (this.readyState === NodeWebSocket.CONNECTING) {
      this.abort('Closed before the connection was established');
      return;
    }
    this.readyState = NodeWebSocket.CLOSING;
    this.sendClose(code, reason);
    this.armCloseTimer();
  }

  private onData(chunk: Buffer): void {
    if (this.handshake) {
      this.onHandshakeData(chunk);
      return;
    }
    if (this.readyState === NodeWebSocket.CLOSED) return;
    this.parser.push(chunk);
  }

  private onHandshakeData(chunk: Buffer): void {
    // Copied: `chunk` is the socket's read buffer, overwritten by the next read.
    const response = Buffer.concat([this.handshake!, chunk]);
    const end = response.indexOf('\r\n\r\n');
    if (end < 0) {
      if (response.length > MAX_HANDSHAKE_RESPONSE_BYTES) this.abort('Handshake response too large');
      else this.handshake = response;
      return;
    }
    const lines = response.subarray(0, end).toString('latin1').split('\r\n');
    if (!/^HTTP\/1\.[01] 101\b/.test(lines[0])) {
      this.abort(`Unexpected handshake response: ${lines[0]}`);
      return;
    }
    const accept = lines
      .slice(1)
      .find((line) => line.toLowerCase().startsWith('sec-websocket-accept:'))
      ?.slice('sec-websocket-accept:'.length)
      .trim();
    if (accept !== computeAcceptKey(this.key)) {
      this.abort('Invalid Sec-WebSocket-Accept');
      return;
    }

    this.handshake = null;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.readyState = NodeWebSocket.OPEN;
    this.dispatch(new Event('open'));
    const rest = response.subarray(end + 4);
    if (rest.length > 0 && this.readyState !== NodeWebSocket.CLOSED) this.parser.push(rest);
  }

  private toBinary(data: Buffer): ArrayBuffer | Buffer | Blob {
    if (this.binaryType === 'nodebuffer') return Buffer.from(data);
    if (this.binaryType === 'blob') return new Blob([new Uint8Array(data)]);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }

  private bulkPayload(length: number): ArrayBuffer | Buffer | Blob {
    let buffer = this.bulkBuffers.get(length);
    if (!buffer) {
      buffer = new ArrayBuffer(length);
      if (this.bulkBuffers.size < MAX_CACHED_BULK_BUFFERS) this.bulkBuffers.set(length, buffer);
    }
    if (this.binaryType === 'nodebuffer') return Buffer.from(buffer);
    if (this.binaryType === 'blob') return new Blob([buffer]);
    return buffer;
  }

  private deliver(data: unknown): void {
    if (this.readyState !== NodeWebSocket.OPEN) return;
    this.dispatch(new MessageEvent('message', { data }));
  }

  private dispatch(event: Event): void {
    this.dispatchEvent(event);
    const handler = (this as unknown as Record<string, ((event: Event) => void) | null>)[`on${event.type}`];
    handler?.call(this, event);
  }

  private writeControl(opcode: number, payload: Buffer): void {
    this.socket.write(encodeMaskedFrame(opcode, payload, randomBytes(4)));
  }

  private sendClose(code: number, reason: string): void {
    if (this.closeSent) return;
    this.closeSent = true;
    this.writeControl(Opcode.Close, encodeClosePayload(code, reason));
  }

  private armCloseTimer(): void {
    if (this.closeTimer) return;
    this.closeTimer = setTimeout(() => this.socket.destroy(), CLOSE_TIMEOUT_MS);
    this.closeTimer.unref?.();
  }

  private onPeerClose(code: number | null, reason: string): void {
    this.closeReceived = true;
    this.closeCode = code ?? CloseCode.NoStatus;
    this.closeReason = reason;
    this.readyState = NodeWebSocket.CLOSING;
    this.sendClose(code ?? CloseCode.Normal, '');
    this.socket.end();
    this.armCloseTimer();
  }

  private failConnection(code: number, reason: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = NodeWebSocket.CLOSING;
    this.sendClose(code, reason);
    this.dispatchError();
    this.socket.end();
    this.armCloseTimer();
  }

  private abort(reason: string): void {
    if (this.readyState === NodeWebSocket.CLOSED) return;
    const wasConnecting = this.readyState === NodeWebSocket.CONNECTING;
    this.closeReason = reason;
    // CLOSING before the error event: a handler that calls close() would otherwise abort again.
    this.readyState = NodeWebSocket.CLOSING;
    this.socket.destroy();
    if (wasConnecting) this.dispatchError();
  }

  /** Fires `error`, at most once per socket. */
  private dispatchError(): void {
    if (this.errorDispatched) return;
    this.errorDispatched = true;
    this.dispatch(new Event('error'));
  }

  private onSocketClose(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.connectTimer = null;
    this.closeTimer = null;
    this.readyState = NodeWebSocket.CLOSED;
    // No close frame from the server: the connection failed or was dropped (code 1006).
    if (!this.closeReceived) this.dispatchError();
    const code = this.closeReceived ? this.closeCode : CloseCode.Abnormal;
    this.dispatch(new NodeWebSocketCloseEvent(code, this.closeReason, this.closeReceived && this.closeSent));
  }
}
