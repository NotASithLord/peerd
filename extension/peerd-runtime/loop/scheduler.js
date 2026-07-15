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
// a pure CATCH-UP pass: it fires every routine whose nextRunAt has already
// passed, regardless of HOW MANY cadence slots elapsed while the browser was off
// or the SW was dead (a routine advances to the next FUTURE slot, so a long
// downtime collapses to a single catch-up run, never a burst). The SW calls
// tick() from three wakes — a chrome.alarms fire, the cold-boot path, and vault
// unlock — so whichever happens first drives the due work.
//
// Vault-locked case: a routine fires an agent turn, which needs the model key, so
// tick() REFUSES to fire while the vault is locked — it leaves due routines
// untouched (their nextRunAt stays in the past) and relies on the unlock wake to
// re-tick and drain them. Same shape as goal-runner's paused/resume.
//
// Functional-core / imperative-shell: fireRoutine, kv, now, setAlarm/clearAlarm,
// isLocked and onEvent are all INJECTED, so the control logic is otherwise pure
// and unit-testable with fakes (scheduler.test.ts).

import { uuidv7 } from '/shared/util.js';
import {
  parseSchedule, computeNextRun, describeSchedule, dueRoutines, nextWakeAt,
} from './schedule.js';

// storage.local key holding the routines map ({ [id]: Routine }) — the durable
// mirror load() reads on SW boot. Versioned like goal.runs.v1 so a shape change
// is a new key, not a lossy in-place migration.
export const SCHEDULE_ROUTINES_KEY = 'schedule.routines.v1';

// The single alarm name the SW arms for the soonest routine. One alarm, re-set
// on every change — chrome.alarms.create with the same name replaces in place.
export const SCHEDULE_ALARM_NAME = 'peerd-schedule';

/**
 * One registered routine.
 * @typedef {Object} Routine
 * @property {string} id
 * @property {string} prompt                 the task text driven each firing
 * @property {import('./schedule.js').Schedule} schedule
 * @property {'goal'|'turn'} mode            autonomous goal loop vs one turn
 * @property {boolean} enabled
 * @property {number} createdAt              interval phase anchor
 * @property {number} nextRunAt              the next due time (may be in the past → due now)
 * @property {number|null} lastRunAt
 * @property {string|null} lastSessionId     the session the last firing ran in
 * @property {number} runCount
 */

/**
 * @param {Object} deps
 * @param {(routine: Routine) => Promise<{ sessionId?: string } | void>} deps.fireRoutine
 *   Kick off ONE firing: mint a session, drive the prompt (goal loop or single
 *   turn), notify. May return the sessionId so the runner records it. Rejections
 *   are caught — a bad firing must not wedge the scheduler.
 * @param {{ get(k:string):Promise<any>, set(k:string,v:any):Promise<void>, delete?(k:string):Promise<void> }} [deps.kv]
 *   Durable mirror (storage.local). Omit for pure in-memory (tests) — persistence
 *   + load() become no-ops.
 * @param {() => boolean} [deps.isLocked]    vault-locked probe; when true, tick()
 *   defers firing (leaves routines due) and waits for the unlock re-tick.
 * @param {(whenMs: number|null) => void} [deps.setAlarm]  arm/replace the single
 *   wake alarm for `whenMs` (null → clear). No-op default (tests).
 * @param {(ev: object) => void} [deps.onEvent]  schedule/* status → the side panel.
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.makeId]
 */
