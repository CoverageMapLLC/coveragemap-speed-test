// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStallMonitor, STALL_THRESHOLD_MS } from '../src/utils/stall-monitor.js';
import { blockThread } from './helpers/block-thread.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const monitors: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stop();
});

function monitor(thresholdMs?: number) {
  const created = createStallMonitor(thresholdMs);
  monitors.push(created);
  return created;
}

describe('stall monitor', () => {
  it('reports no stall while the thread is free', async () => {
    const stalls = monitor();
    await sleep(120);
    expect(stalls.stalled()).toBe(false);
  });

  it('reports a stall the thread is still coming out of', () => {
    const stalls = monitor();
    // No heartbeat can run during the block, so only the time since the last one shows it.
    blockThread(STALL_THRESHOLD_MS + 60);
    expect(stalls.stalled()).toBe(true);
  });

  it('remembers a stall after later heartbeats ran', async () => {
    const stalls = monitor();
    blockThread(STALL_THRESHOLD_MS + 60);
    await sleep(40);
    expect(stalls.stalled()).toBe(true);
  });

  it('forgets earlier stalls on reset', async () => {
    const stalls = monitor();
    blockThread(STALL_THRESHOLD_MS + 60);
    stalls.reset();
    await sleep(40);
    expect(stalls.stalled()).toBe(false);
  });

  it('ignores blocks shorter than the threshold', () => {
    const stalls = monitor();
    blockThread(STALL_THRESHOLD_MS / 2);
    expect(stalls.stalled()).toBe(false);
  });

  it('uses a custom threshold', () => {
    const stalls = monitor(200);
    blockThread(120);
    expect(stalls.stalled()).toBe(false);
  });

  it('stops its heartbeat', () => {
    const clear = vi.spyOn(globalThis, 'clearInterval');
    monitor().stop();
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
