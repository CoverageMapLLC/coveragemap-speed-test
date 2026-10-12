import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_STALLED_ROUND_REPEATS, runUploadEstimationTest } from '../src/tests/upload-estimation-test.js';
import { CancellationToken } from '../src/utils/cancellation.js';
import { blockThread } from './helpers/block-thread.js';

class UploadEstimationSocketMock {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = UploadEstimationSocketMock.CONNECTING;
  bufferedAmount = 0;
  binaryType = 'arraybuffer';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(_url: string) {
    setTimeout(() => {
      this.readyState = UploadEstimationSocketMock.OPEN;
      this.onopen?.(new Event('open'));
    }, 0);
  }

  send(payload: string | Uint8Array): void {
    if (payload instanceof Uint8Array) {
      setTimeout(() => {
        this.onmessage?.({ data: 'ACK' } as MessageEvent);
      }, 0);
    }
  }

  close(): void {
    this.readyState = UploadEstimationSocketMock.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

describe('upload estimation protocol', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('estimates upload speed from ACK responses', async () => {
    vi.stubGlobal('WebSocket', UploadEstimationSocketMock as unknown as typeof WebSocket);
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 120;
      return now;
    });

    const result = await runUploadEstimationTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      latencyMs: 5,
      jitterMs: 5,
      cancellationToken: new CancellationToken(),
    });

    expect(result.bytes).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.speedMbps).toBeGreaterThan(0);
  });

  it('fails when websocket closes before completion', async () => {
    class EarlyCloseSocketMock extends UploadEstimationSocketMock {
      send(): void {
        setTimeout(() => {
          this.onclose?.(new CloseEvent('close'));
        }, 0);
      }
    }

    vi.stubGlobal('WebSocket', EarlyCloseSocketMock as unknown as typeof WebSocket);
    await expect(
      runUploadEstimationTest({
        serverUrl: 'wss://speed.example.com/v1/ws',
        latencyMs: 5,
        jitterMs: 5,
        cancellationToken: new CancellationToken(),
      })
    ).rejects.toThrow('WebSocket closed before upload estimation completed');
  });

  it('times out when ACK responses are never received', async () => {
    class NoAckSocketMock extends UploadEstimationSocketMock {
      send(): void {
        // Intentionally no ACK.
      }
    }

    vi.stubGlobal('WebSocket', NoAckSocketMock as unknown as typeof WebSocket);
    await expect(
      runUploadEstimationTest({
        serverUrl: 'wss://speed.example.com/v1/ws',
        latencyMs: 5,
        jitterMs: 5,
        timeoutMs: 20,
        cancellationToken: new CancellationToken(),
      })
    ).rejects.toThrow('Upload estimation timed out');
  });
});

describe('upload estimation when the thread stalls', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A socket that acknowledges every chunk on a later tick. `beforeAck` runs first for each
   * round (counted from 1) and can block the thread or ask for a delay.
   */
  function socketWith(beforeAck: (round: number) => number | void) {
    const rounds = { count: 0 };
    class ScriptedSocket extends UploadEstimationSocketMock {
      private pendingInRound = 0;

      send(payload: string | Uint8Array): void {
        if (!(payload instanceof Uint8Array)) return;
        if (this.pendingInRound === 0) rounds.count++;
        this.pendingInRound++;
        const round = rounds.count;
        setTimeout(() => {
          const delayMs = beforeAck(round) ?? 0;
          setTimeout(() => {
            this.pendingInRound--;
            this.onmessage?.({ data: 'ACK' } as MessageEvent);
          }, delayMs);
        }, 0);
      }
    }
    vi.stubGlobal('WebSocket', ScriptedSocket as unknown as typeof WebSocket);
    return rounds;
  }

  const run = () =>
    runUploadEstimationTest({
      serverUrl: 'wss://speed.example.com/v1/ws',
      latencyMs: 1,
      jitterMs: 0,
      cancellationToken: new CancellationToken(),
    });

  it('repeats a round the thread was blocked through instead of settling on it', async () => {
    let blocked = false;
    socketWith((round) => {
      if (round === 1 && !blocked) {
        blocked = true;
        blockThread(150);
      }
    });

    const result = await run();
    // Without the repeat the 150 ms block would end the estimation at the first 5 KB round.
    expect(result.bytes).toBeGreaterThan(5 * 1024);
  });

  it('still settles on the first slow round when the network is what is slow', async () => {
    const rounds = socketWith(() => 150);

    const result = await run();
    expect(result.bytes).toBe(5 * 1024);
    expect(rounds.count).toBe(1);
    expect(result.speedMbps).toBeLessThan(1);
  });

  it('settles after a bounded number of repeats when every round stalls', async () => {
    const rounds = socketWith(() => {
      blockThread(120);
    });

    const result = await run();
    expect(result.bytes).toBe(5 * 1024);
    expect(rounds.count).toBe(1 + MAX_STALLED_ROUND_REPEATS);
  });
});
