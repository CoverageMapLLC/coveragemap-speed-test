/**
 * Detects when the thread running a test was blocked, for example by an application
 * rendering on the browser's main thread between stages. A blocked thread handles socket
 * events late, so a measurement timed across the block reflects the application, not the
 * network. A heartbeat timer runs while the monitor is active; a heartbeat that arrives
 * much later than scheduled means the thread was busy.
 */

/** A gap this much longer than the heartbeat interval counts as a stall. */
export const STALL_THRESHOLD_MS = 50;
export const HEARTBEAT_INTERVAL_MS = 10;

export interface StallMonitor {
  /** Starts a new measurement window. */
  reset(): void;
  /** True if the thread was blocked for longer than the threshold since the last reset. */
  stalled(): boolean;
  stop(): void;
}

export function createStallMonitor(thresholdMs = STALL_THRESHOLD_MS): StallMonitor {
  let last = performance.now();
  let longestGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longestGap = Math.max(longestGap, now - last - HEARTBEAT_INTERVAL_MS);
    last = now;
  }, HEARTBEAT_INTERVAL_MS);
  // Never keep a Node.js process alive just for the heartbeat.
  (timer as { unref?: () => void }).unref?.();

  return {
    reset() {
      last = performance.now();
      longestGap = 0;
    },
    stalled() {
      // A block that just ended, before the next heartbeat could run, counts too.
      const current = performance.now() - last - HEARTBEAT_INTERVAL_MS;
      return Math.max(longestGap, current) > thresholdMs;
    },
    stop() {
      clearInterval(timer);
    },
  };
}
