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
 * @param {(routine: Routine) => boolean} [deps.isRunning] Whether the previous run is active.
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
  /** @type {WeakMap<Routine, number>} */
  const revisions = new WeakMap();

  let ticking = false;
  let retickRequested = false;
  let persistenceTail = Promise.resolve();
  /** @type {Promise<{ loaded: number }> | null} */
  let loading = null;

  const snapshot = () => [...routines.values()];

  const persist = () => {
    if (!kv) return Promise.resolve();
    // why: Older writes must finish first. Each write owns its snapshot.
    const write = persistenceTail.then(() => kv.set(SCHEDULE_ROUTINES_KEY,
      Object.fromEntries([...routines].map(([id, routine]) => [id, { ...routine }]))));
    persistenceTail = write.catch(() => {});
    return write;
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
  // why: a turn can reach its authority before cold recovery has hydrated.
  const listReady = async () => { await load(); return list(); };

  /**
   * Register a routine after loading the stored records.
   * @param {{ prompt: string, every?: string, dailyAt?: string, mode?: string, signal?: AbortSignal }} req
   * @returns {Promise<{ ok: true, routine: Routine } | { ok: false, error: string }>}
   */
  const add = async ({ prompt, every, dailyAt, mode, signal } = /** @type {any} */ ({})) => {
    if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, error: 'prompt-required' };
    const schedule = parseSchedule({ every, dailyAt });
    if (!schedule) return { ok: false, error: 'invalid-schedule' };
    await load();
    // why: Stop can arrive during the storage read, before any mutation.
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
      pendingRunAt: null,
      lastOutcomeUnknownAt: null,
    };
    if (signal?.aborted) return { ok: false, error: 'schedule-aborted' };
    routines.set(routine.id, routine);
    try { await persist(); }
    catch (cause) {
      routines.delete(routine.id);
      throw Object.assign(cause instanceof Error ? cause : new Error(String(cause)), {
        outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: true,
      });
    }
    reschedule();
    emit('schedule/changed', { routines: list() });
    return { ok: true, routine };
  };

  /** @param {string} id @returns {Promise<boolean>} existed */
  const remove = async (id) => {
    await load();
    const prior = routines.get(id);
    if (!prior) return false;
    routines.delete(id);
    try { await persist(); }
    catch (cause) {
      routines.set(id, prior);
      throw Object.assign(cause instanceof Error ? cause : new Error(String(cause)), {
        outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: true,
      });
    }
    reschedule();
    emit('schedule/changed', { routines: list() });
    return true;
  };

  /** @param {string} id @param {boolean} on */
  const setEnabled = (id, on) => {
    const r = routines.get(id);
    if (!r) return false;
    revisions.set(r, (revisions.get(r) ?? 0) + 1);
    r.enabled = !!on;
    if (r.enabled) r.nextRunAt = computeNextRun(r.schedule, now(), r.createdAt);
    void persist().catch(() => {});
    reschedule();
    emit('schedule/changed', { routines: list() });
    return true;
  };

  /** Fire due routines after their pending state is saved.
   * @returns {Promise<{ fired: number, deferred: number, skipped: number }>}
   */
  const tick = async () => {
    if (ticking) { retickRequested = true; return { fired: 0, deferred: 0, skipped: 0 }; }
    ticking = true;
    const consumeRetick = () => { const r = retickRequested; retickRequested = false; return r; };
    const totals = { fired: 0, deferred: 0, skipped: 0 };
    let firedThisTick = 0;
    try {
      await load();
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
        let needsPersist = false;
        for (const routine of due) {
          if (firedThisTick >= MAX_FIRINGS_PER_TICK) break;
          if (firing.has(routine.id) || routines.get(routine.id) !== routine || !routine.enabled || routine.nextRunAt > at) continue;
          // why: A long run must not start a second copy.
          if (isRunning(routine)) {
            routine.nextRunAt = computeNextRun(routine.schedule, at, routine.createdAt);
            needsPersist = true;
            totals.skipped += 1;
            continue;
          }
          // why: A restart must see the pending action before host dispatch.
          const revision = revisions.get(routine);
          const priorNextRunAt = routine.nextRunAt;
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
          needsPersist = true;
          if (routines.get(routine.id) !== routine || revisions.get(routine) !== revision || !routine.enabled || isLocked() || isRunning(routine)) {
            routine.lastRunAt = priorLastRunAt;
            routine.runCount = priorRunCount;
            routine.pendingRunAt = null;
            if (isLocked() && revisions.get(routine) === revision) {
              routine.nextRunAt = priorNextRunAt;
              totals.deferred += 1;
            }
            continue;
          }
          firing.add(routine.id);
          const result = (async () => fireRoutine(routine))()
            .then((value) => ({ ok: value?.ok !== false, value }))
            .catch((cause) => ({ ok: false, cause }));
          emit('schedule/firing', { id: routine.id, prompt: routine.prompt });
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
        if (needsPersist) await persist();
        // why: Due routines above the firing limit need another alarm.
        reschedule();
      } while (consumeRetick());
      return totals;
    } finally {
      ticking = false;
    }
  };

  /** Load stored routines before a mutation can overwrite them.
   * @returns {Promise<{ loaded: number }>}
   */
  const load = async () => {
    if (loading) { await loading; return { loaded: 0 }; }
    loading = readStored().catch((cause) => { loading = null; throw cause; });
    return loading;
  };
  const readStored = async () => {
    if (!kv) return { loaded: 0 };
    const stored = await kv.get(SCHEDULE_ROUTINES_KEY);
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
    add, remove, setEnabled, list, listReady, tick, load,
    describe: describeSchedule,
  });
};
