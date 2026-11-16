/**
 * Counts download bytes as they arrive, not per whole message, on the Node.js sockets (raw TCP
 * and the library's WebSocket client). Both read frames with speed-transport's `FrameParser`,
 * which skips the payload of large messages and reports each message only once it is complete.
 * Counting whole messages left up to one message per socket (1 to 5 MiB) uncounted at every
 * snapshot and at the end of the stage. The native libraries count bytes as they arrive, and so
 * do these sockets now. Browsers cannot: the WebSocket API only delivers whole messages.
 *
 * The work is per read, not per byte: after each chunk the parser consumed, the bytes of the
 * binary message still arriving are read from the parser's state.
 */

/** A socket that reports binary message payload bytes as they arrive. */
export interface PayloadProgressSocket {
  /**
   * Called with the number of binary message payload bytes that arrived since the last call.
   * A message's bytes are all reported before its `message` event, so a listener that counts
   * them must not count the message again.
   */
  onpayloadprogress: ((bytes: number) => void) | null;
}

/** True when `socket` reports payload bytes as they arrive (`onpayloadprogress`). */
export function supportsPayloadProgress<T extends object>(socket: T): socket is T & PayloadProgressSocket {
  return 'onpayloadprogress' in socket;
}

/** The parts of speed-transport's `FrameParser` (0.2) this reads. They are not public API. */
interface FrameParserState {
  push(chunk: unknown): void;
  readonly failed: boolean;
  readonly handler: {
    onMessage(data: { length: number }, binary: boolean): void;
    onBulkMessage(length: number, binary: boolean): void;
  };
  /** A data message has started and not finished. */
  readonly inMessage: boolean;
  readonly messageOpcode: number;
  /** Payload length of the current message's frames whose headers were read. */
  readonly messageLength: number;
  /** Payload bytes still due in the current frame. */
  readonly remaining: number;
  /** The current frame is a control frame (inside a fragmented message, the message's frames are complete). */
  readonly control: boolean;
}

const BINARY_OPCODE = 0x2;

function isFrameParser(parser: unknown): parser is FrameParserState {
  const p = parser as Partial<FrameParserState> | null;
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.push === 'function' &&
    typeof p.failed === 'boolean' &&
    typeof p.handler?.onMessage === 'function' &&
    typeof p.handler?.onBulkMessage === 'function' &&
    typeof p.inMessage === 'boolean' &&
    typeof p.messageOpcode === 'number' &&
    typeof p.messageLength === 'number' &&
    typeof p.remaining === 'number' &&
    typeof p.control === 'boolean'
  );
}

/**
 * Makes `parser` (a speed-transport `FrameParser`) call `report` with binary message payload
 * bytes as they arrive: after each chunk, the newly arrived bytes of the message in progress,
 * and before each binary message is delivered, whatever of it was not reported yet. Returns
 * false, changing nothing, when `parser` does not look like the `FrameParser` this was written
 * for; the socket then counts whole messages as before.
 */
export function trackBinaryPayload(parser: unknown, report: (bytes: number) => void): boolean {
  if (!isFrameParser(parser)) return false;
  const handler = parser.handler;
  const { onMessage, onBulkMessage } = handler;
  /** Bytes of the binary message in progress that were already reported. */
  let reported = 0;

  const finish = (length: number) => {
    const rest = length - reported;
    reported = 0;
    if (rest > 0) report(rest);
  };

  handler.onMessage = (data, binary) => {
    if (binary) finish(data.length);
    onMessage.call(handler, data, binary);
  };
  handler.onBulkMessage = (length, binary) => {
    if (binary) finish(length);
    onBulkMessage.call(handler, length, binary);
  };

  const push = parser.push;
  parser.push = (chunk: unknown) => {
    push.call(parser, chunk);
    if (parser.failed || !parser.inMessage || parser.messageOpcode !== BINARY_OPCODE) return;
    const received = parser.messageLength - (parser.control ? 0 : parser.remaining);
    if (received > reported) {
      report(received - reported);
      reported = received;
    }
  };
  return true;
}
