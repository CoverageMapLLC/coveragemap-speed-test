/**
 * Keeps the thread busy for `ms`, as an application rendering on the browser's main thread
 * would: no timer or socket event can run until it returns.
 */
export function blockThread(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // busy
  }
}
