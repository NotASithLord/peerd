// @ts-check
// actors-api.js — the PURE translation core for a trusted delegator's code
// surface over its actors: `actors.*` inside the `script` tool.
//
// The inverse of a2a-api.js (its direct twin): a2a said "a peer's agent is an
// actor whose heap is remote"; this says "an actor is a peer whose heap is
// local". Same bet as #119 — the model choreographs many delegations most
// fluently as promise request/response code, not as one gated tool call per
// message — and the same shape: a tiny method table maps each `actors.<method>`
// call to a gated OP the SW dispatches through the EXISTING message_actor
// machinery (sender gate, rate caps, dedupe, audit — nothing new is trusted).
//
// What script code gets ON PURPOSE and what it doesn't:
//   • list / ask — DELEGATION only. The script can ask an actor to do
//     work and await the reply; it can never name a raw tool, spawn an actor,
//     or reach another capability through this bridge (the job host denies
//     everything undeclared, same posture as a2a).
//   • ask addresses SANDBOX + WEB actors alike — authority is unchanged
//     because every op runs the full messageActor gate chain per call; oneShot
//     rides through and stays sandbox-only (enforced there, not re-implemented
//     here).
//
// Pure — values in, values out, no IO, no imports. The imperative shell (the
// worker bridge, the job-runner relay, the SW actors/call route) lives in
// worker-source.js / job-runner.js / service-worker.js.

/** A failed actors op REJECTS like a thrown call — so `await actors.ask(...)` throws. */
export class ActorsApiError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'ActorsApiError'; }
}

/** @param {unknown} v @param {string} what */
const nonEmptyString = (v, what) => {
  if (typeof v !== 'string' || v.trim().length === 0) throw new ActorsApiError(`${what} must be a non-empty string`);
  return v;
};

/** Actor lists render numeric tab ids; normalize those handles at the code edge.
 * @param {unknown} v @param {string} what */
const actorAddress = (v, what) => {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return String(v);
  return nonEmptyString(v, what);
};

// The timeout TOWER, defined once so it cannot drift apart (the nesting
// job wall-clock > worker bridge guard > per-ask cap is what makes a stuck
// actor turn fail as an ask timeout the script can handle, not a mid-run
// worker termination — same reasoning as a2a-run's timer note). Every layer
// DERIVES from the ask ceiling: bump it and the tower moves together.
export const ACTORS_ASK_MAX_TIMEOUT_MS = 240_000;
export const ACTORS_ASK_DEFAULT_TIMEOUT_MS = 120_000;
// One run may compose many calls, but it is not an unbounded actor-message
// pump. Shared by the SW admission meter and the offscreen trace ring.
export const ACTORS_RUN_MAX_OPS = 50;
// The worker-side bridge guard — sits ABOVE the ask cap so the SW's timeout
// (a handleable rejection) always fires before the bridge gives up.
export const ACTORS_BRIDGE_GUARD_MS = ACTORS_ASK_MAX_TIMEOUT_MS + 10_000;
// The job wall-clock for a delegating run — sits ABOVE the bridge guard.
export const ACTORS_JOB_DEFAULT_TIMEOUT_MS = ACTORS_BRIDGE_GUARD_MS + 20_000;
export const ACTORS_JOB_MAX_TIMEOUT_MS = ACTORS_BRIDGE_GUARD_MS + 50_000;

/**
 * @typedef {{ op: string, toArgs: (a: any) => object, shape: (c: any) => any, delegates?: boolean }} ActorsMethodSpec
 */

