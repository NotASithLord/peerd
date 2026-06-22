// @ts-check
// Temporal block formatter — buildTemporalBlock() + coarseElapsed().
//
// Pure function tests. The block's whole contract (owner direction,
// 2026-06-12): absolute now, plus a plain-words coarse elapsed since
// the user's previous message — and ONLY when the gap is notable.
// Self-describing, no notation the model has to guess at.

import { describe, it, expect } from '../../../framework.js';
import { buildTemporalBlock, coarseElapsed } from '/peerd-runtime/clock/context.js';

const T0 = Date.parse('2026-06-05T14:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('clock.context', () => {
  describe('buildTemporalBlock', () => {
    it('first turn: absolute timestamp only', () => {
      const out = buildTemporalBlock({ lastTurnAt: null, nowMs: T0 });
      expect(out).toBe('<time>now 2026-06-05T14:00:00Z</time>');
    });

    it('fast follow-up (<60s): no elapsed clause — same sitting', () => {
      const out = buildTemporalBlock({ lastTurnAt: T0, nowMs: T0 + 47_000 });
      expect(out).toBe('<time>now 2026-06-05T14:00:47Z</time>');
    });

    it('a real gap renders in plain words', () => {
      const out = buildTemporalBlock({ lastTurnAt: T0, nowMs: T0 + 2 * HOUR + MIN });
      expect(out).toBe(
        "<time>now 2026-06-05T16:01:00Z · 2h 1m since the user's previous message</time>");
    });

    it('multi-day gap renders as days', () => {
      const out = buildTemporalBlock({ lastTurnAt: T0, nowMs: T0 + 3 * DAY + 7 * HOUR });
      expect(out).toBe(
        "<time>now 2026-06-08T21:00:00Z · 3 days since the user's previous message</time>");
    });
  });

  describe('coarseElapsed', () => {
    it('floors to whole minutes under an hour', () => {
      expect(coarseElapsed(90_000)).toBe('1m');
      expect(coarseElapsed(47 * MIN + 30_000)).toBe('47m');
    });

    it('renders hours with minutes, bare when on the hour', () => {
      expect(coarseElapsed(2 * HOUR + MIN)).toBe('2h 1m');
      expect(coarseElapsed(3 * HOUR)).toBe('3h');
    });

    it('beyond a day, days only — hours stop mattering', () => {
      expect(coarseElapsed(DAY)).toBe('1 day');
      expect(coarseElapsed(3 * DAY + 7 * HOUR)).toBe('3 days');
    });
  });
});
