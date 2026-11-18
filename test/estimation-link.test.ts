import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDownloadEstimationTest } from '../src/tests/download-estimation-test.js';
import { runUploadEstimationTest } from '../src/tests/upload-estimation-test.js';
import { ESTIMATION_TIME_CAP_MS } from '../src/utils/adaptive.js';
import { CancellationToken } from '../src/utils/cancellation.js';

/**
 * A simulated link for estimation: every round takes the round trip plus its bytes at `mbps`,
 * and the rounds in `stalls` take that many ms longer (a lost packet's recovery).
 */
const link = {
  roundTripMs: 0,
  mbps: 0,
  stalls: new Map<number, number>(),
};

class LinkSocketMock {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static starts: string[] = [];
  static uploadRounds: number[] = [];

  readyState = LinkSocketMock.CONNECTING;
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  private round = 0;
  private uploadBytes = 0;
  private uploadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(_url: string) {
    setTimeout(() => {
      this.readyState = LinkSocketMock.OPEN;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  private delayMs(bytes: number): number {
    return link.roundTripMs + bytes / (link.mbps * 125) + (link.stalls.get(this.round) ?? 0);
  }

  send(payload: string | Uint8Array): void {
    if (typeof payload === 'string' && payload.startsWith('START')) {
      this.round++;
      LinkSocketMock.starts.push(payload);
      const bytes = Number(payload.split(' ')[1]) * 1024;
      setTimeout(() => this.onmessage?.({ data: new ArrayBuffer(bytes) } as MessageEvent), this.delayMs(bytes));
      return;
    }
    // The 512-byte warm-up message before download estimation is not a round
    if (payload instanceof Uint8Array && payload.byteLength > 512) {
      // A round's chunks are sent together; each is acknowledged as the last one is
      if (this.uploadTimer === null) this.round++;
      else clearTimeout(this.uploadTimer);
      this.uploadBytes += payload.byteLength;
      const chunks = ++this.pendingChunks;
      this.uploadTimer = setTimeout(() => {
        LinkSocketMock.uploadRounds.push(this.uploadBytes / 1024);
        this.uploadTimer = null;
        this.uploadBytes = 0;
        this.pendingChunks = 0;
        for (let i = 0; i < chunks; i++) this.onmessage?.({ data: 'ACK' } as MessageEvent);
      }, this.delayMs(this.uploadBytes));
    }
  }

  private pendingChunks = 0;

  close(): void {
    this.readyState = LinkSocketMock.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

const estimate = (direction: 'download' | 'upload') => {
  const options = {
    serverUrl: 'wss://speed.example.com/v1/ws',
    // The latency bias takes the round trip off, as the latency stage measured it
    latencyMs: link.roundTripMs,
    jitterMs: 0,
    cancellationToken: new CancellationToken(),
  };
  return direction === 'download' ? runDownloadEstimationTest(options) : runUploadEstimationTest(options);
};

async function run(direction: 'download' | 'upload') {
  const startedAt = performance.now();
  let tookMs = Infinity;
  const promise = estimate(direction).then((result) => {
    tookMs = performance.now() - startedAt;
    return result;
  });
  await vi.advanceTimersByTimeAsync(20_000);
  const result = await promise;
  return { result, tookMs };
}

describe.each(['download', 'upload'] as const)('%s estimation on a simulated link', (direction) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    vi.stubGlobal('WebSocket', LinkSocketMock as unknown as typeof WebSocket);
    LinkSocketMock.starts = [];
    LinkSocketMock.uploadRounds = [];
    link.stalls = new Map();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const sizes = () => (direction === 'download' ? LinkSocketMock.starts.map((s) => Number(s.split(' ')[1])) : LinkSocketMock.uploadRounds);

  it('reaches 5 MiB on a clean gigabit link and estimates its speed', async () => {
    Object.assign(link, { roundTripMs: 57, mbps: 940 });
    const { result } = await run(direction);
    expect(result.speedMbps).toBeGreaterThan(900);
    expect(sizes().at(-1)).toBe(5120);
    expect(sizes()[1] / sizes()[0]).toBe(3);
  });

  it('goes on past rounds that stalled on a lost packet, instead of settling on them', async () => {
    // 200 ms recoveries in the third and fourth rounds; the old rule stopped on the third at a
    // few Mbps
    Object.assign(link, { roundTripMs: 57, mbps: 940, stalls: new Map([[3, 200], [4, 200]]) });
    const { result } = await run(direction);
    expect(result.speedMbps).toBeGreaterThan(800);
  });

  it('stops on the first clean round of 100 ms or more on a slow link', async () => {
    Object.assign(link, { roundTripMs: 40, mbps: 1 });
    const { result } = await run(direction);
    const first = direction === 'download' ? 10 : 5;
    // 10 KiB at 1 Mbps is 82 ms, 30 KiB 245 ms (upload: 5 KiB 41 ms, 15 KiB 123 ms)
    expect(sizes()).toEqual([first, first * 3]);
    expect(result.speedMbps).toBeCloseTo(1, 1);
  });

  it('measures a 100 kbps link in two rounds', async () => {
    Object.assign(link, { roundTripMs: 300, mbps: 0.1 });
    const { result } = await run(direction);
    expect(sizes()).toHaveLength(2);
    expect(result.speedMbps).toBeCloseTo(0.1, 2);
  });

  it('does not settle on a first round that took a round trip longer', async () => {
    // A fast link whose first round waited a whole extra round trip (300 ms)
    Object.assign(link, { roundTripMs: 300, mbps: 500, stalls: new Map([[1, 300]]) });
    const { result } = await run(direction);
    expect(result.speedMbps).toBeGreaterThan(400);
  });

  it(`settles ${ESTIMATION_TIME_CAP_MS} ms after its first round when rounds keep stalling`, async () => {
    Object.assign(link, {
      roundTripMs: 57,
      mbps: 500,
      stalls: new Map([[2, 600], [3, 600], [4, 600], [5, 600], [6, 600], [7, 600]]),
    });
    const { tookMs } = await run(direction);
    expect(tookMs).toBeLessThan(ESTIMATION_TIME_CAP_MS + 1000);
    expect(sizes().length).toBeLessThan(6);
  });
});
