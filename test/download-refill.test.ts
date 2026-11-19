import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDownloadSpeedTest } from '../src/tests/download-speed-test.js';
import { openDownloadLane } from '../src/tests/throughput-lanes.js';
import { getNextDownloadMessageSizeKb } from '../src/utils/adaptive.js';
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

async function openLane(messageSizeKb: number, latencyMs = 0) {
  const lane = openDownloadLane(
    { serverUrl: 'wss://speed.example.com/v1/ws', connectionCount: 1, messageSizeKb, latencyMs },
    { onOpen: () => {}, onError: () => {} }
  );
  await vi.advanceTimersByTimeAsync(1);
  return { lane, socket: ManualSocketMock.instances[0] };
}

/** Delivers `count` messages of `kb`, one every `everyMs`, advancing the clock between them. */
async function deliverOverTime(socket: ManualSocketMock, kb: number, count: number, everyMs: number) {
  for (let i = 0; i < count; i++) {
    socket.deliver(kb);
    await vi.advanceTimersByTimeAsync(everyMs);
  }
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

  it('sizes the next batch from the speed: 10 ms of it, as a power of two; fourfold before there is one', () => {
    // No speed yet: four times the last size, up to 5 MiB
    expect(getNextDownloadMessageSizeKb(1, null)).toBe(4);
    expect(getNextDownloadMessageSizeKb(1024, null)).toBe(4096);
    expect(getNextDownloadMessageSizeKb(4096, null)).toBe(5120);
    // 10 ms at 100 Mbps is 122 KiB: 128
    expect(getNextDownloadMessageSizeKb(4096, 100)).toBe(128);
    // 10 ms at 1 Mbps is 1.2 KiB: 1
    expect(getNextDownloadMessageSizeKb(1024, 1)).toBe(1);
    // 10 ms at 10 Gbps is 12 MiB: the 5 MiB cap
    expect(getNextDownloadMessageSizeKb(1, 10_000)).toBe(5120);
  });

  it('asks for 200 messages, then 200 more once 100 are due when no speed is known yet', async () => {
    vi.stubGlobal('WebSocket', ManualSocketMock as unknown as typeof WebSocket);
    const { lane, socket } = await openLane(1024);

    lane.start();
    expect(socket.commands).toEqual(['START 1024 200']);
    // All at once: no time passes, so no speed
    socket.deliver(1024, 99);
    expect(socket.commands).toEqual(['START 1024 200']);
    socket.deliver(1024);
    expect(socket.commands).toEqual(['START 1024 200', 'START 4096 200']);
    expect(lane.bytes).toBe(100 * 1024 * KB);
    lane.close();
  });

  it('asks for the next batch 300 ms ahead at the measured message rate, sized for 10 ms', async () => {
    vi.stubGlobal('WebSocket', ManualSocketMock as unknown as typeof WebSocket);
    const { lane, socket } = await openLane(16);
    lane.start();
    // One 16 KiB message every 10 ms: 100 messages a second, 13 Mbps. 300 ms ahead is 30
    // messages, so the refill goes out once 30 are due; 10 ms at 13 Mbps is 16 KiB.
    await deliverOverTime(socket, 16, 169, 10);
    expect(socket.commands).toEqual(['START 16 200']);
    await deliverOverTime(socket, 16, 1, 10);
    expect(socket.commands).toEqual(['START 16 200', 'START 16 200']);
    lane.close();
  });

  it('asks two round trips ahead on a high latency link', async () => {
    vi.stubGlobal('WebSocket', ManualSocketMock as unknown as typeof WebSocket);
    // 400 ms latency: 800 ms ahead, 80 messages at 100 a second
    const { lane, socket } = await openLane(16, 400);
    lane.start();
    await deliverOverTime(socket, 16, 119, 10);
    expect(socket.commands).toEqual(['START 16 200']);
    await deliverOverTime(socket, 16, 1, 10);
    expect(socket.commands).toEqual(['START 16 200', 'START 16 200']);
    lane.close();
  });

  it('grows the messages on a fast link and shrinks them on a slow one', async () => {
    vi.stubGlobal('WebSocket', ManualSocketMock as unknown as typeof WebSocket);
    const fast = await openLane(128);
    fast.lane.start();
    // One 128 KiB message every millisecond: 1 Gbps, whose 10 ms is 1280 KiB: 1024. A thousand
    // a second wants 300 due, more than a batch, so the refill goes out once the rate is known.
    await deliverOverTime(fast.socket, 128, 60, 1);
    expect(fast.socket.commands).toEqual(['START 128 200', 'START 1024 200']);
    fast.lane.close();
    ManualSocketMock.instances = [];

    const slow = await openLane(64);
    slow.lane.start();
    // One 64 KiB message every 50 ms: 10.5 Mbps, whose 10 ms is 12.8 KiB: 16. Twenty a second,
    // so the refill goes out once 6 are due.
    await deliverOverTime(slow.socket, 64, 194, 50);
    expect(slow.socket.commands).toEqual(['START 64 200', 'START 16 200']);
    slow.lane.close();
  });

  it('never has more than two batches outstanding', async () => {
    vi.stubGlobal('WebSocket', ManualSocketMock as unknown as typeof WebSocket);
    const { lane, socket } = await openLane(1, 1000);
    lane.start();
    // 1000 messages a second with 1 s latency would want 2000 due: one batch at most, so the
    // refill goes out once 200 are due, and never two at once.
    for (let i = 0; i < 100; i++) {
      socket.deliver(1, 1);
      await vi.advanceTimersByTimeAsync(1);
    }
    const starts = socket.commands.filter((command) => command.startsWith('START'));
    expect(starts).toHaveLength(2);
    lane.close();
  });

  it('counts every message from a server that interleaves the batches', async () => {
    vi.stubGlobal('WebSocket', InterleavingServerSocketMock as unknown as typeof WebSocket);
    const { lane, socket } = await openLane(1);
    const server = socket as InterleavingServerSocketMock;
    lane.start();
    await vi.advanceTimersByTimeAsync(1000);

    // One 1 KiB message a millisecond (8 Mbps): the next batch, at 8 KiB, goes out once the
    // rate is known, while most of the first is still due.
    expect(server.commands.slice(0, 2)).toEqual(['START 1 200', 'START 8 200']);
    // Two loops ran at once: a 1 KB message arrived after the first 8 KB one.
    const firstLarger = server.received.indexOf(8);
    expect(firstLarger).toBeGreaterThan(0);
    expect(server.received.slice(firstLarger).includes(1)).toBe(true);
    // Everything the server sent was requested, so all of it counts.
    expect(lane.bytes).toBe(server.sentBytes);
    lane.close();
  });

  it('counts nothing beyond what was requested', async () => {
    vi.stubGlobal('WebSocket', ManualSocketMock as unknown as typeof WebSocket);
    const { lane, socket } = await openLane(64);
    lane.start();
    socket.deliver(64, 50);
    // The socket starts closing: the refill at 100 due cannot go out, so only 200 are due.
    socket.readyState = ManualSocketMock.CLOSING;
    socket.deliver(64, 300);
    expect(socket.commands).toEqual(['START 64 200']);
    expect(lane.bytes).toBe(200 * 64 * KB);
  });

  it('neither refills nor counts once the lane is closed', async () => {
    vi.stubGlobal('WebSocket', ManualSocketMock as unknown as typeof WebSocket);
    const { lane, socket } = await openLane(64);
    lane.start();
    socket.deliver(64, 99);
    lane.close();
    socket.readyState = ManualSocketMock.OPEN;
    socket.deliver(64, 10);
    expect(socket.commands).toEqual(['START 64 200', 'CLOSE']);
    expect(lane.bytes).toBe(99 * 64 * KB);
  });

  it('stops refilling but keeps the socket open and counting after stopRequests', async () => {
    vi.stubGlobal('WebSocket', ManualSocketMock as unknown as typeof WebSocket);
    const { lane, socket } = await openLane(64);
    lane.start();
    socket.deliver(64, 99);
    lane.stopRequests();
    // Past the refill threshold, yet no new request.
    socket.deliver(64, 10);
    expect(socket.commands).toEqual(['START 64 200']);
    expect(socket.readyState).toBe(ManualSocketMock.OPEN);
    expect(lane.bytes).toBe(109 * 64 * KB);
    lane.close();
    expect(socket.commands).toEqual(['START 64 200', 'CLOSE']);
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
