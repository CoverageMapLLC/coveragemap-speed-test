import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDownloadSpeedTest } from '../src/tests/download-speed-test.js';
import { SCALE_UP_CHECKS_MS, type ThroughputTestOptions } from '../src/tests/throughput-runner.js';
import { runUploadSpeedTest } from '../src/tests/upload-speed-test.js';
import type { SpeedSnapshot } from '../src/types/speed-test.js';
import { CancellationToken } from '../src/utils/cancellation.js';

const TICK_MS = 5;

/**
 * Each connection carries at most `perConnectionMbps(msIntoStage)`, as on a path with loss,
 * where TCP limits every connection and only more connections carry more. The loaded latency
 * socket answers PING after 5 ms. Sockets created once `failAfterStart` is set never open.
 */
const link = {
  perConnectionMbps: (_ms: number) => 70,
  failAdded: 0,
  startedAt: null as number | null,
  /** Upload ACKs arrive this long after their chunk went through the link. */
  roundTripMs: 0,
  /** Sockets created during the stage take this long to open (a retransmitted handshake). */
  addedOpenMs: 0,
};

const payloads = new Map<number, ArrayBuffer>();
const payload = (bytes: number) => {
  let buffer = payloads.get(bytes);
  if (!buffer) payloads.set(bytes, (buffer = new ArrayBuffer(bytes)));
  return buffer;
};

class CappedLinkSocketMock {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: CappedLinkSocketMock[] = [];

  readyState = CappedLinkSocketMock.CONNECTING;
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  starts: string[] = [];
  /** The socket was sent a START or upload data. */
  carried = false;
  createdAt = performance.now();
  /** Messages due (download), sizes of chunks unacknowledged (upload). */
  private due: number[] = [];
  private unacked: number[] = [];
  private budget = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(_url: string) {
    CappedLinkSocketMock.instances.push(this);
    if (link.startedAt !== null && link.failAdded > 0) {
      link.failAdded--;
      setTimeout(() => {
        this.readyState = CappedLinkSocketMock.CLOSED;
        this.onerror?.(new Event('error'));
        this.onclose?.(new CloseEvent('close'));
      }, 20);
      return;
    }
    setTimeout(() => {
      this.readyState = CappedLinkSocketMock.OPEN;
      this.onopen?.(new Event('open'));
    }, link.startedAt !== null && link.addedOpenMs > 0 ? link.addedOpenMs : 10);
  }

  send(message: string | Uint8Array): void {
    if (message === 'PING') {
      setTimeout(() => this.onmessage?.({ data: 'PONG' } as MessageEvent), 5);
      return;
    }
    if (typeof message === 'string' && message.startsWith('START')) {
      link.startedAt ??= performance.now();
      this.carried = true;
      this.starts.push(message);
      const [, kb, count] = message.split(' ').map(Number);
      for (let i = 0; i < count; i++) this.due.push(kb * 1024);
      this.run();
      return;
    }
    if (message instanceof Uint8Array) {
      link.startedAt ??= performance.now();
      this.carried = true;
      this.unacked.push(message.byteLength);
      this.run();
    }
  }

  private run(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.readyState !== CappedLinkSocketMock.OPEN) return;
      const ms = performance.now() - (link.startedAt ?? 0);
      this.budget = Math.min(this.budget + link.perConnectionMbps(ms) * 125 * TICK_MS, 64 * 1024 * 1024);
      while (this.due.length > 0 && this.budget >= this.due[0]) {
        const bytes = this.due.shift()!;
        this.budget -= bytes;
        this.onmessage?.({ data: payload(bytes) } as MessageEvent);
      }
      let acks = 0;
      while (this.unacked.length > 0 && this.budget >= this.unacked[0]) {
        this.budget -= this.unacked.shift()!;
        acks++;
      }
      const deliver = () => {
        for (let i = 0; i < acks; i++) this.onmessage?.({ data: 'ACK' } as MessageEvent);
      };
      if (acks > 0 && link.roundTripMs > 0) setTimeout(deliver, link.roundTripMs);
      else deliver();
    }, TICK_MS);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.readyState = CappedLinkSocketMock.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

/** Sockets that carried data: every one but the loaded latency socket. */
const dataSockets = () =>
  CappedLinkSocketMock.instances.filter((socket) => socket.carried);

