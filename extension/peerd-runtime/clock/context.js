// @ts-check
// Temporal block formatter.
//
// Pure function from (lastTurnAt, nowMs) → the compact <time> string
// injected per turn. No side effects, no clock reads — everything is
// parameterized for testability.
//
// Design (owner direction, 2026-06-12): the block communicates exactly
// ONE thing beyond the absolute clock — the general passage of time
// since the user's previous message. There is a big difference between
// a fast follow-up and a message hours or days later; sometimes it
// matters, sometimes it doesn't, so the block is the MINIMAL context
// that lets the prompt make it relevant when it is. Everything else the
// old block carried (cryptic "t+" notation the model had to guess at,
// idle markers, a tab/sleep/network event list) was bloat that actively
// confused models in the field — gone, along with the background event
// recorder that fed it.
//
// Output shapes:
//   first turn, or a fast follow-up (<60s):
//     <time>now 2026-06-05T14:34:21Z</time>
//   a real gap:
//     <time>now 2026-06-05T14:34:21Z · 2h 1m since the user's previous message</time>
//
// The elapsed clause is plain words, not notation — self-describing, so
// the model never has to infer what a marker means or when the tag was
// stamped.

import { isoSecondsZ } from './now.js';

// Below this, a follow-up reads as "the same sitting" — saying "42s
// since the user's previous message" is noise, not signal.
const ELAPSED_NOISE_FLOOR_MS = 60_000;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Coarse, human-scale elapsed rendering. Deliberately lossy: the point
 * is "minutes vs hours vs days", not precision — `now()` exists when
 * the model needs exact arithmetic.
 *
 *   90s        → "1m"
 *   47m        → "47m"
 *   2h 1m      → "2h 1m"   (whole hours render bare: "3h")
 *   3d 7h      → "3 days"  (beyond a day, hours stop mattering)
 *
 * @param {number} ms
 * @returns {string}
 */
export const coarseElapsed = (ms) => {
  if (ms >= DAY) {
    const days = Math.floor(ms / DAY);
    return days === 1 ? '1 day' : `${days} days`;
  }
  if (ms >= HOUR) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MIN);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.max(1, Math.floor(ms / MIN))}m`;
};

/**
 * @param {Object} args
 * @param {number | null} args.lastTurnAt   ms; null for the first turn
 * @param {number} args.nowMs               ms — current wall time
 * @returns {string}                        the <time>…</time> block
 */
export const buildTemporalBlock = ({ lastTurnAt, nowMs }) => {
  const parts = [`now ${isoSecondsZ(nowMs)}`];
  if (lastTurnAt != null) {
    const gap = nowMs - lastTurnAt;
    if (gap >= ELAPSED_NOISE_FLOOR_MS) {
      parts.push(`${coarseElapsed(gap)} since the user's previous message`);
    }
  }
  return `<time>${parts.join(' · ')}</time>`;
};
