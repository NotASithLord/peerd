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
  /** @type {Map<string, { controller: AbortController, onOuterAbort?: () => void, outer?: AbortSignalLike, ops: Array<Record<string, unknown>> }>} */
  const runs = new Map();
  let seq = 0;

  return {
    /**
     * Mint a run id unique ACROSS SW restarts too: the offscreen document
     * (and a still-running orphan job) can outlive the SW whose counter
     * reset — a bare seq would collide and cross-wire the two jobs' kill
     * switches. The time+random suffix makes that practically impossible.
     * @param {string} sessionId
     */
    mintRunId: (sessionId) =>
      `scriptrun-${sessionId}-${++seq}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,

    /**
     * Register a live run. Chains the run's own controller to the caller's
     * dispatch abort signal (Stop), so either aborts the pending asks.
     * @param {string} runId @param {AbortSignalLike} [outerSignal]
     */
    register: (runId, outerSignal) => {
      const controller = new AbortController();
      /** @type {{ controller: AbortController, onOuterAbort?: () => void, outer?: AbortSignalLike, ops: Array<Record<string, unknown>> }} */
      const entry = { controller, ops: [] };
      if (outerSignal) {
        const onOuterAbort = () => controller.abort();
        if (outerSignal.aborted) controller.abort();
        else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
        entry.onOuterAbort = onOuterAbort;
        entry.outer = outerSignal;
      }
      runs.set(runId, entry);
    },

    /**
     * The SW-side op mirror — the actors/call route records each op here so
     * the chain-of-events SURVIVES an offscreen crash (the worker-held trace
     * dies with the worker; this copy is what the script tool's failure path
     * reads back). Capped — a runaway op loop can't grow it unbounded.
     * @param {string} runId @param {Record<string, unknown>} op
     */
    recordOp: (runId, op) => {
      const entry = runs.get(runId);
      if (!entry) return;
      if (entry.ops.length >= 50) entry.ops.shift();
      entry.ops.push(op);
    },

    /** The mirrored ops for a run (copy), [] when unknown. @param {string} runId */
    opsFor: (runId) => [...(runs.get(runId)?.ops ?? [])],

    /** The run's abort signal for pending asks, or null when unregistered. @param {string} runId */
    signalFor: (runId) => runs.get(runId)?.controller.signal ?? null,

    /** Abort a run's pending asks (Stop / tool-dispatch unwind). @param {string} runId */
    abort: (runId) => { runs.get(runId)?.controller.abort(); },

    /**
     * Release a finished run. ABORTS FIRST: the run is over, so any ask still
     * pending SW-side is an orphan whose actor turn must die with it (a job
     * timeout / worker crash reaches here without the Stop signal ever firing
     * — without this abort those turns would burn tokens for up to the
     * per-ask cap after the script already returned). Then detaches the
     * outer-signal listener so a long-lived turn signal doesn't accumulate
     * dead handlers.
     * @param {string} runId
     */
    release: (runId) => {
      const entry = runs.get(runId);
      if (!entry) return;
      entry.controller.abort();
      if (entry.outer && entry.onOuterAbort) {
        try { entry.outer.removeEventListener?.('abort', entry.onOuterAbort); } catch { /* stub signal */ }
      }
      runs.delete(runId);
    },

    /** Live-run count (tests + debugging). */
    _size: () => runs.size,
  };
};
