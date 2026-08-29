// @ts-check
// peerd-runtime/loop/scheduler — the background Routine runner.
//
// A Routine is an unattended standing task. This shell holds live routines,
// mirrors them to storage.local, and fires due work. load() restores state after
// MV3 service-worker eviction. loop/schedule.js owns the schedule math.
//
// tick() collapses any missed cadence slots into one catch-up run. It advances
// and persists nextRunAt before it fires. This gives at-most-once delivery. A
// crash after that write can skip one run, but it cannot repeat a side effect.
//
// A locked vault leaves due routines unchanged and uses a backoff alarm. Unlock
// triggers another tick. All IO is injected for focused tests.

import { uuidv7 } from '/shared/util.js';
import {
  parseSchedule, computeNextRun, describeSchedule, dueRoutines, nextWakeAt,
} from './schedule.js';

// storage.local key holding the routines map ({ [id]: Routine }) — the durable
// mirror load() reads on SW boot. Versioned like goal.runs.v1.
export const SCHEDULE_ROUTINES_KEY = 'schedule.routines.v1';

// The single alarm name the SW arms for the soonest routine.
export const SCHEDULE_ALARM_NAME = 'peerd-schedule';

// Hard cap on registered routines — a floor against a runaway (an injected /
// buggy agent spamming schedule_create) turning into unbounded background spend.
export const MAX_ROUTINES = 20;

// Most routines to FIRE in a single wake. After a long downtime many routines
// can be due at once; firing them all would be a thundering herd of concurrent
// goal loops hammering the model API. Fire this many, leave the rest due (the
// re-armed alarm drains them across successive wakes).
export const MAX_FIRINGS_PER_TICK = 3;

// While the vault is locked, re-arm the alarm this far out instead of at the
// (past) due time — the unlock re-tick is the real drain; this is just a cheap
// fallback wake that doesn't storm.
export const LOCKED_BACKOFF_MS = 5 * 60_000;

/**
 * One registered routine.
 * @typedef {Object} Routine
 * @property {string} id
 * @property {string} prompt
 * @property {import('./schedule.js').Schedule} schedule
 * @property {'goal'|'turn'} mode
 * @property {boolean} enabled
 * @property {number} createdAt
 * @property {number} nextRunAt
 * @property {number|null} lastRunAt
 * @property {string|null} lastSessionId
 * @property {number} runCount
 */

/**
 * @param {Object} deps
 * @param {(routine: Routine) => Promise<{ sessionId?: string } | void>} deps.fireRoutine
 * @param {{ get(k:string):Promise<any>, set(k:string,v:any):Promise<void>, delete?(k:string):Promise<void> }} [deps.kv]
 * @param {() => boolean} [deps.isLocked]
 * @param {(routine: Routine) => boolean} [deps.isRunning]  true when this routine's
 *   PREVIOUS firing is still going (its goal run is active) — such a routine is
 *   SKIPPED this slot so a long-running routine can't pile up concurrent runs.
 * @param {(whenMs: number|null) => void} [deps.setAlarm]
 * @param {(ev: object) => void} [deps.onEvent]
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.makeId]
 */
