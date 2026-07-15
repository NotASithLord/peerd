// @ts-check
// peerd-runtime/loop/scheduler — the background Routine runner.
//
// A Routine is a standing task that fires unattended on a cadence (see
// loop/schedule.js for the "when"). This is the imperative shell around that
// math: it holds the live routines, mirrors them durably to storage.local, and
// on each WAKE decides which are due and fires them. It is the time-triggered
// sibling of loop/goal-runner.js and copies that file's durability contract —
// an in-memory map authoritative within one SW lifetime, mirrored to a kv key,
// rehydrated by load() on boot — because an MV3 service worker is evicted after
// ~30s idle and a routine must outlive that.
//
// The "run it as soon as peerd is back on" requirement is met by making tick()
// a CATCH-UP pass: it fires every routine whose nextRunAt has already passed,
// regardless of HOW MANY cadence slots elapsed while the browser was off or the
// SW was dead (a routine advances to the next FUTURE slot, so a long downtime
// collapses to a single catch-up run, never a burst). The SW calls tick() from
// three wakes — a chrome.alarms fire, the cold-boot path, and vault unlock — so
// whichever happens first drives the due work.
//
// DELIVERY SEMANTICS (honest): at-most-once. tick() advances nextRunAt and
// AWAITS the durable write BEFORE firing, so a crash after the write can't
// re-fire the slot (no double-fire — important, a firing has side effects). The
// residual risk is the narrow window where the SW dies AFTER the write commits
// but BEFORE fireRoutine does durable work — that one firing is skipped, not
// double-run. We prefer a missed run to a duplicated side effect.
//
// Vault-locked case: a firing needs the model key, so tick() REFUSES to fire
// while the vault is locked — it leaves due routines untouched and arms the
// alarm for a modest BACKOFF (not the past due time, which would wake-storm the
// SW ~1/min) so the unlock re-tick drains them promptly and the fallback wake is
// cheap. Same shape as goal-runner's paused/resume.
//
// Functional-core / imperative-shell: fireRoutine, kv, now, setAlarm, isLocked,
// isRunning and onEvent are all INJECTED, so the control logic is otherwise pure
// and unit-testable with fakes (scheduler.test.ts).

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

  // tick() serialization. A tick requested while one is running sets a re-tick
  // request; the running tick re-runs once it settles (instead of the request
  // being DROPPED — the old bug: an unlock re-tick landing during a locked-path
  // tick's await would be lost).
  let ticking = false;
  let retickRequested = false;

  const snapshot = () => [...routines.values()];

  /** Await the durable mirror write (at-most-once needs this awaited before firing). */
  const persist = async () => {
    if (!kv) return;
    /** @type {Record<string, Routine>} */
    const out = {};
    for (const [id, r] of routines) out[id] = r;
    try { await kv.set(SCHEDULE_ROUTINES_KEY, out); }
    catch { /* best-effort — a lost write just means a routine may re-run once or not resume */ }
  };

  // Arm the single alarm for the soonest enabled routine (or clear it). When
  // locked with something due, arm a backoff instead of the past due time.
  const reschedule = () => {
    let when = nextWakeAt(snapshot());
    if (when != null && isLocked() && when <= now()) when = now() + LOCKED_BACKOFF_MS;
    try { setAlarm(when); }
    catch (e) { console.error('[schedule] setAlarm threw', e); }
  };

  const emit = (/** @type {string} */ type, /** @type {object} */ extra = {}) => {
    try { onEvent({ type, ...extra }); } catch { /* port closed */ }
  };

  /** @returns {Routine[]} */
  const list = () => snapshot().map((r) => ({ ...r }));

  /**
   * Register a new routine. Normalizes the spec through parseSchedule and
   * enforces the count cap. Returns the created routine or an error object.
   * @param {{ prompt: string, every?: string, dailyAt?: string, mode?: string }} req
   * @returns {{ ok: true, routine: Routine } | { ok: false, error: string }}
   */
  const add = ({ prompt, every, dailyAt, mode } = /** @type {any} */ ({})) => {
    if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, error: 'prompt-required' };
    if (routines.size >= MAX_ROUTINES) return { ok: false, error: 'too-many-routines' };
    const schedule = parseSchedule({ every, dailyAt });
    if (!schedule) return { ok: false, error: 'invalid-schedule' };
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
    routines.set(routine.id, routine);
    // Fire-and-forget the mirror write on the mutation paths (add/remove/
    // setEnabled) — only the FIRING path needs the awaited write for at-most-once.
    void persist();
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

  /**
   * The wake pass: fire due routines (capped, skipping still-running ones),
   * advance each to its next FUTURE slot, then re-arm. Deferred while the vault
   * is locked. Serialized; a concurrent request re-runs once rather than being
   * dropped.
   * @returns {Promise<{ fired: number, deferred: number, skipped: number }>}
   */
  const tick = async () => {
    if (ticking) { retickRequested = true; return { fired: 0, deferred: 0, skipped: 0 }; }
    ticking = true;
    // Consume a re-tick requested while we were awaiting, so a wake that landed
    // mid-tick (e.g. an unlock re-tick during a locked-path pass) is honored in
    // this same call rather than dropped.
    const consumeRetick = () => { const r = retickRequested; retickRequested = false; return r; };
    const totals = { fired: 0, deferred: 0, skipped: 0 };
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
        let firedThisPass = 0;
        for (const routine of due) {
          if (firedThisPass >= MAX_FIRINGS_PER_TICK) break;  // throttle the herd
          if (firing.has(routine.id)) continue;
          // Skip a routine whose previous firing is still running — advance it a
          // slot so it retries next cadence instead of piling up concurrent runs.
          if (isRunning(routine)) {
            routine.nextRunAt = computeNextRun(routine.schedule, at, routine.createdAt);
            totals.skipped += 1;
            continue;
          }
          // Advance + AWAIT the durable write BEFORE firing → no double-fire on a
          // crash after commit (at-most-once; see the file header).
          routine.nextRunAt = computeNextRun(routine.schedule, at, routine.createdAt);
          routine.lastRunAt = at;
          routine.runCount += 1;
          await persist();
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
          firedThisPass += 1;
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

  /**
   * Rehydrate routines from the durable mirror on SW boot. A no-op without kv or
   * with nothing stored. Does NOT fire — the caller ticks() after. Idempotent.
   * @returns {Promise<{ loaded: number }>}
   */
  const load = async () => {
    if (!kv) return { loaded: 0 };
    let stored;
    try { stored = await kv.get(SCHEDULE_ROUTINES_KEY); } catch { return { loaded: 0 }; }
    if (!stored || typeof stored !== 'object') return { loaded: 0 };
    let loaded = 0;
    for (const [id, raw] of Object.entries(stored)) {
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
    return { loaded };
  };

  return Object.freeze({
    add, remove, setEnabled, list, tick, load,
    describe: describeSchedule,
  });
};