// The method table. `delegates:true` marks an op that hands a GOAL to an actor
// (ask) — the SW route runs it through messageActor's full gate chain
// (sender gate, runaway caps, duplicate-intent, audit). `list` is the read-only
// roster (the actor_list catalog, dispatched through the normal tool gates).
/** @type {Record<string, ActorsMethodSpec>} */
const ACTORS_METHODS = {
  // Everything addressable right now — instances, open tabs, integrations —
  // with the handle to pass as ask's `to`. Read.
  list: {
    op: 'list',
    toArgs: () => ({}),
    shape: (c) => c?.roster ?? '',
  },
  // ASK — delegate a goal and await the actor's ONE reply within this run.
  // Returns { reply, failed } (failed:true = the actor's turn errored/aborted;
  // the reply text then describes the failure). A timeout REJECTS (throws).
  ask: {
    op: 'ask',
    toArgs: (a) => {
      const to = actorAddress(a?.to, 'actors.ask(to, goal): to');
      const goal = nonEmptyString(a?.goal, 'actors.ask(to, goal): goal');
      const timeoutMs = typeof a?.timeoutMs === 'number' && a.timeoutMs > 0
        ? Math.min(a.timeoutMs, ACTORS_ASK_MAX_TIMEOUT_MS) : undefined;
      const oneShot = a?.oneShot === true ? true : undefined;
      return { to, goal, ...(timeoutMs ? { timeoutMs } : {}), ...(oneShot ? { oneShot } : {}) };
    },
    shape: (c) => ({ reply: c?.reply ?? null, failed: c?.failed === true }),
    delegates: true,
  },
};

/** The canonical method list. The worker stub (worker-source.js) and the
 * prompt lore are hand-written mirrors — the actors-api tests are what keep
 * them honest, not this constant (nothing generates from it). */
export const ACTORS_API_METHODS = Object.freeze(Object.keys(ACTORS_METHODS));

/** Does this method hand a goal to an actor (vs a read)? Pure. @param {string} method */
export const actorsMethodDelegates = (method) => ACTORS_METHODS[method]?.delegates === true;

/**
 * Translate an `actors.<method>(args)` call into a gated OP + validated args.
 * Throws ActorsApiError on an unknown method or bad args (rejects the worker call).
 * @param {{ method?: string, args?: any }} call
 * @returns {{ op: string, args: Record<string, any>, delegates: boolean }}
 */
export const actorsCallToOp = (call) => {
  const method = call?.method;
  const spec = typeof method === 'string' ? ACTORS_METHODS[method] : undefined;
  if (!spec) throw new ActorsApiError(`unknown actors method: ${String(method)}`);
  return { op: spec.op, args: spec.toArgs(call?.args ?? {}), delegates: spec.delegates === true };
};

/**
 * Shape a completed op's result back into the client return value. Throws
 * ActorsApiError when the op reported failure (so the awaited call rejects
 * with the SYSTEM reason — a gate refusal, a rate cap, a timeout).
 * @param {string} method @param {{ ok?: boolean, error?: string } & Record<string, any>} opResult
 */
export const shapeActorsResult = (method, opResult) => {
  const spec = ACTORS_METHODS[method];
  if (!spec) throw new ActorsApiError(`unknown actors method: ${String(method)}`);
  if (!opResult || opResult.ok !== true) {
    throw new ActorsApiError(opResult?.error ?? `actors.${method} failed`);
  }
  return spec.shape(opResult);
};

/**
 * Map a messageActor(awaitReply) settle into the ask op's wire result — the
 * security-relevant fork, extracted pure so it is provable:
 *   • timeout (this route's own timer) → a REFUSAL the script's await rejects
 *     with, naming the target + budget;
 *   • a SYSTEM refusal (messageActor's own 'message_actor:'-prefixed errors —
 *     sender gate, rate caps, duplicate intent, the oneShot sandbox rule) →
 *     rejected verbatim, so policy is felt as policy;
 *   • anything else in the error slot is the DELIVERED actor turn's own
 *     failure text → returned as { failed:true } for the script to handle
 *     in code (retry, fall back, report) instead of an exception.
 * A Stop-abort (the run signal fired, not this route's timer) must reject —
 * without the `aborted` fork it would masquerade as an actor-level failure
 * and a retry-in-code loop would grind through fully-audited post-Stop asks.
 * @param {{ ok: boolean, content?: string, error?: string }} r
 * @param {{ timedOut: boolean, aborted?: boolean, timeoutMs: number, to: string }} o
 * @returns {{ ok: true, reply: string | null, failed: boolean } | { ok: false, error: string }}
 */