async function run(
  direction: 'download' | 'upload',
  options: Partial<ThroughputTestOptions> & { connectionCount: number }
) {
  const live: SpeedSnapshot[] = [];
  const runStage = direction === 'download' ? runDownloadSpeedTest : runUploadSpeedTest;
  const durationMs = options.durationMs ?? 7000;
  const promise = runStage({
    serverUrl: 'wss://speed.example.com/v1/ws',
    messageSizeKb: 16,
    durationMs,
    latencyMs: 20,
    jitterMs: 1,
    snapshotIntervalMs: 100,
    cancellationToken: new CancellationToken(),
    onSnapshot: (snapshot) => live.push(snapshot),
    ...options,
  });
  await vi.advanceTimersByTimeAsync(durationMs + 1000);
  return { result: await promise, live };
}

describe.each(['download', 'upload'] as const)('%s scale-up', (direction) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    vi.stubGlobal('WebSocket', CappedLinkSocketMock as unknown as typeof WebSocket);
    CappedLinkSocketMock.instances = [];
    Object.assign(link, { perConnectionMbps: () => 70, failAdded: 0, startedAt: null, roundTripMs: 0, addedOpenMs: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('opens the connections the measured speed calls for, and measures after they ramped up', async () => {
    // A collapsed estimate started the stage on 2 connections at 70 Mbps each: 140 Mbps at the
    // 1 s check (past 100 Mbps by the 25% margin) calls for 8, which carry 560 Mbps
    const { result } = await run(direction, { connectionCount: 2 });
    expect(result).toMatchObject({ initialConnectionCount: 2, requestedConnectionCount: 8, connectionCount: 8 });
    // Measured once the added connections carried data: their 560 Mbps, not a mix with the 140
    // before them
    expect(result.speedMbps).toBeGreaterThan(530);
    expect(result.speedMbps).toBeLessThan(575);
  });

  it('keeps a stage just past a tier threshold, within the margin', async () => {
    // 6 at 18 Mbps: 108 Mbps is past the 100 Mbps threshold for 8, but not by 25%
    link.perConnectionMbps = () => 18;
    const { result } = await run(direction, { connectionCount: 6 });
    expect(result).toMatchObject({ initialConnectionCount: 6, requestedConnectionCount: 6, connectionCount: 6 });
  });

  it('adds nothing when the stage already has the connections its speed calls for', async () => {
    const { result } = await run(direction, { connectionCount: 8 });
    expect(result).toMatchObject({ initialConnectionCount: 8, requestedConnectionCount: 8, connectionCount: 8 });
    expect(CappedLinkSocketMock.instances).toHaveLength(9);
  });

  it('opens at most 12 connections', async () => {
    link.perConnectionMbps = () => 400;
    const { result } = await run(direction, { connectionCount: 4 });
    expect(result).toMatchObject({ initialConnectionCount: 4, requestedConnectionCount: 12, connectionCount: 12 });
  });

  it('scales up later when the link speeds up during the first 3 s', async () => {
    // 5 Mbps per connection (30 Mbps on 6) until 1.5 s, then 250 (1.5 Gbps on 6): the 1 s check
    // keeps 6, the 2 s check opens 6 more
    link.perConnectionMbps = (ms) => (ms < 1500 ? 5 : 250);
    const { result } = await run(direction, { connectionCount: 6 });
    expect(result).toMatchObject({ initialConnectionCount: 6, requestedConnectionCount: 12, connectionCount: 12 });
    const added = CappedLinkSocketMock.instances.slice(7);
    expect(added).toHaveLength(6);
    for (const socket of added) expect(socket.createdAt - link.startedAt!).toBeGreaterThan(SCALE_UP_CHECKS_MS[1] - 100);
    expect(result.speedMbps).toBeGreaterThan(2900);
  });

  it('checks only while at least 3 s of the stage are left', async () => {
    const { result } = await run(direction, { connectionCount: 2, durationMs: 3500 });
    expect(result).toMatchObject({ initialConnectionCount: 2, requestedConnectionCount: 2, connectionCount: 2 });
  });

  it('goes on without an added connection that fails to open', async () => {
    link.failAdded = 2;
    const { result } = await run(direction, { connectionCount: 2 });
    expect(result).toMatchObject({ initialConnectionCount: 2, requestedConnectionCount: 8, connectionCount: 6 });
    expect(result.speedMbps).toBeGreaterThan(400);
    expect(dataSockets()).toHaveLength(6);
  });

  it('counts an added connection that opened after the measurement restarted', async () => {
    // The added connections open 1.5 s after they were asked for, past the 1 s settle point:
    // the measurement restarts without them, but they carried the stage and count
    link.addedOpenMs = 1500;
    const { result } = await run(direction, { connectionCount: 2 });
    expect(result).toMatchObject({ initialConnectionCount: 2, requestedConnectionCount: 8, connectionCount: 8 });
  });

  it('moves the live speed on from what it showed, without a jump, when measurement restarts', async () => {
    const { result, live } = await run(direction, { connectionCount: 2 });
    const steps = live.slice(1).map((snapshot, i) => snapshot.speedMbps - live[i].speedMbps);
    // From 140 to 560 Mbps: the live speed rises over about a second, never by more than a
    // third of the change in one snapshot, and never falls back
    expect(Math.max(...steps)).toBeLessThan(140);
    expect(Math.min(...steps.slice(15))).toBeGreaterThan(-40);
    const last = live.filter((snapshot) => snapshot.timeOffsetMs <= 7000).at(-1)!;
    expect(Math.abs(last.speedMbps - result.speedMbps)).toBeLessThan(15);
  });
});

describe('upload chunk sizes during a stage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    vi.stubGlobal('WebSocket', CappedLinkSocketMock as unknown as typeof WebSocket);
    CappedLinkSocketMock.instances = [];
    Object.assign(link, { perConnectionMbps: () => 50, failAdded: 0, startedAt: null, roundTripMs: 0, addedOpenMs: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** The sizes, in KiB, of the chunks each upload socket sent, by when. */
  const sentSizes = () => {
    const sent: Array<{ at: number; kb: number }> = [];
    for (const socket of CappedLinkSocketMock.instances) {
      const original = socket.send.bind(socket);
      socket.send = (message: string | Uint8Array) => {
        if (message instanceof Uint8Array) sent.push({ at: performance.now() - (link.startedAt ?? 0), kb: message.byteLength / 1024 });
        original(message);
      };
    }
    return sent;
  };

  it('shrink to about 10 ms of a slow connection, so the gauge moves in small steps', async () => {
    // 1 Mbps per connection, started with 4 KiB chunks: an estimate many times too high (a
    // first chunk of 2.5 ms of 1 Mbps is 0.3 KB)
    link.perConnectionMbps = () => 1;
    let sent: Array<{ at: number; kb: number }> = [];
    const promise = runUploadSpeedTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      messageSizeKb: 4,
      connectionCount: 4,
      durationMs: 7000,
      latencyMs: 20,
      jitterMs: 1,
      cancellationToken: new CancellationToken(),
    });
    await vi.advanceTimersByTimeAsync(15);
    sent = sentSizes();
    await vi.advanceTimersByTimeAsync(8000);
    const result = await promise;
    // Even with the kernel absorbing the chunks (64 unacknowledged), they don't grow back
    const late = sent.filter((chunk) => chunk.at > 4000).map((chunk) => chunk.kb);
    expect(late.length).toBeGreaterThan(0);
    expect(Math.max(...late)).toBeLessThanOrEqual(2);
    // Each snapshot then holds many small acknowledgements, not one large chunk or none
    const steps = result.snapshots.filter((s) => s.timeOffsetMs > 3000).map((s, i, all) => (i ? s.bytes - all[i - 1].bytes : null));
    expect(steps.slice(1).every((bytes) => bytes! > 0)).toBe(true);
  });

  it('reach a long fast path from small chunks: the data in flight follows the speed', async () => {
    // 8 connections at 100 Mbps, 300 ms round trip, starting on 1 KiB chunks. With 64 chunks in
    // flight they would carry 1.7 Mbps each at first.
    Object.assign(link, { perConnectionMbps: () => 100, roundTripMs: 300 });
    const promise = runUploadSpeedTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      messageSizeKb: 1,
      connectionCount: 8,
      durationMs: 7000,
      latencyMs: 300,
      jitterMs: 1,
      cancellationToken: new CancellationToken(),
    });
    await vi.advanceTimersByTimeAsync(8000);
    const result = await promise;
    expect(result.connectionCount).toBe(8);
    expect(result.speedMbps).toBeGreaterThan(700);
  }, 30_000);

  it('grow to about 10 ms of a fast connection', async () => {
    link.perConnectionMbps = () => 100;
    let sent: Array<{ at: number; kb: number }> = [];
    const promise = runUploadSpeedTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      messageSizeKb: 1,
      connectionCount: 8,
      durationMs: 7000,
      latencyMs: 20,
      jitterMs: 1,
      cancellationToken: new CancellationToken(),
    });
    await vi.advanceTimersByTimeAsync(15);
    sent = sentSizes();
    await vi.advanceTimersByTimeAsync(8000);
    await promise;
    const late = sent.filter((chunk) => chunk.at > 4000).map((chunk) => chunk.kb);
    expect(new Set(late)).toEqual(new Set([128]));
  }, 30_000);
});
