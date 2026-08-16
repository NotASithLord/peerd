// @ts-check

/**
 * Build a safe, single-flight state projection scheduler.
 *
 * Synchronous bursts share one build. A request that arrives while storage is
 * being read marks that projection stale, so it is skipped and exactly one
 * fresh projection is built after it. Notification failures are reported but
 * never escape as unhandled rejections from fire-and-forget callers.
 *
 * @template T
 * @param {{
 *   isConnected: () => boolean,
 *   build: () => Promise<T> | T,
 *   deliver: (state: T) => Promise<void> | void,
 *   onError?: (error: unknown) => void,
 * }} deps
 * @returns {() => Promise<void>}
 */
export const makeCoalescedStatePush = ({
  isConnected, build, deliver, onError = () => {},
}) => {
  let dirty = false;
  /** @type {Promise<void> | null} */
  let inFlight = null;

  /** @param {unknown} error */
  const report = (error) => {
    try { onError(error); } catch { /* diagnostics must not break delivery */ }
  };

  const drain = async () => {
    while (dirty) {
      dirty = false;
      if (!isConnected()) continue;
      try {
        const state = await build();
        // A mutation requested another push while this projection crossed its
        // async stores. Do not flash the stale snapshot before the fresh one.
        if (dirty || !isConnected()) continue;
        await deliver(state);
      } catch (error) {
        report(error);
      }
    }
  };

  /** @type {() => Promise<void>} */
  const request = () => {
    dirty = true;
    if (!inFlight) {
      // The microtask boundary coalesces a same-turn burst before any storage
      // read starts, while still returning one awaitable completion promise.
      inFlight = Promise.resolve()
        .then(async () => {
          try {
            await drain();
          } catch (error) {
            report(error);
          } finally {
            // Clear ownership inside the runner, not in a later promise
            // reaction. A request can otherwise land after drain() resolves
            // but before finally() clears inFlight: it sees a running promise,
            // marks dirty, and no runner remains to observe that mark.
            inFlight = null;
            if (dirty) await request();
          }
        })
        .then(() => undefined);
    }
    return inFlight;
  };

  return request;
};
