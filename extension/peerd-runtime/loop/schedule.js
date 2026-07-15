// @ts-check
// peerd-runtime/loop/schedule — pure schedule math for background Routines.
//
// A Routine is a standing task the user (or the agent) registers to run
// unattended on a cadence: "summarize my open tabs every morning", "check the
// release feed every 6h". This file is the FUNCTIONAL CORE — "when does this run
// next?" and "which routines are due?" — with no Chrome APIs, no timers, no
// storage. loop/scheduler.js is the imperative shell that fires them and mirrors
// them to storage; the SW is what wires an alarm to a wake. Keeping the math here
// makes it Bun-testable against a fake clock (schedule.test.ts).
//
// Two schedule kinds cover the common routines without a cron parser:
//   { kind: 'interval', everyMs }   — every N ms from the creation anchor
//   { kind: 'daily', atMinutes }    — daily at a LOCAL wall-clock time
// (minutes since local midnight). why local, not UTC: "every morning" means the
// user's morning; computeNextRun uses the runtime's own timezone via Date.

import { parseDuration } from '../clock/now.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// why a floor: chrome.alarms itself clamps sub-minute periods (and a routine
// firing an agent run every few seconds is never what the user meant). Match it
// so an over-eager "every 5s" becomes a sane "every 1m" instead of silently
// behaving unlike the string the user typed.
export const MIN_INTERVAL_MS = MINUTE_MS;

/**
 * @typedef {{ kind: 'interval', everyMs: number } | { kind: 'daily', atMinutes: number }} Schedule
 */

/** Parse "HH:MM" (24h local) → minutes since midnight, or null if malformed. */
const parseClock = (/** @type {string} */ s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
};

/**
 * Normalize a user/agent schedule spec into a Schedule, or null if neither
 * field is a valid form. Exactly one of `every` / `dailyAt` is honored
 * (`every` wins if both are given — an interval is the more explicit ask).
 *
 * @param {{ every?: string, dailyAt?: string }} spec
 * @returns {Schedule | null}
 */
export const parseSchedule = (spec) => {
  if (!spec || typeof spec !== 'object') return null;
  if (typeof spec.every === 'string' && spec.every.trim()) {
    const everyMs = parseDuration(spec.every);
    if (!Number.isFinite(everyMs) || everyMs <= 0) return null;
    return { kind: 'interval', everyMs: Math.max(MIN_INTERVAL_MS, everyMs) };
  }
  if (typeof spec.dailyAt === 'string' && spec.dailyAt.trim()) {
    const atMinutes = parseClock(spec.dailyAt);
    if (atMinutes == null) return null;
    return { kind: 'daily', atMinutes };
  }
  return null;
};

// Local wall-clock time `atMinutes` on the calendar day of `baseMs`. setMinutes
// overflows cleanly into hours (atMinutes up to 1439), and going through a Date
// keeps the result in the runtime's timezone.
const atLocalMinutes = (/** @type {number} */ baseMs, /** @type {number} */ atMinutes) => {
  const d = new Date(baseMs);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(atMinutes);
  return d.getTime();
};

/**
 * The next run time STRICTLY AFTER `fromMs`.
 *
 * - interval: the first `anchorMs + k*everyMs` that exceeds `fromMs`. Anchoring
 *   on the creation time (not on fromMs) keeps the cadence phase-stable across a
 *   downtime — if the browser was off for three intervals, the next run lands on
 *   the grid, not three intervals from whenever it happened to wake.
 * - daily: today's local `atMinutes` if still ahead, else tomorrow's. setDate(+1)
 *   crosses month/DST boundaries correctly (unlike adding a fixed 24h).
 *
 * @param {Schedule} schedule
 * @param {number} fromMs
 * @param {number} anchorMs   the routine's createdAt (interval phase anchor)
 * @returns {number}
 */
export const computeNextRun = (schedule, fromMs, anchorMs) => {
  if (schedule.kind === 'interval') {
    const elapsed = fromMs - anchorMs;
    const steps = elapsed < 0 ? 0 : Math.floor(elapsed / schedule.everyMs) + 1;
    return anchorMs + steps * schedule.everyMs;
  }
  const today = atLocalMinutes(fromMs, schedule.atMinutes);
  if (today > fromMs) return today;
  const d = new Date(fromMs);
  d.setDate(d.getDate() + 1);
  return atLocalMinutes(d.getTime(), schedule.atMinutes);
};

/**
 * Compact human description of a schedule — for the tool result and notes.
 * @param {Schedule} schedule
 * @returns {string}
 */
export const describeSchedule = (schedule) => {
  if (schedule.kind === 'interval') {
    // EXACT cadence — no lossy minute-rounding (a 90s interval must not read as
    // "2m"). Decompose everyMs into d/h/m/s and join the nonzero parts.
    let rest = Math.max(0, Math.round(schedule.everyMs / 1000)); // whole seconds
    const d = Math.floor(rest / 86_400); rest %= 86_400;
    const h = Math.floor(rest / 3_600); rest %= 3_600;
    const m = Math.floor(rest / 60); const s = rest % 60;
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    if (s) parts.push(`${s}s`);
    return `every ${parts.join('') || '0s'}`;
  }
  const h = Math.floor(schedule.atMinutes / 60);
  const m = schedule.atMinutes % 60;
  return `daily at ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

/**
 * The enabled routines whose next run is due at or before `nowMs`.
 * @template {{ enabled?: boolean, nextRunAt: number }} R
 * @param {R[]} routines
 * @param {number} nowMs
 * @returns {R[]}
 */
export const dueRoutines = (routines, nowMs) =>
  routines.filter((r) => r.enabled !== false && Number.isFinite(r.nextRunAt) && r.nextRunAt <= nowMs);

/**
 * The soonest upcoming run across enabled routines, or null when none are
 * scheduled — the timestamp the scheduler arms its single alarm for.
 * @param {{ enabled?: boolean, nextRunAt: number }[]} routines
 * @returns {number | null}
 */
export const nextWakeAt = (routines) => {
  let soonest = null;
  for (const r of routines) {
    if (r.enabled === false || !Number.isFinite(r.nextRunAt)) continue;
    if (soonest == null || r.nextRunAt < soonest) soonest = r.nextRunAt;
  }
  return soonest;
};
