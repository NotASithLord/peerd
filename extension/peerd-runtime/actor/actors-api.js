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
//   • list / call — DELEGATION only. The script can call an actor to do
//     work and await the reply; it can never name a raw tool, spawn an actor,
//     or reach another capability through this bridge (the job host denies
//     everything undeclared, same posture as a2a).
//   • call addresses SANDBOX + WEB actors alike — authority is unchanged
//     because every op runs the full messageActor gate chain per call; oneShot
//     rides through and stays sandbox-only (enforced there, not re-implemented
//     here).
//
// Pure — values in, values out, no IO. The declarative manifest is its only
// import. The imperative shell (the
// worker bridge, the job-runner relay, the actors/call route) lives outside.

import { codeClientMethod, codeClientMethods } from './capability-manifest.js';
import {
  ACTORS_ADDRESS_MAX_CHARS,
  ACTORS_ASK_MAX_TIMEOUT_MS,
  ACTORS_GOAL_MAX_CHARS,
  ACTORS_TRACE_ERROR_MAX_CHARS,
} from '../../shared/actor-code-authority.js';

export {
  ACTORS_ADDRESS_MAX_CHARS,
  ACTORS_ASK_DEFAULT_TIMEOUT_MS,
  ACTORS_ASK_MAX_TIMEOUT_MS,
  ACTORS_GOAL_MAX_CHARS,
  ACTORS_RUN_MAX_OPS,
  ACTORS_TRACE_ERROR_MAX_CHARS,
  ACTORS_TRACE_TARGET_MAX_CHARS,
} from '../../shared/actor-code-authority.js';

/** A failed actors op REJECTS like a thrown call — so `await actors.call(...)` throws. */
export class ActorsApiError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'ActorsApiError'; }
}

/** @param {unknown} v @param {string} what @param {number} maxChars */
const boundedNonEmptyString = (v, what, maxChars) => {
  if (typeof v !== 'string') throw new ActorsApiError(`${what} must be a non-empty string`);
  // why length precedes trim: trim would scan and allocate from an attacker-sized
  // bridge value before the relay had enforced any resource boundary.
  if (v.length > maxChars) throw new ActorsApiError(`${what} must be at most ${maxChars} characters`);
  if (v.trim().length === 0) throw new ActorsApiError(`${what} must be a non-empty string`);
  return v;
};

/** Actor lists render numeric tab ids; normalize those handles at the code edge.
 * @param {unknown} v @param {string} what */
const actorAddress = (v, what) => {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return String(v);
  return boundedNonEmptyString(v, what, ACTORS_ADDRESS_MAX_CHARS);
};

// The timeout TOWER, defined once so it cannot drift apart (the nesting
// job wall-clock > worker bridge guard > per-call cap is what makes a stuck
// actor turn fail as a call timeout the script can handle, not a mid-run
// worker termination — same reasoning as a2a-run's timer note). Every layer
// DERIVES from the call ceiling: bump it and the tower moves together.
// Worker-controlled strings cross two heaps and are mirrored for crash
// recovery. Reject them at the shared translation edge before any trim/regex
// work, then retain only smaller bounded trace projections in each host.
// One run may compose many calls, but it is not an unbounded actor-message
// pump. Shared by the SW admission meter and the offscreen trace ring.
// The worker-side bridge guard — sits ABOVE the call cap so the SW's timeout
// (a handleable rejection) always fires before the bridge gives up.
export const ACTORS_BRIDGE_GUARD_MS = ACTORS_ASK_MAX_TIMEOUT_MS + 10_000;
// The job wall-clock for a delegating run — sits ABOVE the bridge guard.
export const ACTORS_JOB_DEFAULT_TIMEOUT_MS = ACTORS_BRIDGE_GUARD_MS + 20_000;
export const ACTORS_JOB_MAX_TIMEOUT_MS = ACTORS_BRIDGE_GUARD_MS + 50_000;

/**
 * @typedef {{ op: string, toArgs: (a: any) => object, shape: (c: any) => any, delegates?: boolean }} ActorsMethodSpec
 */

// The method table. `delegates:true` marks an op that hands a GOAL to an actor
// (call) — the SW route runs it through messageActor's full gate chain
// (sender gate, runaway caps, duplicate-intent, audit). `list` is the read-only
// roster (the actor_list catalog, dispatched through the normal tool gates).
/** @type {Record<string, ActorsMethodSpec>} */
const ACTORS_METHODS = {
  // Everything addressable right now — instances, open tabs, integrations —
  // with the address to pass to call. Read.
  list: {
    op: 'list',
    toArgs: () => ({}),
    shape: (c) => ({ refs: Array.isArray(c?.refs) ? c.refs : [] }),
  },
  // CALL — delegate a goal and await the actor's ONE reply within this run.
  // Returns { reply, failed } (failed:true = the actor's turn errored/aborted;
  // the reply text then describes the failure). A timeout REJECTS (throws).
  call: {
    op: 'call',
    toArgs: (a) => {
      const to = actorAddress(a?.address ?? a?.to, 'actors.call(address, message): address');
      const goal = boundedNonEmptyString(
        a?.message ?? a?.goal,
        'actors.call(address, message): message',
        ACTORS_GOAL_MAX_CHARS,
      );
      const timeoutMs = typeof a?.timeoutMs === 'number' && a.timeoutMs > 0
        ? Math.min(a.timeoutMs, ACTORS_ASK_MAX_TIMEOUT_MS) : undefined;
      const oneShot = a?.oneShot === true ? true : undefined;
      return { to, goal, ...(timeoutMs ? { timeoutMs } : {}), ...(oneShot ? { oneShot } : {}) };
    },
    shape: (c) => ({ reply: c?.reply ?? null, failed: c?.failed === true }),
    delegates: true,
  },
};