export const askOutcome = (r, { timedOut, aborted, timeoutMs, to }) => {
  if (timedOut) return { ok: false, error: `actors.ask: timed out after ${timeoutMs}ms awaiting '${to}'` };
  if (aborted) return { ok: false, error: `actors.ask: aborted (Stop) while awaiting '${to}'` };
  if (r.ok) return { ok: true, reply: r.content ?? null, failed: false };
  const err = String(r.error ?? 'ask failed');
  if (err.startsWith('message_actor:')) return { ok: false, error: err };
  return { ok: true, reply: err, failed: true };
};

// ── the ops TRACE — the observability half of this surface ────────────────
//
// why: a script that delegates is otherwise a black box until it returns — the
// exact "leaner context cuts both ways" cost of the actor model. The job host
// records one entry per actors op (method, target, outcome, timing); these pure
// helpers shape that record and render the [DELEGATIONS] block the orchestrator
// reads back, so a failure names WHICH op, to WHOM, after HOW LONG — without
// re-ingesting any actor-supplied text outside the fence (error DETAIL strings
// may carry actor/web-derived bytes, so renderTraceLines keeps them out; the
// caller places them in the fenced body via traceErrorDetails).

/** @typedef {{ seq: number, method: string, to?: string, goal?: string, ok: boolean, ms: number, error?: string, settled?: boolean, actorFailed?: boolean }} ActorsTraceEntry */

const GOAL_PREVIEW_CHARS = 60;

// Fence-safe target: a chained call's `to` is a RUNTIME value (it can equal a
// prior actor reply — attacker-influenceable), so only handle-shaped
// characters survive outside the fence; anything else is elided. Same
// defensive posture as instance-handle's anchored id patterns.
/** @param {unknown} to @returns {string} */
const safeTarget = (to) => {
  if (typeof to !== 'string') return '';
  const clean = to.replace(/[^A-Za-z0-9_.:\/-]/g, '').slice(0, 48);
  return clean.length === to.length ? clean : `${clean}⁈`;
};

/**
 * Render the fence-SAFE trace lines: method + sanitized target + outcome +
 * timing per op — and NOTHING runtime-shaped beyond that. why no goal here:
 * a chained goal (`actors.ask(next, prior.reply)`) carries whatever the prior
 * actor (or a fetched page) said — exactly the bytes the fence exists for —
 * so goal previews render only INSIDE the fenced body (traceGoalLines), and
 * error detail likewise (traceErrorDetails). An op the run died around
 * (settled === false) says so instead of masquerading as an instant failure.
 * @param {ReadonlyArray<ActorsTraceEntry>} trace
 * @returns {string[]}
 */
export const renderTraceLines = (trace) =>
  trace.map((t) => {
    const target = t.to ? ` ${safeTarget(t.to)}` : '';
    const state = t.settled === false
      ? 'IN FLIGHT when the run ended (no reply seen)'
      : t.ok
        ? (t.actorFailed ? `replied — the actor REPORTED FAILURE ${t.ms}ms` : `ok ${t.ms}ms`)
        : `FAILED ${t.ms}ms`;
    return `  #${t.seq} ${t.method}${target} → ${state}`;
  });

/**
 * The goal previews, for the FENCED body: which text each op actually sent.
 * Runtime-shaped by design (chained goals carry prior replies), hence fenced.
 * @param {ReadonlyArray<ActorsTraceEntry>} trace
 * @returns {string[]}
 */
export const traceGoalLines = (trace) =>
  trace.filter((t) => typeof t.goal === 'string' && t.goal.length > 0).map((t) => {
    const g = /** @type {string} */ (t.goal);
    const preview = g.length > GOAL_PREVIEW_CHARS ? `${g.slice(0, GOAL_PREVIEW_CHARS)}…` : g;
    return `  #${t.seq} → "${preview}"`;
  });

/**
 * The error DETAILS for failed ops — these strings can carry actor/web-derived
 * bytes (an actor's failure reply), so the caller must place them INSIDE the
 * fenced body. [] when every op succeeded.
 * @param {ReadonlyArray<ActorsTraceEntry>} trace
 * @returns {string[]}
 */
export const traceErrorDetails = (trace) =>
  trace.filter((t) => !t.ok && t.error).map((t) => `  #${t.seq} ${t.method}${t.to ? ` ${safeTarget(t.to)}` : ''}: ${t.error}`);
