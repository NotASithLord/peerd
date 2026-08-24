// @ts-check
// Durable unattended routines. A firing is persisted as pending before host
// custody: known pre-commit refusal retries; loss/recycle becomes outcome-unknown.

import { uuidv7 } from '/shared/util.js';
import {
  parseSchedule, computeNextRun, describeSchedule, dueRoutines, nextWakeAt,
} from './schedule.js';

export const SCHEDULE_ROUTINES_KEY = 'schedule.routines.v1';
export const SCHEDULE_ALARM_NAME = 'peerd-schedule';
export const MAX_ROUTINES = 20;
export const MAX_FIRINGS_PER_TICK = 3;
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
 * @property {number|null} pendingRunAt
 * @property {number|null} lastOutcomeUnknownAt
 */

/**
 * @param {Object} deps
 * @param {(routine: Routine) => Promise<{
 *   sessionId?:string,ok?:boolean,outcomeKnown?:boolean,code?:string
 * }|void>} deps.fireRoutine
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
  /** @type {Set<string>} */
  const firing = new Set();

  let ticking = false;
  let retickRequested = false;

  const snapshot = () => [...routines.values()];

  const persist = async () => {
    if (!kv) return;
    /** @type {Record<string, Routine>} */
    const out = {};
    for (const [id, r] of routines) out[id] = r;
    await kv.set(SCHEDULE_ROUTINES_KEY, out);
  };

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
      pendingRunAt: null,
      lastOutcomeUnknownAt: null,
    };
    routines.set(routine.id, routine);
    void persist().catch(() => {});
    reschedule();
    emit('schedule/changed', { routines: list() });
    return { ok: true, routine };
  };

  /** @param {string} id @returns {boolean} existed */
  const remove = (id) => {
    const existed = routines.delete(id);
    if (existed) { void persist().catch(() => {}); reschedule(); emit('schedule/changed', { routines: list() }); }
    return existed;
  };

  /** @param {string} id @param {boolean} on */
  const setEnabled = (id, on) => {
    const r = routines.get(id);
    if (!r) return false;
    r.enabled = !!on;
    if (r.enabled) r.nextRunAt = computeNextRun(r.schedule, now(), r.createdAt);
    void persist().catch(() => {});
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
    const consumeRetick = () => { const r = retickRequested; retickRequested = false; return r; };
    const totals = { fired: 0, deferred: 0, skipped: 0 };
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
        /** @type {Array<{routine:Routine, priorLastRunAt:number|null, priorRunCount:number,
         * result:Promise<{ok:boolean,value?:any,cause?:unknown}>}>} */
        const dispatches = [];
        for (const routine of due) {
          if (firedThisTick >= MAX_FIRINGS_PER_TICK) break;  // throttle the herd
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
          const priorLastRunAt = routine.lastRunAt;
          const priorRunCount = routine.runCount;
          routine.lastRunAt = at;
          routine.runCount += 1;
          routine.pendingRunAt = at;
          try { await persist(); }
          catch {
            routine.lastRunAt = priorLastRunAt;
            routine.runCount = priorRunCount;
            routine.pendingRunAt = null;
            routine.nextRunAt = now() + LOCKED_BACKOFF_MS;
            emit('schedule/retry', { id: routine.id, code: 'schedule-storage-unavailable' });
            continue;
          }
          firing.add(routine.id);
          emit('schedule/firing', { id: routine.id, prompt: routine.prompt });
          const result = Promise.resolve()
            .then(() => fireRoutine(routine))
            .then((value) => ({ ok: value?.ok !== false, value }))
            .catch((cause) => ({ ok: false, cause }));
          dispatches.push({ routine, priorLastRunAt, priorRunCount, result });
          firedThisTick += 1;
          totals.fired += 1;
        }
        const settled = await Promise.all(dispatches.map((entry) => entry.result));
        for (const { routine } of dispatches) firing.delete(routine.id);
        for (let index = 0; index < dispatches.length; index += 1) {
          const { routine, priorLastRunAt, priorRunCount } = dispatches[index];
          const outcome = settled[index];
          if (routines.get(routine.id) !== routine) continue;
          routine.pendingRunAt = null;
          if (outcome.ok) {
            const sid = outcome.value && typeof outcome.value === 'object'
              ? outcome.value.sessionId : undefined;
            if (sid) routine.lastSessionId = sid;
          } else {
            const detail = /** @type {any} */ (outcome.cause
              ?? (outcome.value && typeof outcome.value === 'object' ? outcome.value : null));
            if (detail?.outcomeKnown === true) {
              routine.lastRunAt = priorLastRunAt;
              routine.runCount = priorRunCount;
              routine.nextRunAt = now() + LOCKED_BACKOFF_MS;
              emit('schedule/retry', { id: routine.id, code: detail?.code ?? null });
            } else {
              routine.lastOutcomeUnknownAt = routine.lastRunAt;
              emit('schedule/outcome-unknown', { id: routine.id });
            }
            console.error('[schedule] fireRoutine threw', detail);
          }
        }
        if (dispatches.length > 0) await persist();
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
    let recoveredPending = false;
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
        pendingRunAt: null,
        lastOutcomeUnknownAt: Number.isFinite(rec.pendingRunAt)
          ? Number(rec.pendingRunAt)
          : Number.isFinite(rec.lastOutcomeUnknownAt) ? Number(rec.lastOutcomeUnknownAt) : null,
      });
      if (Number.isFinite(rec.pendingRunAt)) {
        recoveredPending = true;
        emit('schedule/outcome-unknown', { id });
      }
      loaded += 1;
    }
    if (recoveredPending) await persist();
    reschedule();
    return { loaded };
  };

  return Object.freeze({
    add, remove, setEnabled, list, tick, load,
    describe: describeSchedule,
  });
};
