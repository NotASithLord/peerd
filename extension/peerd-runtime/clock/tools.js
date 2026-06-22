// @ts-check
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
 * longer than this — the user may want to step in. 10 minutes is
 * generous but bounded.
 */
const WAIT_MAX_MS = 10 * 60 * 1000;

/** @type {import('/shared/tool-types.js').Tool} */
export const nowTool = {
  name: 'now',
  primitive: 'time',
  description: [
    'Get the current ISO timestamp, timezone, and day-of-week.',
    'Use when the per-turn <time> line is not enough precision; to',
    'measure an interval, call now() twice and subtract.',
  ].join(' '),
  schema: { type: 'object', properties: {} },
  sideEffect: 'read',
  origins: () => [],
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
};

/** @type {import('/shared/tool-types.js').Tool} */
export const waitUntilTool = {
  name: 'wait_until',
  primitive: 'time',
  description: [
    'Block the agent for a duration ("47s", "5m", "1h30m") or until an',
    'absolute ISO timestamp ("2026-06-05T14:34:21Z"). Hard cap: 10 minutes.',
    'Use for "wait then check again" patterns (rate-limit cool-down, ',
    'monitoring an external state that updates on its own).',
  ].join(' '),
  schema: {
    type: 'object',
    required: ['when'],
    properties: {
      when: {
        type: 'string',
        description: 'Duration ("5m") or absolute ISO timestamp ("2026-06-05T14:34:21Z").',
      },
    },
  },
  sideEffect: 'write',
  origins: () => [],
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
};

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

