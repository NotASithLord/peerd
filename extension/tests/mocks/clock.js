// @ts-check
// Test clock helpers.
//
// Modules that care about time (vault auto-lock, audit timestamps,
// UUIDv7 generation) take a `now()` function in their factory. Production
// passes `Date.now`; tests pass one of these.

/**
 * Synthetic setTimeout/clearTimeout pair. Tests pass these into the
 * vault factory in place of the real timers, then call `tick(ms)` to
 * advance the schedule and fire callbacks that came due.
 *
 * Not a full xUnit-style fake — no setInterval, no setImmediate. The
 * codebase only uses setTimeout for the vault auto-lock and the
 * offscreen reconnect backoff.
 */
export const fakeTimers = () => {
  let now = 0;
  let nextId = 1;
  /** @type {Map<number, { fireAt: number, fn: () => void }>} */
  const pending = new Map(); // id → { fireAt, fn }

  return {
    /**
     * @param {() => void} fn
     * @param {number} ms
     */
    setTimer: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { fireAt: now + ms, fn });
      return id;
    },
    /** @param {number} id */
    clearTimer: (id) => { pending.delete(id); },
    /** @param {number} ms */
    tick: (ms) => {
      now += ms;
      // Copy to an array first — timers may schedule new timers when
      // they fire, which would mutate the map mid-iteration.
      const due = [...pending.entries()]
        .filter(([_, { fireAt }]) => fireAt <= now)
        .sort((a, b) => a[1].fireAt - b[1].fireAt);
      for (const [id, { fn }] of due) {
        pending.delete(id);
        fn();
      }
    },
    pendingCount: () => pending.size,
  };
};
