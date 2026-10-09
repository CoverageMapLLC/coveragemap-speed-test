import { afterEach, describe, expect, it, vi } from 'vitest';
import { getUploadBufferTargetBytes, openUploadLane } from '../src/tests/throughput-lanes.js';

/** Upload socket whose `bufferedAmount` grows by every send until `drain()` is called. */
class UploadSocketMock {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: UploadSocketMock[] = [];
  /** When false, `bufferedAmount` stays 0 like implementations that do not report it. */
  static tracksBufferedAmount = true;

  readyState = UploadSocketMock.CONNECTING;
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  sent: Uint8Array[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(_url: string) {
    UploadSocketMock.instances.push(this);
    setTimeout(() => {
      this.readyState = UploadSocketMock.OPEN;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  send(payload: Uint8Array): void {
    this.sent.push(payload);
    if (UploadSocketMock.tracksBufferedAmount) this.bufferedAmount += payload.byteLength;
  }

  /** Flushes the send buffer and acknowledges `count` chunks. */
  drainAndAck(count: number): void {
    this.bufferedAmount = 0;
    for (let i = 0; i < count; i++) this.onmessage?.({ data: 'ACK' } as MessageEvent);
  }

  close(): void {
    this.readyState = UploadSocketMock.CLOSED;
  }
}

async function openLane(messageSizeKb: number, connectionCount = 1) {
  const lane = openUploadLane(
    { serverUrl: 'wss://speed.example.com/v1/ws', connectionCount, messageSizeKb },
    { onOpen: () => {}, onError: () => {} }
  );
  await vi.advanceTimersByTimeAsync(1);
  return lane;
}

describe('upload lane', () => {
  afterEach(() => {
    UploadSocketMock.instances = [];
    UploadSocketMock.tracksBufferedAmount = true;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('queues two chunks per socket, at least 16 KB', () => {
    expect(getUploadBufferTargetBytes(1024 * 1024)).toBe(2 * 1024 * 1024);
    expect(getUploadBufferTargetBytes(128 * 1024)).toBe(256 * 1024);
    expect(getUploadBufferTargetBytes(1024)).toBe(16 * 1024);
  });

  it('fills every socket up to the target and reuses one chunk', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', UploadSocketMock as unknown as typeof WebSocket);
    const lane = await openLane(1024, 2);

    lane.start();
    for (const socket of UploadSocketMock.instances) {
      expect(socket.sent).toHaveLength(2);
      expect(socket.bufferedAmount).toBe(2 * 1024 * 1024);
    }
    const chunks = new Set(UploadSocketMock.instances.flatMap((socket) => socket.sent));
    expect(chunks.size).toBe(1);
    lane.close();
  });

  it('splits large messages into 1 MB chunks', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', UploadSocketMock as unknown as typeof WebSocket);
    const lane = await openLane(4096);
    lane.start();
    expect(UploadSocketMock.instances[0].sent[0].byteLength).toBe(1024 * 1024);
    lane.close();
  });

  it('counts acknowledged chunks and refills after acknowledgements', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', UploadSocketMock as unknown as typeof WebSocket);
    const lane = await openLane(64);
    lane.start();
    const socket = UploadSocketMock.instances[0];
    const initial = socket.sent.length;

    socket.drainAndAck(2);
    expect(lane.bytes).toBe(2 * 64 * 1024);
    await Promise.resolve();
    expect(socket.sent.length).toBeGreaterThan(initial);
    lane.close();
  });

  it('ignores acknowledgements it has no chunk for', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', UploadSocketMock as unknown as typeof WebSocket);
    const lane = await openLane(64);
    const socket = UploadSocketMock.instances[0];
    socket.drainAndAck(3);
    expect(lane.bytes).toBe(0);
    lane.close();
  });

  it('caps unacknowledged chunks when the socket never reports bufferedAmount', async () => {
    vi.useFakeTimers();
    UploadSocketMock.tracksBufferedAmount = false;
    vi.stubGlobal('WebSocket', UploadSocketMock as unknown as typeof WebSocket);
    const lane = await openLane(1024);
    lane.start();
    await vi.advanceTimersByTimeAsync(500);

    expect(UploadSocketMock.instances[0].sent).toHaveLength(64);
    lane.close();
  });

  it('stops sending once closed', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', UploadSocketMock as unknown as typeof WebSocket);
    const lane = await openLane(64);
    lane.start();
    const socket = UploadSocketMock.instances[0];
    lane.close();
    const sent = socket.sent.length;
    socket.readyState = UploadSocketMock.OPEN;
    socket.drainAndAck(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(socket.sent).toHaveLength(sent);
  });
});
