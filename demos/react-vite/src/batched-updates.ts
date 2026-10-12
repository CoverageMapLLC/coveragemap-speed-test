import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';

/**
 * Applies queued state updates together, at most once every `intervalMs`. Progress callbacks
 * arrive ten times a second per stage; rendering the page for each one costs more than the
 * extra frames are worth. `flush` applies whatever is queued at once, for events that should
 * show immediately.
 */
export function useBatchedUpdates<T>(setState: Dispatch<SetStateAction<T>>, intervalMs = 250) {
  const queued = useRef<Array<(previous: T) => T>>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const updates = queued.current;
    if (updates.length === 0) return;
    queued.current = [];
    setState((previous) => updates.reduce((state, update) => update(state), previous));
  }, [setState]);

  const queue = useCallback(
    (update: (previous: T) => T) => {
      queued.current.push(update);
      if (!timer.current) timer.current = setTimeout(flush, intervalMs);
    },
    [flush, intervalMs]
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  return { queue, flush };
}
