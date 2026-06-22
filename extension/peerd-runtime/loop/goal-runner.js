// @ts-check
// peerd-runtime/loop/goal-runner — "Goal mode": keep running normal agent
// turns in the MAIN session until the agent declares the goal met (the
// complete_goal tool), or a safety cap / the user's Stop ends it.
//
// This is the SIMPLE loop the mode-row Goal toggle drives — NOT a hidden
// subagent or a plan file (that was the Ralph misread). It just re-enters the
// ordinary agent turn:
//   - turn 1 is the user's goal text (a REAL, visible message);
//   - every later turn is a hidden `synthetic` continuation nudge, so the
//     chat reads like a normal session that simply doesn't stop to wait for
//     you — reasoning + tool calls stream inline exactly as always.
// The agent ends the run by calling complete_goal (revealed only while a run
// is active — see tools/exposure.js). A hard iteration cap and the Stop
// button are the backstops behind "until it's done".
//
// Run state is in-memory, keyed by session id. A goal run surviving an SW
// restart is a deliberate non-goal for v1: the cap + Stop carry the safety,
// and a restart simply ends the run (the user re-arms). Functional-core /
// imperative-shell: `runTurn` (runAgentTurn) and `onEvent` are injected, so
// the control logic is otherwise pure and unit-testable with fakes.

// Hard backstop on autonomous turns — generous for real multi-step work,
// still a wall against a run that never calls complete_goal. The Stop button
// and complete_goal are the normal exits; this only catches a stuck agent.
export const GOAL_MAX_ITERATIONS = 40;

/**
 * The hidden continuation nudge sent as turns 2..N. Frames the autonomy
 * contract and points the agent at complete_goal. The goal text is repeated
 * verbatim so a long run never loses the north star (each turn's history is
 * trimmed independently).
 * @param {string} goal
 */
export const goalContinuationPrompt = (goal) => [
  'Continue working autonomously toward this goal:',
  '',
  goal,
  '',
  'Take the next concrete step now. Do NOT stop to ask me for confirmation or',
  'permission — keep going. When (and ONLY when) the goal is FULLY achieved,',
  'call the complete_goal tool with a one-line summary. If you are genuinely',
  'blocked and cannot make progress, call complete_goal and say why.',
].join('\n');

/**
 * One in-flight goal run.
 * @typedef {Object} GoalRun
 * @property {string} goal
 * @property {number} iteration     completed-turn counter
 * @property {boolean} completed    complete_goal was called
 * @property {boolean} halted       user Stop / a steering message took over
 * @property {string|null} summary  complete_goal's summary, if any
 * @property {number} startedAt
 */

/**
 * @param {Object} deps
 * @param {(args: { sessionId: string, userText: string, synthetic: boolean }) => Promise<any>} deps.runTurn
 *   One full agent turn (runAgentTurn). complete()/halt() may fire DURING it
 *   (the complete_goal tool, or a Stop), which the loop checks after it returns.
 * @param {(ev: object) => void} [deps.onEvent]   goal/* status → the side panel
 * @param {number} [deps.maxIterations]
 * @param {() => number} [deps.now]
 */
export const makeGoalRunner = ({ runTurn, onEvent = () => {}, maxIterations = GOAL_MAX_ITERATIONS, now = Date.now }) => {
  /** @type {Map<string, GoalRun>} */
  const runs = new Map();

  /** @param {string} sid @returns {GoalRun | null} */
  const get = (sid) => runs.get(sid) ?? null;
  /** @param {string} sid */
  const isActive = (sid) => { const r = runs.get(sid); return !!r && !r.completed && !r.halted; };

  /**
   * complete_goal hook: the agent declared the goal met. Returns whether there
   * was a LIVE run to end (false → the tool was called outside an active run).
   * @param {string} sid @param {string} [summary] @returns {boolean}
   */
  const complete = (sid, summary) => {
    const r = runs.get(sid);
    if (!r || r.completed || r.halted) return false;
    r.completed = true;
    r.summary = typeof summary === 'string' && summary ? summary : null;
    return true;
  };
  /** Stop / steer-takeover: end the run without declaring success. @param {string} sid */
  const halt = (sid) => { const r = runs.get(sid); if (r) r.halted = true; };

  /** @param {string} sid @param {'running'|'done'|'halted'|'capped'} phase */
  const emit = (sid, phase) => {
    const r = runs.get(sid);
    onEvent({
      type: 'goal/state', sessionId: sid, phase,
      active: phase === 'running',
      iteration: r?.iteration ?? 0, maxIterations,
      goal: r?.goal ?? '', summary: r?.summary ?? null,
    });
  };

  /** Run turns until complete / halted / capped, then clean up. @param {string} sid */
  const drive = async (sid) => {
    const run = runs.get(sid);
    if (!run) return;
    // why identity check (not just isActive): a fresh start() for the SAME
    // session replaces the map entry and halts THIS one — the old drive must
    // see it's been superseded and exit WITHOUT deleting the new run.
    const alive = () => runs.get(sid) === run && !run.completed && !run.halted;
    try {
      while (alive() && run.iteration < maxIterations) {
        const first = run.iteration === 0;
        run.iteration += 1;
        emit(sid, 'running');
        await runTurn({
          sessionId: sid,
          userText: first ? run.goal : goalContinuationPrompt(run.goal),
          // turn 1 is the user's real goal message; continuations are hidden.
          synthetic: !first,
        });
      }
    } finally {
      if (runs.get(sid) === run) {
        const phase = run.completed ? 'done' : run.halted ? 'halted'
          : run.iteration >= maxIterations ? 'capped' : 'done';
        emit(sid, phase);
        runs.delete(sid);
      }
    }
  };

  /**
   * Start (or supersede) a goal run for a session. Fire-and-forget — returns
   * immediately; the turns stream over the port like any chat.
   * @param {{ sessionId: string, goal: string }} req
   */
  const start = async ({ sessionId, goal }) => {
    if (!sessionId || typeof goal !== 'string' || !goal.trim()) {
      return { ok: false, error: 'goal-required' };
    }
    if (runs.has(sessionId)) halt(sessionId);  // supersede any prior run
    runs.set(sessionId, {
      goal: goal.trim(), iteration: 0, completed: false, halted: false,
      summary: null, startedAt: now(),
    });
    drive(sessionId).catch((e) => {
      console.error('[goal] drive threw', e);
      halt(sessionId);
    });
    return { ok: true };
  };

  return Object.freeze({ start, halt, complete, isActive, get, drive });
};