export const makeScheduler = ({
  fireRoutine,
  kv,
  isLocked = () => false,
  setAlarm = () => {},
  onEvent = () => {},
  now = Date.now,
  makeId,
}) => {
  const generateId = makeId ?? (() => uuidv7(now));

  /** @type {Map<string, Routine>} */
  const routines = new Map();

  // Serialize overlapping ticks. tick() is called from three wakes that can land
  // near-simultaneously (alarm + unlock + boot); the flag stops two passes from
  // both seeing the same due routine before the first advanced its nextRunAt.
  let ticking = false;

  const snapshot = () => [...routines.values()];

  // Mirror the whole map to storage. Fire-and-forget, like goal-runner.persist:
  // the in-memory map is authoritative within an SW lifetime; a lost write just
  // means a routine may re-run once or not resume, never a broken live run.
  const persist = () => {
    if (!kv) return;
    /** @type {Record<string, Routine>} */
    const out = {};
    for (const [id, r] of routines) out[id] = r;
    Promise.resolve(kv.set(SCHEDULE_ROUTINES_KEY, out)).catch(() => {});
  };

  // Arm the single alarm for the soonest enabled routine (or clear it).
  const reschedule = () => {
    try { setAlarm(nextWakeAt(snapshot())); }
    catch (e) { console.error('[schedule] setAlarm threw', e); }
  };

  const emit = (/** @type {string} */ type, /** @type {object} */ extra = {}) => {
    try { onEvent({ type, ...extra }); } catch { /* port closed */ }
  };

  /** @returns {Routine[]} plain snapshot for the UI / tool result. */
  const list = () => snapshot().map((r) => ({ ...r }));

  /**
   * Register a new routine. Accepts the raw spec ({ every | dailyAt }) and
   * normalizes it through parseSchedule. Returns the created routine, or an
   * error object when the spec/prompt is invalid.
   * @param {{ prompt: string, every?: string, dailyAt?: string, mode?: string }} req
   * @returns {{ ok: true, routine: Routine } | { ok: false, error: string }}
   */
  const add = ({ prompt, every, dailyAt, mode } = /** @type {any} */ ({})) => {
    if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, error: 'prompt-required' };
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
    persist();
    reschedule();
    emit('schedule/changed', { routines: list() });
    return { ok: true, routine };
  };

  /** Remove a routine. @param {string} id @returns {boolean} existed */
  const remove = (id) => {
    const existed = routines.delete(id);
    if (existed) { persist(); reschedule(); emit('schedule/changed', { routines: list() }); }
    return existed;
  };

  /** Enable/disable without deleting. @param {string} id @param {boolean} on */
  const setEnabled = (id, on) => {
    const r = routines.get(id);
    if (!r) return false;
    r.enabled = !!on;
    // Re-anchor a re-enabled routine so it doesn't instantly fire a stale
    // backlog: its next run is computed forward from now.
    if (r.enabled) r.nextRunAt = computeNextRun(r.schedule, now(), r.createdAt);
    persist();
    reschedule();
    emit('schedule/changed', { routines: list() });
    return true;
  };

  /**
   * The wake pass: fire every due routine, advance it to its next FUTURE slot,
   * then re-arm the alarm. Deferred entirely while the vault is locked (the
   * firing needs the model key) — the unlock wake re-ticks. Idempotent and
   * self-serializing.
   * @returns {Promise<{ fired: number, deferred: number }>}
   */
  const tick = async () => {
    if (ticking) return { fired: 0, deferred: 0 };
    ticking = true;
    try {
      const at = now();
      const due = dueRoutines(snapshot(), at);
      if (due.length === 0) { reschedule(); return { fired: 0, deferred: 0 }; }
      // Locked vault: can't run an agent turn. Leave the due routines' nextRunAt
      // in the past so the unlock re-tick fires them; just re-arm so the alarm
      // that woke us is replaced (and, if unlock never re-ticks, it fires again).
      if (isLocked()) {
        emit('schedule/deferred', { count: due.length });
        reschedule();
        return { fired: 0, deferred: due.length };
      }
      let fired = 0;
      for (const routine of due) {
        // Advance FIRST (in-memory + persisted) so a crash mid-fire — or an
        // overlapping wake — can't double-fire this slot. The next run is the
        // first future slot from now, collapsing any missed slots into one.
        routine.nextRunAt = computeNextRun(routine.schedule, at, routine.createdAt);
        routine.lastRunAt = at;
        routine.runCount += 1;
        persist();
        emit('schedule/firing', { id: routine.id, prompt: routine.prompt });
        // Fire-and-forget: a firing is a whole agent run; awaiting it would
        // serialize routines and block the wake. Record its session id when it
        // resolves. Rejections are swallowed so one bad routine can't wedge tick.
        Promise.resolve()
          .then(() => fireRoutine(routine))
          .then((res) => {
            const sid = res && typeof res === 'object' ? res.sessionId : undefined;
            if (sid && routines.get(routine.id) === routine) { routine.lastSessionId = sid; persist(); }
          })
          .catch((e) => console.error('[schedule] fireRoutine threw', e));
        fired += 1;
      }
      reschedule();
      return { fired, deferred: 0 };
    } finally {
      ticking = false;
    }
  };

  /**
   * Rehydrate routines from the durable mirror on SW boot. A no-op without kv or
   * with nothing stored. Does NOT fire anything — the caller ticks() afterward so
   * the locked/unlocked decision is made in one place. Idempotent: skips ids
   * already live in memory.
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
    // exposed for the tool result / notes
    describe: describeSchedule,
  });
};
