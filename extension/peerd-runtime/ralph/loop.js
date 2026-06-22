// @ts-check
// Ralph loop controller — spawns FRESH-CONTEXT iterations against a plan
// file until the plan is exhausted (or the user halts).
//
// The discipline (Geoffrey Huntley's Ralph; Anthropic /loop; Hermes
// /goal): persistence lives in the plan file + git/checkpoints, NEVER in
// a long-lived context window. Each iteration is a clean slate:
//
//   read plan → pick ONE task → spawn fresh-context run to do it →
//   run backpressure gates → commit (checkpoint) → DISCARD context → next
//
// ── SW-restart resumability (the load-bearing property) ──────────────
// MV3 service workers die after ~30s idle. The loop must survive that.
// We persist a tiny LoopState record to kv after EVERY state transition,
// and each iteration is independently resumable from it:
//   - the plan file itself holds the in-progress `[~]` marker (crash-safe
//     single-writer lock), so a half-done task is re-done from scratch
//     with fresh context, never half-committed.
//   - `runRalphLoop` is re-entrant: on cold start the SW calls
//     `resumeRalphLoop`, which rehydrates LoopState and continues the
//     SAME run from the next iteration. No context is rehydrated — only
//     the plan + a cursor. That IS the point.
//
// Functional core: `ralphReducer` + status helpers are PURE. The shell
// `runRalphLoop` does the IO (persist state, spawn run, run gates,
// checkpoint) and is driven one iteration at a time so it can be paused
// and resumed across SW lifetimes.

import {
  parsePlan, serializePlan, pickNextTask, completeTask, failTask,
  isPlanExhausted, planSummary,
} from './plan-store.js';

/**
 * @typedef {Object} LoopState
 * @property {string} runId
 * @property {'idle'|'planning'|'building'|'paused'|'done'|'halted'|'error'} status
 * @property {number} iteration            completed-iteration counter
 * @property {number} maxIterations        hard backstop (anti-runaway)
 * @property {string|null} currentTaskId
 * @property {string|null} lastError
 * @property {number} startedAt
 * @property {number} updatedAt
 */

// Hard backstop: even with a plan that keeps re-blocking, never spin
// forever. One iteration ≈ one task attempt; 200 is generous for any
// real plan and still catches a pathological loop.
export const MAX_ITERATIONS = 200;

/** @param {Partial<LoopState>} [init] @returns {LoopState} */
export const initLoopState = (init = {}) => ({
  runId: init.runId ?? `ralph-${Date.now()}`,
  status: init.status ?? 'idle',
  iteration: init.iteration ?? 0,
  maxIterations: Math.min(init.maxIterations ?? MAX_ITERATIONS, MAX_ITERATIONS),
  currentTaskId: init.currentTaskId ?? null,
  lastError: init.lastError ?? null,
  startedAt: init.startedAt ?? Date.now(),
  updatedAt: init.updatedAt ?? Date.now(),
});

// ── PURE reducer: given current state + plan, what is the next step? ──
//
// Returns a decision the shell acts on. Keeping this pure makes the
// "what should happen next" logic exhaustively testable without any IO.

/**
 * @typedef {{ kind:'plan' }
 *        | { kind:'execute', taskId:string }
 *        | { kind:'done' }
 *        | { kind:'halted' }
 *        | { kind:'exhausted-iterations' }} LoopDecision
 */

/**
 * @param {LoopState} state
 * @param {import('./plan-store.js').Plan} plan
 * @param {{ halt?: boolean }} [signals]
 * @returns {LoopDecision}
 */
export const decideNext = (state, plan, signals = {}) => {
  if (signals.halt || state.status === 'halted') return { kind: 'halted' };
  if (state.iteration >= state.maxIterations) return { kind: 'exhausted-iterations' };
  // Planning mode runs exactly one gap-analysis pass to produce/refresh
  // the plan, then flips to building.
  if (plan.mode === 'planning') return { kind: 'plan' };
  if (isPlanExhausted(plan)) return { kind: 'done' };
  const { task } = pickNextTask(plan);
  if (!task) return { kind: 'done' };
  return { kind: 'execute', taskId: task.id };
};

// ── IMPERATIVE SHELL ─────────────────────────────────────────────────

export const LOOP_STATE_KEY = 'ralph.loop.v1';

