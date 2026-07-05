// @ts-check
// actors-api.js — the PURE translation core for the ORCHESTRATOR's code
// surface over its own actors: `peerd.actors.*` inside the `script` tool.
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
//   • list / ask / send — DELEGATION only. The script can ask an actor to do
//     work and await the reply; it can never name a raw tool, spawn a subagent,
//     or reach another capability through this bridge (the job host denies
//     everything undeclared, same posture as a2a).
//   • ask/send address SANDBOX + WEB actors alike — authority is unchanged
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

// The per-ask ceiling. Sits UNDER the worker bridge guard and the job
// wall-clock (script.js keeps the nesting job > bridge > ask, same reasoning
// as a2a-run's timer note) so a stuck actor turn fails as an ask timeout the
// script can handle, not a mid-run worker termination.
export const ACTORS_ASK_MAX_TIMEOUT_MS = 240_000;
export const ACTORS_ASK_DEFAULT_TIMEOUT_MS = 120_000;

/**
 * @typedef {{ op: string, toArgs: (a: any) => object, shape: (c: any) => any, delegates?: boolean }} ActorsMethodSpec
 */

// The method table. `delegates:true` marks an op that hands a GOAL to an actor
// (ask/send) — the SW route runs those through messageActor's full gate chain
// (sender gate, runaway caps, duplicate-intent, audit). `list` is the read-only
// roster (the actor_list catalog, dispatched through the normal tool gates).
/** @type {Record<string, ActorsMethodSpec>} */
const ACTORS_METHODS = {
  // Everything addressable right now — instances, open tabs, integrations —
  // with the handle to pass as ask/send's `to`. Read.
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
      const to = nonEmptyString(a?.to, 'actors.ask(to, goal): to');
      const goal = nonEmptyString(a?.goal, 'actors.ask(to, goal): goal');
      const timeoutMs = typeof a?.timeoutMs === 'number' && a.timeoutMs > 0
        ? Math.min(a.timeoutMs, ACTORS_ASK_MAX_TIMEOUT_MS) : undefined;
      const oneShot = a?.oneShot === true ? true : undefined;
      return { to, goal, ...(timeoutMs ? { timeoutMs } : {}), ...(oneShot ? { oneShot } : {}) };
    },
    shape: (c) => ({ reply: c?.reply ?? null, failed: c?.failed === true }),
    delegates: true,
  },
  // TELL — fire-and-forget: hand the goal off and keep running. The actor's
  // reply routes to the CHAT as a normal fenced actor note on a later turn
  // (attributed to this script's tool call), not into this run.
  send: {
    op: 'send',
    toArgs: (a) => ({
      to: nonEmptyString(a?.to, 'actors.send(to, goal): to'),
      goal: nonEmptyString(a?.goal, 'actors.send(to, goal): goal'),
      ...(a?.oneShot === true ? { oneShot: true } : {}),
    }),
    shape: (c) => ({ sent: c?.ok === true }),
    delegates: true,
  },
};

/** The method names — drives the worker stub + the lore. */
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
 * @param {{ ok: boolean, content?: string, error?: string }} r
 * @param {{ timedOut: boolean, timeoutMs: number, to: string }} o
 * @returns {{ ok: true, reply: string | null, failed: boolean } | { ok: false, error: string }}
 */
export const askOutcome = (r, { timedOut, timeoutMs, to }) => {
  if (timedOut) return { ok: false, error: `actors.ask: timed out after ${timeoutMs}ms awaiting '${to}'` };
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

/** @typedef {{ seq: number, method: string, to?: string, goal?: string, ok: boolean, ms: number, error?: string }} ActorsTraceEntry */

const GOAL_PREVIEW_CHARS = 60;

/**
 * Render the fence-SAFE trace lines: outcome + timing per op, with the goal
 * previewed (it is MODEL-authored — the model wrote the script — so it is safe
 * outside the fence), never the error detail (which may carry actor-derived
 * bytes). [] for an empty trace.
 * @param {ReadonlyArray<ActorsTraceEntry>} trace
 * @returns {string[]}
 */
export const renderTraceLines = (trace) =>
  trace.map((t) => {
    const target = t.to ? ` ${t.to}` : '';
    const preview = typeof t.goal === 'string'
      ? (t.goal.length > GOAL_PREVIEW_CHARS ? `${t.goal.slice(0, GOAL_PREVIEW_CHARS)}…` : t.goal)
      : '';
    const goal = preview ? ` "${preview}"` : '';
    return `  #${t.seq} ${t.method}${target}${goal} → ${t.ok ? 'ok' : 'FAILED'} ${t.ms}ms`;
  });

/**
 * The error DETAILS for failed ops — these strings can carry actor/web-derived
 * bytes (an actor's failure reply), so the caller must place them INSIDE the
 * fenced body. [] when every op succeeded.
 * @param {ReadonlyArray<ActorsTraceEntry>} trace
 * @returns {string[]}
 */
export const traceErrorDetails = (trace) =>
  trace.filter((t) => !t.ok && t.error).map((t) => `  #${t.seq} ${t.method}${t.to ? ` ${t.to}` : ''}: ${t.error}`);
