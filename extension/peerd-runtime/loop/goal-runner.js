// @ts-check
// peerd-runtime/loop/goal-runner — "Goal mode": keep running normal agent
// turns in the MAIN session until the agent declares the goal met (the
// complete_goal tool), or a safety cap / the user's Stop ends it.
//
// This is the loop the mode-row Goal toggle drives — just the ordinary agent
// turn, re-entered:
//   - turn 1 is the user's goal text (a REAL, visible message);
//   - every later turn is a hidden `synthetic` continuation nudge, so the
//     chat reads like a normal session that simply doesn't stop to wait for
//     you — reasoning + tool calls stream inline exactly as always.
// The agent ends the run by calling complete_goal (revealed only while a run
// is active — see tools/exposure.js). A hard iteration cap and the Stop
// button are the backstops behind "until it's done".
//
// Run state is keyed by session id and MIRRORED to storage (the injected kv),
// so a run survives an SW restart and keeps going while the user is in another
// chat: resume() (called on vault unlock) re-drives any persisted active run.
// Each chat owns at most one run. Functional-core / imperative-shell: `runTurn`
// (runAgentTurn), `onEvent`, and `kv` are injected, so the control logic is
// otherwise pure and unit-testable with fakes (kv optional → pure in-memory).

// Hard backstop on autonomous turns — generous for real multi-step work,
// still a wall against a run that never calls complete_goal. The Stop button
// and complete_goal are the normal exits; this only catches a stuck agent.
export const GOAL_MAX_ITERATIONS = 40;

// storage.local key holding the active runs map ({ [sessionId]: persisted run }),
// the durable mirror resume() reads on SW boot.
export const GOAL_RUNS_KEY = 'goal.runs.v1';

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
 * @param {{ get(k:string):Promise<any>, set(k:string,v:any):Promise<void>, delete(k:string):Promise<void> }} [deps.kv]
 *   Durable mirror of the active runs (storage.local). Omit for pure in-memory
 *   (tests): persistence + resume become no-ops.
 * @param {number} [deps.maxIterations]
 * @param {() => number} [deps.now]
 */
export const makeGoalRunner = ({ runTurn, onEvent = () => {}, kv, maxIterations = GOAL_MAX_ITERATIONS, now = Date.now }) => {
  /** @type {Map<string, GoalRun>} */
  const runs = new Map();

  // Mirror the live (non-terminal) runs to storage. Fire-and-forget: the
  // in-memory map is authoritative within an SW lifetime; this is the seam that
  // lets resume() pick up after a restart. Best-effort — a write failure just
  // means that run won't resume, not that the live run breaks.
  const persist = () => {
    if (!kv) return;
    /** @type {Record<string, { goal: string, iteration: number, startedAt: number }>} */
    const out = {};
    for (const [sid, r] of runs) {
      if (r.completed || r.halted) continue;
      out[sid] = { goal: r.goal, iteration: r.iteration, startedAt: r.startedAt };
    }
    Promise.resolve(kv.set(GOAL_RUNS_KEY, out)).catch(() => {});
  };

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
    persist();  // drop it from the durable mirror so it won't resume
    return true;
  };
  /** Stop / steer-takeover: end the run without declaring success. @param {string} sid */
  const halt = (sid) => { const r = runs.get(sid); if (r) { r.halted = true; persist(); } };

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
        persist();  // record the iteration about to run, so a crash resumes here
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
        persist();  // terminal — clear it from the durable mirror
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
    persist();
    drive(sessionId).catch((e) => {
      console.error('[goal] drive threw', e);
      halt(sessionId);
    });
    return { ok: true };
  };

  /**
   * Re-drive any persisted active runs after an SW restart (called once the
   * vault is unlocked — a turn needs the key). Each rehydrated run continues
   * from its persisted iteration (so it sends a synthetic continuation, not a
   * fresh goal). A no-op without kv or with nothing stored. Idempotent: skips a
   * session that already has a live run.
   * @returns {Promise<{ resumed: number }>}
   */
  const resume = async () => {
    if (!kv) return { resumed: 0 };
    let stored;
    try { stored = await kv.get(GOAL_RUNS_KEY); } catch { return { resumed: 0 }; }
    if (!stored || typeof stored !== 'object') return { resumed: 0 };
    let resumed = 0;
    for (const [sid, raw] of Object.entries(stored)) {
      if (!sid || runs.has(sid)) continue;
      const rec = /** @type {{ goal?: unknown, iteration?: unknown, startedAt?: unknown }} */ (raw);
      if (!rec || typeof rec.goal !== 'string' || !rec.goal) continue;
      runs.set(sid, {
        goal: rec.goal,
        iteration: Number(rec.iteration) || 0,
        completed: false, halted: false, summary: null,
        startedAt: Number(rec.startedAt) || now(),
      });
      drive(sid).catch((e) => { console.error('[goal] resume drive threw', e); halt(sid); });
      resumed += 1;
    }
    return { resumed };
  };

  return Object.freeze({ start, halt, complete, isActive, get, drive, resume });
};