/**
 * Build a Ralph loop bound to its IO dependencies. Mirrors makeSpawnSubagent:
 * every external surface is INJECTED so the controller is unit-testable
 * with mocked gates + a fake fresh-context runner.
 *
 * @param {Object} deps
 * @param {ReturnType<typeof import('./plan-store.js').createPlanStore>} deps.planStore
 * @param {{ get(k:string):Promise<any>, set(k:string,v:any):Promise<void>, delete(k:string):Promise<void> }} deps.kv
 *   Persists LoopState (the resumability seam).
 * @param {(req: { task:string, goal:string, mode:'planning'|'building' }) => Promise<{ ok:boolean, text:string, plan?:string }>} deps.runFresh
 *   Spawn ONE fresh-context iteration. ADAPTER over the agent loop /
 *   subagent orchestrator: a clean session, the plan goal + the single
 *   task as the prompt, no carried context. In planning mode it returns
 *   a `plan` string (the new plan file); in building mode it just does
 *   the work and returns its final text.
 * @param {{ run(ctx:object): Promise<{ pass:boolean, results:any[] }> }} deps.gateRunner
 *   The pluggable backpressure gates. ADAPTER for feature 10 hooks.
 * @param {() => object} deps.gateContext   produce the per-iteration GateContext (vmExec/inspect)
 * @param {(msg: string) => Promise<{ ok:boolean, ref?:string }>} deps.checkpoint
 *   Commit the iteration's work. ADAPTER for feature 02 (git in WebVM or
 *   peerd's checkpoint store). Called only AFTER gates pass.
 * @param {() => Promise<boolean>} [deps.canRunUnattended]
 *   ADAPTER for feature 03 permissions: Ralph requires Act mode with
 *   confirmActions OFF (it commits unattended — nothing may pause for a
 *   confirm round-trip). Refuses to start otherwise.
 * @param {(ev: object) => void} [deps.onEvent]    status surface for the UI
 * @param {() => boolean} [deps.shouldHalt]        user-halt check (reuses activeAbortController)
 * @param {() => number} [deps.now]
 * @param {number} [deps.maxAttempts]              gate-failure retries per task before blocking
 */
