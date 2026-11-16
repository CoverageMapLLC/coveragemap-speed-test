/**
 * Counts download bytes as they arrive, not per whole message, on the Node.js sockets (raw TCP
 * and the library's WebSocket client). Counting whole messages left up to one message per
 * socket (1 to 5 MiB) uncounted at every snapshot and at the end of the stage. The native
 * libraries count bytes as they arrive, and so do these sockets. Browsers cannot: the WebSocket
 * API only delivers whole messages.
 *
 * Both sockets read frames with speed-transport's `FrameParser`, whose public
 * `onPayloadProgress` hook (speed-transport 0.3.0) reports a message's bytes once per read and
 * always before the message itself. The raw TCP socket exposes the same as `onpayloadprogress`.
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
