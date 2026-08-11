// @ts-check
// peerd-runtime/loop/prewalk — swap the frontier model for a cheap executor
// once a goal run's plan has survived contact with the world.
//
// The economics (can1357's "prewalk", stencil.so/blog/prewalk, 2026-07): an
// agent's bill is O(reads) — the expensive part is the frontier model READING
// its way to understanding, not the acting that follows. A /plan-style
// handoff (frontier plans in prose → cheap model executes) duplicates the
// reading at both prices and hands the executor a postcard instead of the
// journey. Prewalk hands off the CONTEXT WINDOW itself:
//
//   1. The goal run opens on the user's configured (frontier) model with a
//      hidden planning nudge appended to the system prompt: explore, then
//      commit the plan as a todo checklist, then take the first action.
//   2. The moment the first MUTATING tool call succeeds after the todo list
//      exists — the point where the plan met the world and held — the session
//      is marked phase:'executing'.
//   3. From the NEXT turn the session runs on the cheap executor model, and
//      the planning nudge is no longer rendered. The executor wakes inside a
//      trajectory it believes is its own: recon done, checklist ticking, one
//      valid move already landed — nothing in context looks like planning or
//      desperation, so it executes instead of re-deriving (or flailing).
//
// why turn-boundary (not mid-turn) swaps: each goal iteration is one agent
// turn, and the turn driver resolves model, pricing, reasoning, and context
// window fresh per turn — so a boundary swap gets accurate per-model cost
// attribution, no cross-model thinking-signature replay inside a live tool
// loop, and a correctly-sized trim window, all for free. The nudge herds the
// opening turn to end soon after the first action lands, so the boundary
// arrives quickly.
//
// Everything here is pure (Bun-tested); the IO — session reads/writes, the
// live goal-run check, audit — lives in the SW wiring (prewalk-controller.js)
// and turn-driver seams.
//
// KNOWN LIMITATION (low, off-by-default): the executor's first turn inherits
// the global reasoning setting. The cross-model thinking strip (agent-loop.js)
// removes the planner's signed thinking from replayed history, which is
// correct — but if a planning turn ends on a DANGLING tool_use (interrupted
// mid-dispatch) rather than the clean text end the nudge steers toward, the
// executor's first request could carry a thinking-stripped tool_use turn with
// reasoning on, which the API can 400. The common goal flow appends a fresh
// user continuation between turns (so the risk is narrow), and replaying the
// planner's signed thinking would 400 anyway — there is no strictly-better
// option inside the strip. Revisit if the executor first-turn ever needs
// reasoning forced off; today prewalk is opt-in and this edge is rare.

/**
 * Prewalk state, persisted on the session record for the run's lifetime.
 *
 * @typedef {Object} PrewalkState
 * @property {'planning' | 'executing'} phase
 * @property {string} plannerProvider   what to restore when the run ends
 * @property {string} plannerModel
 * @property {string} executorProvider
 * @property {string} executorModel
 * @property {number} armedAt
 * @property {number} [swappedAt]       set when the gate fires
 */

// The hidden planning instruction, appended to the system prompt ONLY while
// phase === 'planning' (turn-driver getSystemPrompt). Pruned by construction
// after the swap: the prompt is re-rendered every turn, so the executor never
// sees an instruction it would have to reconcile with mid-task context.
// Deliberately says nothing about models or swapping — the handoff is the
// harness's business, not the transcript's.
export const PREWALK_NUDGE = [
  '<goal_opening_discipline>',
  'For this goal, open with a tight plan-first sequence:',
  '1. Explore first (read-only) until you understand the task surface — but',
  '   keep it lean; stop exploring the moment you can commit to a plan.',
  '2. Commit the plan with todo_init: few, concrete steps, each with a',
  '   "validation" saying how you will verify it worked.',
  '3. Take the first concrete action toward item 1 immediately after.',
  '4. Once that first action lands, finish the step you are on and end your',
  '   turn — the loop continues automatically; do not front-load everything',
  '   into one turn.',
  '</goal_opening_discipline>',
].join('\n');

// Action classes that count as "the plan met the world": a successful call
// in one of these classes, after the todo list exists, fires the swap.
const SWAP_SIDE_EFFECTS = new Set(['write', 'mutate_external', 'destructive']);

// Bookkeeping and recon writes that must NOT fire the gate — they are not
// evidence the plan works. open_tab is Plan-mode-legal navigation (recon);
// remember is memory bookkeeping; wait_until is waiting; actor_cancel is
// cleanup; the todo/goal tools are the plan itself.
export const PREWALK_EXEMPT_TOOLS = Object.freeze(new Set([
  'open_tab', 'remember', 'wait_until', 'actor_cancel',
  'todo_init', 'todo_check', 'todo_add', 'complete_goal',
]));