/** The canonical model-facing method list comes from the shared manifest. */
export const ACTORS_API_METHODS = Object.freeze(codeClientMethods('actors'));

/**
 * Translate an `actors.<method>(args)` call into a gated OP + validated args.
 * Throws ActorsApiError on an unknown method or bad args (rejects the worker call).
 * @param {{ method?: string, args?: any }} call
 * @returns {{ op: string, args: Record<string, any>, delegates: boolean }}
 */
export const actorsCallToOp = (call) => {
  const method = call?.method;
  const spec = typeof method === 'string' ? ACTORS_METHODS[method] : undefined;
  const declared = typeof method === 'string' ? codeClientMethod('actors', method) : undefined;
  if (!spec || !declared || declared.op !== spec.op) {
    const label = typeof method === 'string'
      ? (method.length > 64 ? '[oversized]' : method)
      : `[${typeof method}]`;
    throw new ActorsApiError(`unknown actors method: ${label}`);
  }
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

/** @typedef {{ seq: number, method: string, to?: string, goal?: string, ok: boolean, ms: number, error?: string, settled?: boolean, actorFailed?: boolean, cancelled?: boolean }} ActorsTraceEntry */

const GOAL_PREVIEW_CHARS = 60;
const TARGET_PREVIEW_CHARS = 60;

// A chained call's `to` is a RUNTIME value and can equal fetched or actor-
// supplied text. Character filtering cannot make that trusted: an instruction
// written with letters and underscores still looks handle-shaped. Only the two
// fixed singleton handles and numeric tab ids have no attacker-chosen language
// to expose. Every other target gets a host-authored marker outside the fence;
// its useful preview rides with the goal inside the fenced detail block.
/** @param {unknown} to @returns {string} */
const traceTargetLabel = (to) => {
  if (typeof to !== 'string' || to.length === 0) return '';
  if (to.length > 10) return '[target redacted]';
  return /^(?:web|dweb|(?:0|[1-9]\d{0,9}))$/.test(to) ? to : '[target redacted]';
};

/** Runtime target preview for callers that place the result inside a fence.
 * @param {unknown} to @returns {string} */
const fencedTargetPreview = (to) => {
  if (typeof to !== 'string') return '';
  // Slice before normalization so a hostile multi-megabyte target cannot make
  // trace formatting scan or allocate another copy of the whole value.
  const oneLine = to.slice(0, TARGET_PREVIEW_CHARS + 1).replace(/\s+/g, ' ').trim();
  return to.length > TARGET_PREVIEW_CHARS || oneLine.length > TARGET_PREVIEW_CHARS
    ? `${oneLine.slice(0, TARGET_PREVIEW_CHARS)}…`
    : oneLine;
};

/**
 * Render the fence-SAFE trace lines: method + fixed target label + outcome +
 * timing per op — and NOTHING runtime-shaped beyond that. why no goal here:
 * a chained goal (`actors.call(next, prior.reply)`) carries whatever the prior
 * actor (or a fetched page) said — exactly the bytes the fence exists for —
 * so goal previews render only INSIDE the fenced body (traceGoalLines), and
 * error detail likewise (traceErrorDetails). An op the run died around
 * (settled === false) says so instead of masquerading as an instant failure.
 * @param {ReadonlyArray<ActorsTraceEntry>} trace
 * @returns {string[]}
 */
export const renderTraceLines = (trace) =>
  trace.map((t) => {
    const target = t.to ? ` ${traceTargetLabel(t.to)}` : '';
    const state = t.settled === false
      ? 'IN FLIGHT when the run ended (no reply seen)'
      : t.cancelled
        ? `CANCELLED by Stop ${t.ms}ms`
        : t.ok
          ? (t.actorFailed ? `replied: the actor REPORTED FAILURE ${t.ms}ms` : `ok ${t.ms}ms`)
          : `FAILED ${t.ms}ms`;
    return `  #${t.seq} ${t.method}${target} → ${state}`;
  });

/**
 * The target + goal previews, for the FENCED body: which values each op sent.
 * Runtime-shaped by design (either can carry prior replies), hence fenced.
 * @param {ReadonlyArray<ActorsTraceEntry>} trace
 * @returns {string[]}
 */
export const traceGoalLines = (trace) =>
  trace.filter((t) => (typeof t.goal === 'string' && t.goal.length > 0)
    || (typeof t.to === 'string' && t.to.length > 0)).map((t) => {
    const g = typeof t.goal === 'string' ? t.goal : '';
    const preview = g.length > GOAL_PREVIEW_CHARS ? `${g.slice(0, GOAL_PREVIEW_CHARS)}…` : g;
    const target = fencedTargetPreview(t.to);
    return `  #${t.seq}${target ? ` target="${target}"` : ''}${g ? ` → "${preview}"` : ''}`;
  });

/**
 * The error DETAILS for failed ops — these strings can carry actor/web-derived
 * bytes (an actor's failure reply), so the caller must place them INSIDE the
 * fenced body. [] when every op succeeded.
 * @param {ReadonlyArray<ActorsTraceEntry>} trace
 * @returns {string[]}
 */
export const traceErrorDetails = (trace) =>
  trace.filter((t) => !t.ok && t.error).map((t) => {
    const target = fencedTargetPreview(t.to);
    const error = String(t.error).slice(0, ACTORS_TRACE_ERROR_MAX_CHARS);
    return `  #${t.seq} ${t.method}${target ? ` target="${target}"` : ''}: ${error}`;
  });
