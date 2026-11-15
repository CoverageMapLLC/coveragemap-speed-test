import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDownloadSpeedTest } from '../src/tests/download-speed-test.js';
import { getNextDownloadMessageSizeKb, openDownloadLane } from '../src/tests/throughput-lanes.js';
import { CancellationToken } from '../src/utils/cancellation.js';

const KB = 1024;

/** One shared payload per size, so long runs do not allocate a buffer per message. */
const payloads = new Map<number, ArrayBuffer>();
const payload = (kb: number) => {
  let buffer = payloads.get(kb);
  if (!buffer) payloads.set(kb, (buffer = new ArrayBuffer(kb * KB)));
  return buffer;
};

/** A download socket the test feeds by hand. */
class ManualSocketMock {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: ManualSocketMock[] = [];

  readyState = ManualSocketMock.CONNECTING;
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  commands: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(_url: string) {
    ManualSocketMock.instances.push(this);
    setTimeout(() => {
      this.readyState = ManualSocketMock.OPEN;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  send(message: string | Uint8Array): void {
    if (typeof message === 'string') this.commands.push(message);
  }

  /** Delivers `count` messages of `kb` KB. */
  deliver(kb: number, count = 1): void {
    for (let i = 0; i < count; i++) this.onmessage?.({ data: payload(kb) } as MessageEvent);
  }

  close(): void {
    this.readyState = ManualSocketMock.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

/**
 * Behaves like the speed-transport server: every `START <kb> <count>` starts its own send loop
 * at once, one message per millisecond, so overlapping batches interleave their messages.
 */
class InterleavingServerSocketMock extends ManualSocketMock {
  static startedAt: number[] = [];
  /** Sizes of the messages in the order they were sent. */
  received: number[] = [];
  /** When each message was sent. */
  receivedAt: number[] = [];
  closedAt: number | null = null;
  sentBytes = 0;
  private loops: Array<ReturnType<typeof setInterval>> = [];

  send(message: string | Uint8Array): void {
    super.send(message);
    if (typeof message !== 'string' || !message.startsWith('START')) return;
    InterleavingServerSocketMock.startedAt.push(performance.now());
    const [, kb, count] = message.split(' ').map(Number);
    let left = count;
    const loop = setInterval(() => {
      if (this.readyState !== ManualSocketMock.OPEN || left === 0) {
        clearInterval(loop);
        return;
      }
      left--;
      this.received.push(kb);
      this.receivedAt.push(performance.now());
      this.sentBytes += kb * KB;
      this.deliver(kb);
    }, 1);
    this.loops.push(loop);
  }

  close(): void {
    this.closedAt ??= performance.now();
    for (const loop of this.loops) clearInterval(loop);
    super.close();
  }
}

async function openLane(messageSizeKb: number) {
  const lane = openDownloadLane(
    { serverUrl: 'wss://speed.example.com/v1/ws', connectionCount: 1, messageSizeKb },
    { onOpen: () => {}, onError: () => {} }
  );
  await vi.advanceTimersByTimeAsync(1);
  return { lane, socket: ManualSocketMock.instances[0] };
}

describe('download refills', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  });

  afterEach(() => {
    ManualSocketMock.instances = [];
    InterleavingServerSocketMock.startedAt = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('grows the message size threefold up to 5 MB', () => {
    const chain = (kb: number, steps: number) => {
      const sizes = [kb];
      for (let i = 0; i < steps; i++) sizes.push(getNextDownloadMessageSizeKb(sizes.at(-1)!));
      return sizes;
    };
    expect(chain(1, 4)).toEqual([1, 3, 9, 27, 81]);
    expect(chain(1024, 3)).toEqual([1024, 3072, 5120, 5120]);
  });

  it('asks for 500 messages, then 500 more at three times the size once 400 arrived', async () => {
    vi.stubGlobal('WebSocket', ManualSocketMock as unknown as typeof WebSocket);
    const { lane, socket } = await openLane(1024);

    lane.start();
    expect(socket.commands).toEqual(['START 1024 500']);
    socket.deliver(1024, 399);
    expect(socket.commands).toEqual(['START 1024 500']);
    socket.deliver(1024);
    expect(socket.commands).toEqual(['START 1024 500', 'START 3072 500']);
    expect(lane.bytes).toBe(400 * 1024 * KB);
    lane.close();
  });

  it('keeps a running total across interleaved batches of different sizes', async () => {
    vi.stubGlobal('WebSocket', ManualSocketMock as unknown as typeof WebSocket);
    const { lane, socket } = await openLane(1024);
    lane.start();
    socket.deliver(1024, 400);
    // 600 due: the last 100 of the first batch arrive mixed with the second batch's.
    for (let i = 0; i < 100; i++) {
      socket.deliver(1024);
      socket.deliver(3072);
    }
    expect(lane.bytes).toBe(500 * 1024 * KB + 100 * 3072 * KB);
    expect(socket.commands).toHaveLength(2);

    // 400 due: the next refill goes out when the total is back down to 100.
    socket.deliver(3072, 299);
    expect(socket.commands).toHaveLength(2);
    socket.deliver(3072);
    expect(socket.commands).toEqual(['START 1024 500', 'START 3072 500', 'START 5120 500']);
    expect(lane.bytes).toBe(500 * 1024 * KB + 400 * 3072 * KB);
    lane.close();
  });

  it('repeats the refill on its own every 500 messages', async () => {
    vi.stubGlobal('WebSocket', ManualSocketMock as unknown as typeof WebSocket);
    const { lane, socket } = await openLane(1);
    lane.start();
    socket.deliver(1, 400);
    socket.deliver(3, 499);
    expect(socket.commands).toEqual(['START 1 500', 'START 3 500']);
    socket.deliver(3);
    socket.deliver(9, 500);
    expect(socket.commands).toEqual(['START 1 500', 'START 3 500', 'START 9 500', 'START 27 500']);
    lane.close();
  });

  it('counts every message from a server that interleaves the batches', async () => {
    vi.stubGlobal('WebSocket', InterleavingServerSocketMock as unknown as typeof WebSocket);
    const { lane, socket } = await openLane(1);
    const server = socket as InterleavingServerSocketMock;
    lane.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(server.commands.slice(0, 3)).toEqual(['START 1 500', 'START 3 500', 'START 9 500']);
    // Two loops ran at once: a 1 KB message arrived after the first 3 KB one.
    const firstLarger = server.received.indexOf(3);
    expect(firstLarger).toBeGreaterThanOrEqual(400);
    expect(server.received.slice(firstLarger).includes(1)).toBe(true);
    // Everything the server sent was requested, so all of it counts.
    expect(lane.bytes).toBe(server.sentBytes);
    lane.close();
  });

  it('counts nothing beyond what was requested', async () => {
    vi.stubGlobal('WebSocket', ManualSocketMock as unknown as typeof WebSocket);
    const { lane, socket } = await openLane(64);
    lane.start();
    socket.deliver(64, 300);
    // The socket starts closing: the refill at 400 cannot go out, so only 500 are due.
    socket.readyState = ManualSocketMock.CLOSING;
    socket.deliver(64, 300);
    expect(socket.commands).toEqual(['START 64 500']);
    expect(lane.bytes).toBe(500 * 64 * KB);
  });

  it('neither refills nor counts once the lane is closed', async () => {
    vi.stubGlobal('WebSocket', ManualSocketMock as unknown as typeof WebSocket);
    const { lane, socket } = await openLane(64);
    lane.start();
    socket.deliver(64, 399);
    lane.close();
    socket.readyState = ManualSocketMock.OPEN;
    socket.deliver(64, 10);
    expect(socket.commands).toEqual(['START 64 500', 'CLOSE']);
    expect(lane.bytes).toBe(399 * 64 * KB);
  });

  it('stops refilling but keeps the socket open and counting after stopRequests', async () => {
    vi.stubGlobal('WebSocket', ManualSocketMock as unknown as typeof WebSocket);
    const { lane, socket } = await openLane(64);
    lane.start();
    socket.deliver(64, 399);
    lane.stopRequests();
    // Past the refill threshold, yet no new request.
    socket.deliver(64, 10);
    expect(socket.commands).toEqual(['START 64 500']);
    expect(socket.readyState).toBe(ManualSocketMock.OPEN);
    expect(lane.bytes).toBe(409 * 64 * KB);
    lane.close();
    expect(socket.commands).toEqual(['START 64 500', 'CLOSE']);
  });

  it('keeps the link loaded until the last loaded latency answer, with no refill after the stage', async () => {
    // The loaded latency socket never answers, so the stage waits 100 ms for its last PONG.
    vi.stubGlobal('WebSocket', InterleavingServerSocketMock as unknown as typeof WebSocket);
    const startedAt = performance.now();
    const promise = runDownloadSpeedTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      messageSizeKb: 1,
      connectionCount: 1,
      durationMs: 1500,
      latencyMs: 0,
      jitterMs: 0,
      cancellationToken: new CancellationToken(),
    });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    const sockets = ManualSocketMock.instances as InterleavingServerSocketMock[];
    const download = sockets.find((socket) => socket.commands.some((c) => c.startsWith('START')))!;
    const latency = sockets.find((socket) => socket.commands.includes('PING'))!;
    expect(latency.commands.filter((c) => c === 'PING').length).toBeGreaterThan(0);
    // The download socket closed after the 100 ms wait, not when the stage ended...
    expect(download.closedAt! - startedAt).toBeGreaterThanOrEqual(1599);
    // ...and kept receiving until then, so the last ping measured a loaded link.
    expect(download.receivedAt.some((at) => at - startedAt > 1550)).toBe(true);
    // The result is the stage's: nothing after its end is counted.
    expect(result.durationMs).toBeLessThan(1501);
    const byStageEnd = download.received
      .filter((_, i) => download.receivedAt[i] - startedAt <= 1500)
      .reduce((sum, kb) => sum + kb * KB, 0);
    expect(result.bytes).toBeLessThanOrEqual(byStageEnd);
    expect(download.sentBytes).toBeGreaterThan(result.bytes);
  });

  it('sends no refill after the stage ends', async () => {
    // The loaded latency socket never answers, so the stage waits 100 ms for a last PONG after
    // it ends; the interleaving server keeps going until the lane closes.
    vi.stubGlobal('WebSocket', InterleavingServerSocketMock as unknown as typeof WebSocket);
    const startedAt = performance.now();
    const promise = runDownloadSpeedTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      messageSizeKb: 1,
      connectionCount: 1,
      durationMs: 1500,
      latencyMs: 0,
      jitterMs: 0,
      cancellationToken: new CancellationToken(),
    });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    const starts = InterleavingServerSocketMock.startedAt.map((at) => at - startedAt);
    expect(starts.length).toBeGreaterThan(2);
    expect(Math.max(...starts)).toBeLessThanOrEqual(1500);
    expect(result.bytes).toBeGreaterThan(0);
  });
});
