// @ts-check
// Goal mode continues a chat until completion, Stop, or the turn limit.
// The first turn shows the user's goal. Later turns use hidden continuations.
// why: Stored state permits recovery after worker loss. Stop must remove it.
// Each chat owns one run. IO enters through runTurn, onEvent, and kv.

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
 * trimmed independently) — and the live todo list rides along for the same
 * reason: the plan-of-record is re-surfaced every turn, so the model (or the
 * cheaper model prewalk swapped in) steers by the checklist instead of by
 * memory of it.
 * @param {string} goal
 * @param {string} [todoBlock]  formatTodoBlock(session.todos); '' when no list
 */
export const goalContinuationPrompt = (goal, todoBlock = '') => [
  'Continue working autonomously toward this goal:',
  '',
  goal,
  ...(todoBlock ? ['', todoBlock, '', 'Work the next unchecked item; call todo_check the moment its validation passes.'] : []),
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
 * @property {boolean} halted       Stop / steer-takeover / a failed turn
 * @property {boolean} [paused]     a hard throw (e.g. vault locked) — keep the
 *   persisted record so resume() re-drives after unlock; not terminal
 * @property {string|null} summary  complete_goal's summary, if any
 * @property {string|null} [lastError]  why it halted (for the terminal note)
 * @property {number} startedAt
 */

/**
 * @param {Object} deps
 * @param {(args: { sessionId: string, userText: string, synthetic: boolean, trusted?: boolean }) => Promise<{ ok?: boolean, stopReason?: string } | void>} deps.runTurn
 *   One full agent turn (runAgentTurn). Returns the turn outcome so the loop can
 *   stop on a failed/aborted turn instead of re-driving a broken condition.
 *   complete()/halt() may also fire DURING it (the complete_goal tool, or Stop).
 * @param {(sessionId: string, info: { phase: string, summary: string|null, reason: string|null }) => void} [deps.onRunEnd]
 *   Fired once when a run reaches a TERMINAL phase (done/halted/capped) — the SW
 *   uses it to post a terminal note. Not fired on a pause (vault-lock), which is
 *   resumable.
 * @param {(ev: object) => void} [deps.onEvent]   goal/* status → the side panel
 * @param {{ get(k:string):Promise<any>, set(k:string,v:any):Promise<void>, delete(k:string):Promise<void> }} [deps.kv]
 *   Durable mirror of the active runs (storage.local). Omit for pure in-memory
 *   (tests): persistence + resume become no-ops.
 * @param {(sessionId: string) => Promise<string>} [deps.getTodoBlock]
 *   Renders the session's live todo list for the continuation prompt
 *   (formatTodoBlock over session.todos, bound by the SW). Optional + best-
 *   effort: absent or throwing → the continuation goes out without the block.
 * @param {(sessionId: string) => Promise<boolean>} [deps.hasUnresolvedSideEffects]
 *   Stops autonomous continuations when an earlier Class D/E dispatch may
 *   have landed. A new user turn can verify or deliberately start fresh work.
 * @param {(operation: () => Promise<void>) => Promise<void>} [deps.withRun]
 * @param {number} [deps.maxIterations]
 * @param {() => number} [deps.now]
 */
export const makeGoalRunner = ({
  runTurn, onEvent = () => {}, onRunEnd = () => {}, kv, getTodoBlock,
  hasUnresolvedSideEffects, withRun = (operation) => operation(),
  maxIterations = GOAL_MAX_ITERATIONS, now = Date.now,
}) => {
  /** @type {Map<string, GoalRun>} */
  const runs = new Map();
  /** @type {Set<string>} */
  const stopping = new Set();
  // why: only outstanding recovery reads need cancellation memory; completed
  // chats must not accumulate a permanent generation registry.
  /** @type {Set<Set<string>>} */
  const recovering = new Set();
  /** @param {string} sid */
  const invalidateRecovery = (sid) => {
    for (const cancelled of recovering) cancelled.add(sid);
  };
  let persistenceQueued = 0;
  let persistenceLane = Promise.resolve();

  // why: a terminal clear must settle after every older live snapshot.
  /** @param {()=>Promise<void>} operation */
  const enqueuePersistence = (operation) => {
    /** @type {Promise<void>} */
    let running;
    if (persistenceQueued === 0) {
      persistenceQueued = 1;
      try { running = Promise.resolve(operation()); }
      catch (error) { running = Promise.reject(error); }
    } else {
      persistenceQueued += 1;
      running = persistenceLane.then(operation);
    }
    const settled = running.finally(() => { persistenceQueued -= 1; });
    persistenceLane = settled.catch(() => {});
    return running;
  };

  // why: Live snapshots permit recovery. A failed snapshot does not stop work.
  const persist = () => {
    if (!kv) return Promise.resolve();
    /** @type {Record<string, { goal: string, iteration: number, startedAt: number }>} */
    const out = {};
    for (const [sid, r] of runs) {
      if (r.completed || r.halted) continue;
      out[sid] = { goal: r.goal, iteration: r.iteration, startedAt: r.startedAt };
    }
    return enqueuePersistence(() => kv.set(GOAL_RUNS_KEY, out)).catch(() => {});
  };

  /** @param {string} sid @returns {GoalRun | null} */
  const get = (sid) => runs.get(sid) ?? null;
  /** @param {string} sid */
  const isActive = (sid) => { const r = runs.get(sid); return !!r && !r.completed && !r.halted; };
  // A goal supplies temporary Act authority independently of session metadata.
  // Capture identity plus posture, not mutable run objects alone.
  const captureAuthority = () => {
    const snapshot = [...runs].map(([sid, run]) => ({ sid, run, active: isActive(sid) }));
    return () => snapshot.length === runs.size && snapshot.every(({ sid, run, active }) =>
      runs.get(sid) === run && isActive(sid) === active);
  };

  /**
   * Is a run for this session recorded in the DURABLE mirror: live OR
   * merely not-yet-resumed after an SW restart OR vault-lock-paused (evicted
   * from the map but kept in the mirror for resume)? Prewalk's reconcile
   * consults this so a mid-restart/paused run is never mistaken for a dead one
   * and wrongly restored to the planner model. A no-op (false) without kv.
   * @param {string} sid @returns {Promise<boolean>}
   */
  const isPersisted = async (sid) => {
    if (isActive(sid)) return true;
    if (!kv) return false;
    try {
      const stored = await kv.get(GOAL_RUNS_KEY);
      return !!(stored && typeof stored === 'object' && Object.hasOwn(stored, sid));
    } catch { return false; }
  };

  /**
   * The 'running' goal/state payloads for every LIVE run — for replaying to a
   * port that just (re)connected. The loop's emit() only reaches ports connected
   * at the time it fires, and the SW state snapshot carries no goal-run field, so
   * without this replay a panel that reopened (or reconnected after an SW respawn)
   * shows NO Goal bar / Stop for a run still driving autonomously. Same shape the
   * live loop emits, so it folds through the panel's existing goal/state reducer.
   * @returns {object[]}
   */
  const activeStates = () => {
    const out = [];
    for (const sid of runs.keys()) {
      if (!isActive(sid)) continue;
      const r = /** @type {GoalRun} */ (runs.get(sid));
      out.push({
        type: 'goal/state', sessionId: sid, phase: 'running', active: true,
        iteration: r.iteration, maxIterations, goal: r.goal, summary: r.summary ?? null,
      });
    }
    return out;
  };

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

  // why: Stop must remove paused records too and report storage failure.
  /** @param {string} sid @param {GoalRun} [expectedRun] */
  const forget = async (sid, expectedRun) => {
    if (!kv) return;
    await enqueuePersistence(async () => {
      if (expectedRun && runs.get(sid) !== expectedRun) return;
      const stored = await kv.get(GOAL_RUNS_KEY);
      if (expectedRun && runs.get(sid) !== expectedRun) return;
      if (stored && typeof stored === 'object' && Object.hasOwn(stored, sid)) {
        const next = { ...stored };
        delete next[sid];
        await kv.set(GOAL_RUNS_KEY, next);
      }
    });
  };

  /** Stop a live or paused run. @param {string} sid */
  const stop = async (sid) => {
    // why: A failed removal must block recovery until Stop succeeds.
    stopping.add(sid);
    invalidateRecovery(sid);
    const r = runs.get(sid);
    if (r) r.halted = true;  // its drive() loop sees !alive() and exits to the terminal finally
    await forget(sid);
    stopping.delete(sid);
  };

  /** @param {string} sid @param {'running'|'done'|'halted'|'capped'} phase */
  const emit = (sid, phase, source = runs.get(sid)) => {
    const r = source;
    onEvent({
      type: 'goal/state', sessionId: sid, phase,
      active: phase === 'running',
      iteration: r?.iteration ?? 0, maxIterations,
      goal: r?.goal ?? '', summary: r?.summary ?? null,
    });
  };

  /** Run turns until complete / halted / capped, then clean up.
   * @param {string} sid @param {GoalRun} run */
  const driveRun = async (sid, run) => {
    // why identity check (not just isActive): a fresh start() for the SAME
    // session replaces the map entry and halts THIS one — the old drive must
    // see it's been superseded and exit WITHOUT deleting the new run.
    const alive = () => runs.get(sid) === run && !run.completed && !run.halted && !run.paused;
    try {
      while (alive() && run.iteration < maxIterations) {
        const first = run.iteration === 0;
        // A synthetic continuation is not new user authority. If an earlier
        // side effect has an unknown outcome, stop before the model can express
        // the same intent under a fresh tool-call id and bypass replay identity.
        if (!first && typeof hasUnresolvedSideEffects === 'function') {
          let unresolved = true;
          try { unresolved = await hasUnresolvedSideEffects(sid); } catch { /* fail closed */ }
          if (!alive()) break;
          if (unresolved) {
            run.halted = true;
            run.lastError = 'an earlier action needs verification before autonomous work can continue';
            break;
          }
        }
        run.iteration += 1;
        persist();  // record the iteration about to run, so a crash resumes here
        emit(sid, 'running');
        /** @type {{ ok?: boolean, stopReason?: string } | void} */
        let outcome;
        // The live plan-of-record for this continuation — re-read per turn so
        // check-offs from the previous turn show. Best-effort: a read failure
        // just drops the block, never the turn.
        let todoBlock = '';
        if (!first && typeof getTodoBlock === 'function') {
          try { todoBlock = await getTodoBlock(sid); } catch { todoBlock = ''; }
        }
        if (!alive()) break;
        try {
          outcome = await runTurn({
            sessionId: sid,
            userText: first ? run.goal : goalContinuationPrompt(run.goal, todoBlock),
            // turn 1 is the user's real goal message; continuations are hidden.
            synthetic: !first,
            // DESIGN-17: a goal is USER-initiated, so each continuation is a
            // TRUSTED first-party autonomous turn — allowed to message actors
            // (so an autonomous goal can drive a VM/Notebook/App). The sender
            // gate's `=== active` check still requires the goal's chat be the
            // foreground one; a backgrounded goal stays blocked.
            trusted: true,
          });
        } catch (e) {
          // A hard throw. A locked vault is TRANSIENT — pause (keep the
          // persisted record) so resume() re-drives after unlock. Anything else
          // is a real stop.
          if (e && /** @type {any} */ (e).name === 'VaultLockedError') run.paused = true;
          else { run.halted = true; run.lastError = /** @type {any} */ (e)?.message ?? String(e); }
          break;
        }
        // A turn that ended in failure or was aborted (Stop / steer / spend
        // limit) must NOT be blindly re-driven — that would burn the whole cap
        // re-failing. Stop the run instead.
        if (outcome && (outcome.ok === false || outcome.stopReason === 'aborted')) {
          run.halted = true;
          run.lastError = outcome.stopReason === 'aborted' ? null : 'a turn failed';
          break;
        }
      }
    } finally {
      if (runs.get(sid) === run) {
        if (run.paused) {
          // Leave the persisted record intact (don't persist() it away) and free
          // the in-memory slot so resume() re-adds + re-drives it after unlock.
          runs.delete(sid);
        } else {
          const phase = run.completed ? 'done' : run.halted ? 'halted'
            : run.iteration >= maxIterations ? 'capped' : 'done';
          // why: Failed cleanup must finish the UI state and block recovery.
          try { await forget(sid, run); }
          catch { if (runs.get(sid) === run) stopping.add(sid); }
          // why: storage cleanup may overlap a replacement in the same chat.
          if (runs.get(sid) !== run) return;
          runs.delete(sid);
          emit(sid, phase, run);
          try { onRunEnd(sid, { phase, summary: run.summary, reason: run.lastError ?? null }); }
          catch (e) { console.error('[goal] onRunEnd threw', e); }
        }
      }
    }
  };
  /** @param {string} sid */
  const drive = async (sid) => {
    // why: acquiring the controller can outlive this run's ownership.
    const run = runs.get(sid);
    if (!run) return;
    let entered = false;
    try {
      await withRun(() => {
        entered = true;
        return driveRun(sid, run);
      });
    } catch (e) {
      if (runs.get(sid) !== run) return;
      if (entered) { halt(sid); throw e; }
      // why re-enter only the local lifecycle: acquisition failed before the
      // drive could reach its terminal finally, so close the run without work.
      run.halted = true;
      run.lastError = /** @type {any} */ (e)?.message ?? String(e);
      await driveRun(sid, run);
    }
  };

  /**
   * Start (or supersede) a goal run for a session. Fire-and-forget: returns
   * immediately; the turns stream over the port like any chat.
   * @param {{ sessionId: string, goal: string }} req
   */
  const start = async ({ sessionId, goal }) => {
    if (!sessionId || typeof goal !== 'string' || !goal.trim()) {
      return { ok: false, error: 'goal-required' };
    }
    invalidateRecovery(sessionId);
    stopping.delete(sessionId);
    if (runs.has(sessionId)) halt(sessionId);  // supersede any prior run
    runs.set(sessionId, {
      goal: goal.trim(), iteration: 0, completed: false, halted: false,
      summary: null, lastError: null, startedAt: now(),
    });
    persist();
    emit(sessionId, 'running');
    drive(sessionId).catch((e) => {
      console.error('[goal] drive threw', e);
    });
    return { ok: true };
  };

  /** Resume saved runs after unlock. Skip live runs and cancelled recovery.
   * @returns {Promise<{ resumed: number }>}
   */
  const resume = async () => {
    if (!kv) return { resumed: 0 };
    const cancelled = new Set();
    recovering.add(cancelled);
    let stored;
    try {
      // why: recovery begun during a Stop must wait for its durable removal.
      await persistenceLane;
      stored = await kv.get(GOAL_RUNS_KEY);
    } catch { return { resumed: 0 }; }
    finally { recovering.delete(cancelled); }
    if (!stored || typeof stored !== 'object') return { resumed: 0 };
    let resumed = 0;
    for (const [sid, raw] of Object.entries(stored)) {
      if (!sid || runs.has(sid) || cancelled.has(sid) || stopping.has(sid)) continue;
      const rec = /** @type {{ goal?: unknown, iteration?: unknown, startedAt?: unknown }} */ (raw);
      if (!rec || typeof rec.goal !== 'string' || !rec.goal) continue;
      // why clamp at the cap: persist() records the iteration ABOUT to run, so a
      // crash resumes there. But if the SW died DURING the final allowed turn, the
      // stored iteration === maxIterations and drive()'s `iteration < maxIterations`
      // would be false immediately, declaring 'capped' for a turn that never
      // actually ran. Rewind one so that interrupted final turn re-runs once.
      const storedIteration = Number(rec.iteration) || 0;
      const iteration = storedIteration >= maxIterations ? Math.max(0, maxIterations - 1) : storedIteration;
      invalidateRecovery(sid);
      runs.set(sid, {
        goal: rec.goal,
        iteration,
        completed: false, halted: false, summary: null, lastError: null,
        startedAt: Number(rec.startedAt) || now(),
      });
      emit(sid, 'running');
      drive(sid).catch((e) => { console.error('[goal] resume drive threw', e); });
      resumed += 1;
    }
    return { resumed };
  };

  return Object.freeze({ start, halt, stop, complete, isActive, isPersisted, get, activeStates, drive, resume, captureAuthority });
};