export const createRalphLoop = (deps) => {
  const {
    planStore, kv, runFresh, gateRunner, gateContext,
    checkpoint, canRunUnattended, onEvent = () => {},
    shouldHalt = () => false, now = Date.now, maxAttempts = 3,
  } = deps;

  /** @param {LoopState} state */
  const persist = async (state) => {
    state.updatedAt = now();
    await kv.set(LOOP_STATE_KEY, state);
    onEvent({ type: 'ralph/state', state, summary: planSummary(await planStore.load()) });
    return state;
  };

  const loadState = async () => {
    const raw = await kv.get(LOOP_STATE_KEY);
    return raw ? initLoopState(raw) : null;
  };

  /**
   * Run ONE iteration and persist the resulting state. Returns the
   * decision kind so the driver knows whether to continue. This is the
   * unit of SW-restart resumability: if the SW dies right after this
   * returns, the persisted state + plan file let the next cold start
   * pick up exactly here.
   *
   * @param {LoopState} state
   * @returns {Promise<{ state: LoopState, decision: import('./loop.js').LoopDecision }>}
   */
  const runIteration = async (state) => {
    const plan = await planStore.load();
    const decision = decideNext(state, plan, { halt: shouldHalt() });

    if (decision.kind === 'halted') {
      state.status = 'halted';
      onEvent({ type: 'ralph/halted', runId: state.runId });
      return { state: await persist(state), decision };
    }
    if (decision.kind === 'exhausted-iterations') {
      state.status = 'error';
      state.lastError = `hit maxIterations (${state.maxIterations})`;
      onEvent({ type: 'ralph/error', error: state.lastError });
      return { state: await persist(state), decision };
    }
    if (decision.kind === 'done') {
      state.status = 'done';
      state.currentTaskId = null;
      onEvent({ type: 'ralph/done', runId: state.runId, summary: planSummary(plan) });
      return { state: await persist(state), decision };
    }

    // ── PLANNING mode: gap analysis → write/refresh the plan file ──────
    if (decision.kind === 'plan') {
      state.status = 'planning';
      await persist(state);
      onEvent({ type: 'ralph/iteration', phase: 'planning', iteration: state.iteration });
      const out = await runFresh({ task: 'PLAN', goal: plan.goal, mode: 'planning' });
      if (out.ok && typeof out.plan === 'string') {
        // The fresh planner returns a full plan file; flip it to building
        // so the next iteration starts executing.
        const next = parsePlan(out.plan);
        next.mode = 'building';
        await planStore.save(next);
      } else {
        // No plan produced — flip the existing plan to building so we
        // don't loop forever in planning.
        await planStore.save({ ...plan, mode: 'building' });
      }
      state.iteration += 1;
      state.status = 'building';
      return { state: await persist(state), decision };
    }

    // ── BUILDING mode: execute ONE task ────────────────────────────────
    state.status = 'building';
    // Persist the in-progress marker to the PLAN FILE first — that is the
    // crash-safe single-writer lock. pickNextTask already flipped it.
    const picked = pickNextTask(plan);
    await planStore.save(picked.plan);
    state.currentTaskId = decision.taskId;
    await persist(state);

    // why: the 'execute' decision is only returned when decideNext's own
    // pickNextTask found a task; this second deterministic pick on the same
    // plan yields the same one, so task is non-null here (TS can't see it).
    const task = /** @type {import('./plan-store.js').PlanTask} */ (picked.task);
    onEvent({ type: 'ralph/iteration', phase: 'building', iteration: state.iteration, taskId: task.id, title: task.title });

    // 1. Fresh-context run does the work.
    const out = await runFresh({ task: task.title, goal: plan.goal, mode: 'building' });

    // 2. Backpressure gates (WebVM lint/test/build + browser-native).
    const gateOutcome = await gateRunner.run({ ...gateContext(), now });
    onEvent({ type: 'ralph/gates', taskId: task.id, pass: gateOutcome.pass, results: gateOutcome.results });

    // 3a. Gate FAILURE → block the commit, retry with fresh context or
    //     mark blocked after maxAttempts. (Never commit a failed gate.)
    const runFailed = !out.ok;
    if (!gateOutcome.pass || runFailed) {
      const reason = !gateOutcome.pass
        ? (gateOutcome.results.find((r) => !r.pass)?.detail ?? 'gate failed')
        : (out.text || 'iteration run failed');
      const fresh = await planStore.load();
      const { plan: nextPlan, blocked } = failTask(fresh, task.id, reason, maxAttempts);
      await planStore.save(nextPlan);
      state.iteration += 1;
      state.currentTaskId = null;
      if (blocked) onEvent({ type: 'ralph/blocked', taskId: task.id, reason });
      else onEvent({ type: 'ralph/retry', taskId: task.id, reason });
      return { state: await persist(state), decision };
    }

    // 3b. Gates PASS → commit, mark done, discard context, next.
    const ck = await checkpoint(`ralph: ${task.title}`);
    const fresh = await planStore.load();
    await planStore.save(completeTask(fresh, task.id));
    state.iteration += 1;
    state.currentTaskId = null;
    onEvent({ type: 'ralph/committed', taskId: task.id, ref: ck?.ref, title: task.title });
    return { state: await persist(state), decision };
  };

  /**
   * Start a NEW run from idle. Refuses unless the session is Act mode
   * with confirmActions OFF (feature 03 adapter) — Ralph commits
   * unattended, so nothing may pause for a confirm round-trip.
   *
   * @param {{ maxIterations?: number, mode?: 'planning'|'building' }} [opts]
   */
  const start = async (opts = {}) => {
    if (canRunUnattended) {
      const ok = await canRunUnattended();
      if (!ok) {
        onEvent({ type: 'ralph/refused', reason: 'requires Act mode with confirmations off' });
        return { ok: false, error: 'confirmations-on' };
      }
    }
    const state = initLoopState({ runId: `ralph-${now()}`, status: 'building', maxIterations: opts.maxIterations, startedAt: now() });
    // Optionally force a planning pass up front.
    if (opts.mode === 'planning') {
      const plan = await planStore.load();
      await planStore.save({ ...plan, mode: 'planning' });
    }
    await persist(state);
    onEvent({ type: 'ralph/started', runId: state.runId });
    return { ok: true, runId: state.runId };
  };

  /**
   * Drive the loop forward. Each call runs iterations until a terminal
   * state OR `budget` iterations elapse (the SW calls this with a small
   * budget per keepalive tick so one drive can't exceed the 30s window;
   * the persisted state lets the next tick resume). Returns the final
   * state for this drive.
   *
   * @param {{ budget?: number }} [opts]
   */
  const drive = async (opts = {}) => {
    const budget = opts.budget ?? Infinity;
    let state = await loadState();
    if (!state) return { ok: false, error: 'no-active-run' };
    let driven = 0;
    while (driven < budget) {
      if (state.status === 'done' || state.status === 'halted' || state.status === 'error') break;
      if (shouldHalt()) { state.status = 'halted'; await persist(state); break; }
      const res = await runIteration(state);
      state = res.state;
      driven++;
      if (res.decision.kind === 'done' || res.decision.kind === 'halted' || res.decision.kind === 'exhausted-iterations') break;
    }
    return { ok: true, state };
  };

  /**
   * Rehydrate after a SW restart and continue. No context is restored —
   * only LoopState + the plan file. If there is no active (non-terminal)
   * run, it's a no-op. This is what the SW calls on cold start.
   */
  const resume = async (opts = {}) => {
    const state = await loadState();
    if (!state) return { ok: false, error: 'no-state' };
    if (state.status === 'done' || state.status === 'halted' || state.status === 'error' || state.status === 'idle') {
      return { ok: false, error: 'terminal', state };
    }
    onEvent({ type: 'ralph/resumed', runId: state.runId, iteration: state.iteration });
    return drive(opts);
  };

  const halt = async () => {
    const state = await loadState();
    if (!state) return { ok: false, error: 'no-state' };
    state.status = 'halted';
    await persist(state);
    onEvent({ type: 'ralph/halted', runId: state.runId });
    return { ok: true };
  };

  const status = async () => {
    const state = await loadState();
    const plan = await planStore.load();
    return { state, plan, summary: planSummary(plan) };
  };

  const reset = async () => { await kv.delete(LOOP_STATE_KEY); };

  return Object.freeze({ start, drive, resume, halt, status, reset, runIteration, loadState });
};
