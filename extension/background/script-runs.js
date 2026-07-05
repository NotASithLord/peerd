// @ts-check
// background/script-runs.js — the live registry of actors-enabled script runs.
//
// why it exists: a `script` run that delegates holds real work in flight —
// pending actors.ask calls are LIVE ACTOR TURNS. When the user hits Stop (or
// the turn aborts for any reason), those turns must die with the run, and the
// worker itself should be terminated instead of running to its wall-clock.
// The tool execute registers each run here with the dispatch abort signal;
// the SW actors/call route derives every pending ask's awaitSignal from the
// run's controller, so one abort() unwinds the whole delegation fan.
//
// Pure factory (values + injected clock only) — bun-tested without a browser.

/**
 * @typedef {{ aborted: boolean, addEventListener: (t: string, fn: () => void, opts?: object) => void, removeEventListener?: (t: string, fn: () => void) => void }} AbortSignalLike
 */

export const createScriptRunRegistry = () => {
  /** @type {Map<string, { controller: AbortController, onOuterAbort?: () => void, outer?: AbortSignalLike }>} */
  const runs = new Map();
  let seq = 0;

  return {
    /** Mint a collision-proof run id. @param {string} sessionId */
    mintRunId: (sessionId) => `scriptrun-${sessionId}-${++seq}`,

    /**
     * Register a live run. Chains the run's own controller to the caller's
     * dispatch abort signal (Stop), so either aborts the pending asks.
     * @param {string} runId @param {AbortSignalLike} [outerSignal]
     */
    register: (runId, outerSignal) => {
      const controller = new AbortController();
      /** @type {{ controller: AbortController, onOuterAbort?: () => void, outer?: AbortSignalLike }} */
      const entry = { controller };
      if (outerSignal) {
        const onOuterAbort = () => controller.abort();
        if (outerSignal.aborted) controller.abort();
        else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
        entry.onOuterAbort = onOuterAbort;
        entry.outer = outerSignal;
      }
      runs.set(runId, entry);
    },

    /** The run's abort signal for pending asks, or null when unregistered. @param {string} runId */
    signalFor: (runId) => runs.get(runId)?.controller.signal ?? null,

    /** Abort a run's pending asks (Stop / tool-dispatch unwind). @param {string} runId */
    abort: (runId) => { runs.get(runId)?.controller.abort(); },

    /**
     * Release a finished run. Detaches the outer-signal listener so a
     * long-lived turn signal doesn't accumulate dead handlers.
     * @param {string} runId
     */
    release: (runId) => {
      const entry = runs.get(runId);
      if (entry?.outer && entry.onOuterAbort) {
        try { entry.outer.removeEventListener?.('abort', entry.onOuterAbort); } catch { /* stub signal */ }
      }
      runs.delete(runId);
    },

    /** Live-run count (tests + debugging). */
    _size: () => runs.size,
  };
};
