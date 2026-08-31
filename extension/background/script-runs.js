// @ts-check
// background/script-runs.js — the live registry of session-owned script runs.
// Every run registers so Stop can terminate its worker. Actors/provider flags
// are explicit capabilities: a run id alone buys no relay authority.
//
// why it exists: a `script` run holds real work in flight — compute, egress,
// workspace writes, and possibly LIVE ACTOR/MODEL TURNS. When the user hits
// Stop (or the turn aborts for any reason), that work must die with the run
// instead of continuing to its wall-clock.
// The tool execute registers each run here with the dispatch abort signal;
// the SW actors/call route derives every pending ask's awaitSignal from the
// run's controller, so one abort() unwinds the whole delegation fan.
//
// Pure factory (values + injected limits only) — bun-tested without a browser.

/**
 * @typedef {{ aborted: boolean, addEventListener: (t: string, fn: () => void, opts?: object) => void, removeEventListener?: (t: string, fn: () => void) => void }} AbortSignalLike
 */

/** @param {{ actorOpLimit?: number, codeOpLimit?: number }} [options] */
export const createScriptRunRegistry = ({ actorOpLimit = 50, codeOpLimit = actorOpLimit } = {}) => {
  /** @type {Map<string, { controller: AbortController, onOuterAbort?: () => void, outer?: AbortSignalLike, ops: Array<Record<string, unknown>>, owner?: string, capabilities: Record<string, boolean>, operations: Set<string>, opCounts: Record<string, number>, providerCalls: number, providerOutputTokens: number }>} */
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
     * `owner` binds the run to its session: the script/model-call relay
     * refuses a runId whose registered owner doesn't match the trusted job
     * param (design 5 — a dead or foreign run buys nothing).
     * @param {string} runId @param {AbortSignalLike} [outerSignal] @param {string} [owner]
     * @param {Record<string, boolean>} [capabilities]
     * @param {Iterable<string>} [operations] exact host operations projected
     *   by the sealed semantic owner for this run
     */
    register: (runId, outerSignal, owner, capabilities = {}, operations = []) => {
      const controller = new AbortController();
      /** @type {{ controller: AbortController, onOuterAbort?: () => void, outer?: AbortSignalLike, ops: Array<Record<string, unknown>>, owner?: string, capabilities: Record<string, boolean>, operations: Set<string>, opCounts: Record<string, number>, providerCalls: number, providerOutputTokens: number }} */
      const entry = {
        controller,
        ops: [],
        ...(owner ? { owner } : {}),
        capabilities: Object.fromEntries(Object.entries(capabilities).map(([name, on]) => [name, on === true])),
        operations: new Set([...operations].filter((operation) => typeof operation === 'string')),
        opCounts: {},
        providerCalls: 0,
        providerOutputTokens: 0,
      };
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
      // A delegation is mirrored before dispatch with settled:false, then
      // updated in place when it replies, fails, or is cancelled. Keeping one
      // row per sequence makes a crash snapshot honest without duplicating the
      // same operation in the final trace.
      const existingIndex = typeof op.seq === 'number'
        ? entry.ops.findIndex((candidate) => candidate.seq === op.seq)
        : -1;
      if (existingIndex >= 0) {
        entry.ops[existingIndex] = { ...entry.ops[existingIndex], ...op };
        return;
      }
      if (entry.ops.length >= actorOpLimit) entry.ops.shift();
      entry.ops.push(op);
    },

    /** The mirrored ops for a run (copy), [] when unknown. @param {string} runId */
    opsFor: (runId) => [...(runs.get(runId)?.ops ?? [])],

    /** The run's abort signal for pending asks, or null when unregistered. @param {string} runId */
    signalFor: (runId) => runs.get(runId)?.controller.signal ?? null,

    /** The session a live run was registered FOR, or null. @param {string} runId */
    ownerFor: (runId) => runs.get(runId)?.owner ?? null,

    /** A live run may redeem only the capability minted for its job lane.
     * @param {string} runId @param {string} capability */
    allows: (runId, capability) => {
      const entry = runs.get(runId);
      return entry?.controller.signal.aborted !== true
        && entry?.capabilities[capability] === true;
    },

    /** A code bridge may redeem only an exact operation projected when its
     * outer semantic call registered the run. @param {string} runId
     * @param {string} operation */
    allowsOperation: (runId, operation) => {
      const entry = runs.get(runId);
      return entry?.controller.signal.aborted !== true
        && entry?.operations.has(operation) === true;
    },

    /** Atomically admit one code-client op against a per-capability run ceiling.
     * Counting happens before any await, so Promise.all cannot oversubscribe it.
     * @param {string} runId @param {string} capability @param {number} [limit] */
    admitCodeOp: (runId, capability, limit = codeOpLimit) => {
      const entry = runs.get(runId);
      if (!entry || entry.controller.signal.aborted
        || entry.capabilities[capability] !== true
        || (entry.opCounts[capability] ?? 0) >= limit) return false;
      entry.opCounts[capability] = (entry.opCounts[capability] ?? 0) + 1;
      return true;
    },

    /** Compatibility name for the actors route. @param {string} runId */
    admitActorOp: (runId) => {
      const entry = runs.get(runId);
      if (!entry || entry.controller.signal.aborted
        || entry.capabilities.actors !== true
        || (entry.opCounts.actors ?? 0) >= actorOpLimit) return false;
      entry.opCounts.actors = (entry.opCounts.actors ?? 0) + 1;
      return true;
    },

    // ── design 5: the per-run sub-model quota counters ────────────────────
    // SW-side ON PURPOSE (never worker state): the realm being metered must
    // not hold its own meter. The call is counted BEFORE it flies so a
    // concurrent fan-out can't slip N calls past one stale read.

    /** Count one sub-call against the run, RESERVING its clamped maxTokens
     * against the output meter at admission. why reserve: the quota is checked
     * before flight and settled after, so without a reservation a concurrent
     * fan-out (Promise.all) all admits against a stale 0 and the run's token
     * ceiling only binds strictly sequential scripts. settleProviderCall
     * reconciles the reservation to the actual billed output.
     * @param {string} runId @param {number} [reserveOutputTokens] */
    recordProviderCall: (runId, reserveOutputTokens = 0) => {
      const entry = runs.get(runId);
      if (!entry) return;
      entry.providerCalls += 1;
      if (Number.isFinite(reserveOutputTokens) && reserveOutputTokens > 0) {
        entry.providerOutputTokens += reserveOutputTokens;
      }
    },

    /** Settle a sub-call's admission reservation against its actual billed
     * output (0 when the stream produced none — the reservation is released).
     * @param {string} runId @param {number} reservedOutputTokens @param {number} actualOutputTokens */
    settleProviderCall: (runId, reservedOutputTokens, actualOutputTokens) => {
      const entry = runs.get(runId);
      if (!entry) return;
      const reserved = Number.isFinite(reservedOutputTokens) && reservedOutputTokens > 0 ? reservedOutputTokens : 0;
      const actual = Number.isFinite(actualOutputTokens) && actualOutputTokens > 0 ? actualOutputTokens : 0;
      entry.providerOutputTokens = Math.max(0, entry.providerOutputTokens - reserved + actual);
    },

    /** @param {string} runId @param {number} reservedOutputTokens */
    cancelProviderCall: (runId, reservedOutputTokens) => {
      const entry = runs.get(runId);
      if (!entry) return;
      const reserved = Number.isFinite(reservedOutputTokens) && reservedOutputTokens > 0
        ? reservedOutputTokens : 0;
      entry.providerCalls = Math.max(0, entry.providerCalls - 1);
      entry.providerOutputTokens = Math.max(0, entry.providerOutputTokens - reserved);
    },

    /** The run's sub-call meter (copy), or null when unregistered. @param {string} runId */
    providerUsageFor: (runId) => {
      const entry = runs.get(runId);
      return entry ? { calls: entry.providerCalls, outputTokens: entry.providerOutputTokens } : null;
    },

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