/**
 * Resolve the executor (the cheap model the run swaps into). Resolution:
 *   1. the explicit Settings pin (prewalkExecutorModel), when set;
 *   2. the active provider's fast default (defaultRunnerModel — the same
 *      rung the web actor rides, e.g. Haiku on Anthropic).
 * Same-provider only for now: the transcript is provider-neutral, but keys,
 * failover chains and pricing are all provider-scoped — cross-provider
 * executors are a deliberate later step, not a config accident.
 *
 * @param {{ settings?: { prewalkExecutorModel?: string }, provider?: { name?: string, defaultRunnerModel?: string } }} inputs
 * @returns {{ provider: string, model: string } | null} null → nothing usable; don't arm
 */
export const resolvePrewalkExecutor = ({ settings, provider } = {}) => {
  const providerName = provider?.name ?? '';
  if (!providerName) return null;
  const pinned = typeof settings?.prewalkExecutorModel === 'string'
    ? settings.prewalkExecutorModel.trim() : '';
  const model = pinned || provider?.defaultRunnerModel || '';
  return model ? { provider: providerName, model } : null;
};

/**
 * Build the armed state for a fresh run, or null when arming is pointless
 * (no executor, or the executor IS the session's model — nothing to save).
 *
 * @param {{ provider?: string, model?: string }} session
 * @param {{ provider: string, model: string } | null} executor
 * @param {number} now
 * @returns {PrewalkState | null}
 */
export const armPrewalk = (session, executor, now) => {
  if (!executor || !session?.provider || !session?.model) return null;
  if (executor.provider === session.provider && executor.model === session.model) return null;
  return {
    phase: 'planning',
    plannerProvider: session.provider,
    plannerModel: session.model,
    executorProvider: executor.provider,
    executorModel: executor.model,
    armedAt: now,
  };
};

/**
 * The swap gate — fires exactly when the plan has met the world:
 * phase 'planning', the todo list exists, and a non-exempt mutating tool
 * call just SUCCEEDED. Pure; the caller persists the transition.
 *
 * @param {Object} inputs
 * @param {PrewalkState | null | undefined} inputs.prewalk
 * @param {number} inputs.todosCount      current session.todos length
 * @param {string} inputs.toolName
 * @param {string | undefined} inputs.sideEffect   the tool's declared class
 * @param {boolean} inputs.ok              did the call succeed
 * @returns {boolean}
 */
export const shouldPrewalkSwap = ({ prewalk, todosCount, toolName, sideEffect, ok }) => (
  !!prewalk
  && prewalk.phase === 'planning'
  && ok === true
  && todosCount > 0
  && !PREWALK_EXEMPT_TOOLS.has(toolName)
  && SWAP_SIDE_EFFECTS.has(sideEffect ?? '')
);

/**
 * The planning → executing transition. Pure.
 * @param {PrewalkState} prewalk
 * @param {number} now
 * @returns {PrewalkState}
 */
export const markPrewalkSwapped = (prewalk, now) => ({
  ...prewalk, phase: 'executing', swappedAt: now,
});

// ── engine-actor prewalk ────────────────────────────────────────────────────
// The three ENGINE actor kinds (VM/Notebook/App) are minted on the owner
// chat's (frontier) model — unlike the web actor, which is already on the
// cheap runner tier. Engine-actor prewalk keeps that frontier model for the
// actor's FIRST turn (plan + first action against the real instance state the
// orchestrator was blind to), then swaps to the cheap executor for every later
// turn. It's the same context-window handoff as the goal-run path, aimed at a
// different tier — and SIMPLER: no run-liveness coupling, no todo/mutating
// gate, and NO restore (a disposable, instance-bound actor lives out its life
// on the executor; when its instance is deleted the session goes with it).
//
// why turn-boundary (not first-action): an actor's model is fixed per turn, so
// the swap can only land BETWEEN turns. The first message_actor delegation is
// the plan-forming turn on the frontier model; the swap takes effect from the
// second delegation onward. A one-shot actor (a single delegation) never
// swaps and stays on the frontier — correct: there's no later turn to make
// cheaper, and nothing was lost.
export const ENGINE_ACTOR_KINDS = Object.freeze(new Set(['webvm', 'notebook', 'pod', 'app']));

/** @param {string} [kind] */
export const isEngineActorKind = (kind) => ENGINE_ACTOR_KINDS.has(kind ?? '');

/**
 * Should an armed engine actor swap to its executor now? True once it is PAST
 * its first turn (a prior assistant message exists in its session) and not yet
 * on the executor. Pure — the caller reads liveness from the session record.
 *
 * @param {Object} inputs
 * @param {PrewalkState | null | undefined} inputs.prewalk
 * @param {boolean} inputs.hasPriorAssistant  does the actor session already carry an assistant turn?
 * @param {string | undefined} inputs.provider  the session's current provider
 * @param {string | undefined} inputs.model     the session's current model
 * @returns {boolean}
 */
export const shouldEngineActorSwap = ({ prewalk, hasPriorAssistant, provider, model }) => (
  !!prewalk
  && hasPriorAssistant === true
  && (provider !== prewalk.executorProvider || model !== prewalk.executorModel)
);
