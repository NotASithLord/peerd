// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// Clock tools: now, wait_until.
//
// On-demand precision for when the per-turn temporal block isn't enough.
// Both are pure-ish (read Date.now or schedule a timer); no chrome.*
// dependency, so they work identically in the SW and in tests.
//
// (A now()-checkpoint + time_since pair used to live here. Ripped out
// 2026-06-12 by owner direction: the checkpoint store was an in-memory
// Map in an MV3 service worker that restarts constantly, so checkpoints
// silently evaporated — "doesn't seem to work very well" was structural,
// not a bug. The model can subtract two now() readings when it needs an
// interval.)

import { sleep } from '/shared/util.js';
import { formatDelta, isoSecondsZ, parseDuration } from './now.js';

/**
 * Hard cap on wait duration. We don't let the agent freeze a turn for
 * longer than this — the user may want to step in, and the SW must stay
 * alive (offscreen keepalive) for the whole blocking sleep, with no
 * persist/resume if it's evicted mid-wait. 1 hour is the ceiling; for
 * "wait then check" patterns the agent can still chain shorter waits
 * across turns (more resilient than one long block).
 */
const WAIT_MAX_MS = 60 * 60 * 1000;

/** @type {import('/shared/tool-types.js').Tool} */
export const nowTool = composeTool("now", {
  execute: async () => {
    const ms = Date.now();
    const d = new Date(ms);
    return {
      ok: true,
      content: JSON.stringify({
        iso:        isoSecondsZ(ms),
        unixMs:     ms,
        timezone:   Intl.DateTimeFormat().resolvedOptions().timeZone,
        dayOfWeek:  d.toLocaleString('en-US', { weekday: 'long' }),
      }, null, 2),
    };
  },
});

/** @type {import('/shared/tool-types.js').Tool} */
export const waitUntilTool = composeTool("wait_until", {
  execute: async ({ when }) => {
    if (typeof when !== 'string' || !when) {
      return { ok: false, error: 'wait_until requires a duration or ISO timestamp string.' };
    }
    const targetMs = resolveTarget(when);
    if (targetMs === null) {
      return { ok: false, error: `wait_until: could not parse "${when}" as a duration or ISO timestamp.` };
    }
    const durationMs = Math.max(0, targetMs - Date.now());
    if (durationMs > WAIT_MAX_MS) {
      return {
        ok: false,
        error: `wait_until refuses to block for more than ${formatDelta(WAIT_MAX_MS)} (asked: ${formatDelta(durationMs)}).`,
      };
    }

    await sleep(durationMs);
    return {
      ok: true,
      content: JSON.stringify({
        waited:    formatDelta(durationMs),
        waitedMs:  durationMs,
        resumedAt: isoSecondsZ(),
      }, null, 2),
    };
  },
});

/** @type {import('/shared/tool-types.js').Tool[]} */
export const CLOCK_TOOLS = [nowTool, waitUntilTool];

// ---- helpers --------------------------------------------------------------

/**
 * @param {string} when
 * @returns {number | null}
 */
const resolveTarget = (when) => {
  // Try ISO first — Date.parse will succeed on relaxed inputs too
  // (e.g. "2026-06-05 14:34"), which is fine; we constrain the doc to
  // ISO but accept what Date can read.
  const parsed = Date.parse(when);
  if (Number.isFinite(parsed)) return parsed;
  const dur = parseDuration(when);
  if (Number.isFinite(dur)) return Date.now() + dur;
  return null;
};