export const makeScheduler = ({
  fireRoutine,
  kv,
  isLocked = () => false,
  isRunning = () => false,
  setAlarm = () => {},
  onEvent = () => {},
  now = Date.now,
  makeId,
}) => {
  const generateId = makeId ?? (() => uuidv7(now));

  /** @type {Map<string, Routine>} */
  const routines = new Map();
  // routineIds whose fireRoutine kickoff is in flight THIS tick — skip re-firing
  // them within the same/overlapping pass (a coarser guard than isRunning, which
  // spans the whole goal run).
  /** @type {Set<string>} */
  const firing = new Set();

  // A concurrent wake requests one more pass instead of losing the wake.
  let ticking = false;
  let retickRequested = false;

  const snapshot = () => [...routines.values()];

  // why one lane: an older write must not overwrite newer state.
  /** @type {Promise<void>} */ let persistenceTail = Promise.resolve();
  /** @type {Promise<number>|null} */ let hydrationPromise = null;
  const persist = () => {
    if (!kv) return Promise.resolve();
    const write = persistenceTail.then(async () => {
      await hydrate();
      /** @type {Record<string, Routine>} */
      const out = {};
      for (const [id, r] of routines) out[id] = { ...r };
      await kv.set(SCHEDULE_ROUTINES_KEY, out);
    });
    persistenceTail = write.catch(() => {});
    return write;
  };

  // Arm the single alarm for the soonest enabled routine (or clear it). When
  // locked with something due, arm a backoff instead of the past due time.
  const reschedule = () => {
    let when = nextWakeAt(snapshot());
    if (when != null && isLocked() && when <= now()) when = now() + LOCKED_BACKOFF_MS;
    try { setAlarm(when); }
    catch (e) { console.error('[schedule] setAlarm threw', e); }
  };

  const hydrate = () => {
    if (hydrationPromise) return hydrationPromise;
    const attempt = (async () => {
      const stored = await kv?.get(SCHEDULE_ROUTINES_KEY);
      let loaded = 0;
      if (stored && typeof stored === 'object') for (const [id, raw] of Object.entries(stored)) {
        if (!id || routines.has(id)) continue;
        const rec = /** @type {any} */ (raw);
        if (!rec || typeof rec.prompt !== 'string' || !rec.schedule) continue;
        routines.set(id, {
          id,
          prompt: rec.prompt,
          schedule: rec.schedule,
          mode: rec.mode === 'turn' ? 'turn' : 'goal',
          enabled: rec.enabled !== false,
          createdAt: Number(rec.createdAt) || now(),
          nextRunAt: Number(rec.nextRunAt) || now(),
          lastRunAt: rec.lastRunAt == null ? null : Number(rec.lastRunAt),
          lastSessionId: typeof rec.lastSessionId === 'string' ? rec.lastSessionId : null,
          runCount: Number(rec.runCount) || 0,
        });
        loaded += 1;
      }
      reschedule();
      return loaded;
    })();
    hydrationPromise = attempt.catch((error) => { hydrationPromise = null; throw error; });
    return hydrationPromise;
  };

  const emit = (/** @type {string} */ type, /** @type {object} */ extra = {}) => {
    try { onEvent({ type, ...extra }); } catch { /* port closed */ }
  };

  /** @returns {Routine[]} */
  const list = () => snapshot().map((r) => ({ ...r }));

  /** Register a validated routine after durable hydration.
   * @param {{ prompt: string, every?: string, dailyAt?: string, mode?: string, signal?: AbortSignal }} req
   * @returns {Promise<{ ok: true, routine: Routine } | { ok: false, error: string }>}
   */
  const add = async ({ prompt, every, dailyAt, mode, signal } = /** @type {any} */ ({})) => {
    if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, error: 'prompt-required' };
    const schedule = parseSchedule({ every, dailyAt });
    if (!schedule) return { ok: false, error: 'invalid-schedule' };
    if (kv) await hydrate();
    if (signal?.aborted) return { ok: false, error: 'schedule-aborted' };
    if (routines.size >= MAX_ROUTINES) return { ok: false, error: 'too-many-routines' };
    const at = now();
    /** @type {Routine} */
    const routine = {
      id: generateId(),
      prompt: prompt.trim(),
      schedule,
      mode: mode === 'turn' ? 'turn' : 'goal',
      enabled: true,
      createdAt: at,
      nextRunAt: computeNextRun(schedule, at, at),
      lastRunAt: null,
      lastSessionId: null,
      runCount: 0,
    };
    if (signal?.aborted) return { ok: false, error: 'schedule-aborted' };
    routines.set(routine.id, routine);
    void persist(); // Only the firing path must wait for its durable write.
    reschedule();
    emit('schedule/changed', { routines: list() });
    return { ok: true, routine };
  };

  /** @param {string} id @returns {boolean} existed */
  const remove = (id) => {
    const existed = routines.delete(id);
    if (existed) { void persist(); reschedule(); emit('schedule/changed', { routines: list() }); }
    return existed;
  };

  /** @param {string} id @param {boolean} on */
  const setEnabled = (id, on) => {
    const r = routines.get(id);
    if (!r) return false;
    r.enabled = !!on;
    if (r.enabled) r.nextRunAt = computeNextRun(r.schedule, now(), r.createdAt);
    void persist();
    reschedule();
    emit('schedule/changed', { routines: list() });
    return true;
  };

  /** Fire due routines, or defer them while the vault is locked.
   * @returns {Promise<{ fired: number, deferred: number, skipped: number }>}
   */
  const tick = async () => {
    if (ticking) { retickRequested = true; return { fired: 0, deferred: 0, skipped: 0 }; }
    ticking = true;
    // Consume a wake that arrived while this tick awaited IO.
    const consumeRetick = () => { const r = retickRequested; retickRequested = false; return r; };
    const totals = { fired: 0, deferred: 0, skipped: 0 };
    // The cap covers all re-tick passes in this call.
    let firedThisTick = 0;
    try {
      do {
        const at = now();
        const due = dueRoutines(snapshot(), at);
        if (due.length === 0) { reschedule(); continue; }
        if (isLocked()) {
          emit('schedule/deferred', { count: due.length });
          reschedule();
          totals.deferred += due.length;
          continue;
        }
        for (const routine of due) {
          if (firedThisTick >= MAX_FIRINGS_PER_TICK) break;  // throttle the herd
          if (firing.has(routine.id)) continue;
          const running = isRunning(routine);
          if (routines.get(routine.id) !== routine || !routine.enabled) continue;
          // Skip a routine whose previous firing is still running — advance it a
          // slot so it retries next cadence instead of piling up concurrent runs.
          if (running) {
            routine.nextRunAt = computeNextRun(routine.schedule, at, routine.createdAt);
            void persist();
            totals.skipped += 1;
            continue;
          }
          // Persist the advance before the side effect for at-most-once delivery.
          const previous = { nextRunAt: routine.nextRunAt, lastRunAt: routine.lastRunAt, runCount: routine.runCount };
          const attemptedNextRunAt = computeNextRun(routine.schedule, at, routine.createdAt);
          routine.nextRunAt = attemptedNextRunAt;
          routine.lastRunAt = at;
          routine.runCount += 1;
          try { await persist(); } catch (error) {
            const attemptUnchanged = routines.get(routine.id) === routine
              && routine.nextRunAt === attemptedNextRunAt
              && routine.lastRunAt === at
              && routine.runCount === previous.runCount + 1;
            if (attemptUnchanged) { Object.assign(routine, previous); void persist(); }
            reschedule();
            throw error;
          }
          if (routines.get(routine.id) !== routine || !routine.enabled) continue;
          firing.add(routine.id);
          emit('schedule/firing', { id: routine.id, prompt: routine.prompt });
          Promise.resolve()
            .then(() => fireRoutine(routine))
            .then((res) => {
              const sid = res && typeof res === 'object' ? res.sessionId : undefined;
              if (sid && routines.get(routine.id) === routine) { routine.lastSessionId = sid; void persist(); }
            })
            .catch((e) => console.error('[schedule] fireRoutine threw', e))
            .finally(() => firing.delete(routine.id));
          firedThisTick += 1;
          totals.fired += 1;
        }
        // More due than we fired (throttle or skips) → re-arm; the past-due
        // nextWakeAt makes the alarm fire again to drain the rest.
        reschedule();
      } while (consumeRetick());
      return totals;
    } finally {
      ticking = false;
    }
  };

  /** Rehydrate routines without firing them.
   * @returns {Promise<{ loaded: number }>}
   */
  const load = async () => {
    if (!kv) return { loaded: 0 };
    if (hydrationPromise) {
      try { await hydrationPromise; } catch { /* retry on the next call */ }
      return { loaded: 0 };
    }
    try { return { loaded: await hydrate() }; } catch { return { loaded: 0 }; }
  };

  return Object.freeze({
    add, remove, setEnabled, list, tick, load,
    describe: describeSchedule,
  });
};
