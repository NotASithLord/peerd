// Pure schedule math (loop/schedule.js): parseSchedule normalizes a user/agent
// spec, computeNextRun answers "when next?" (interval phase-anchored, daily in
// local wall-clock), and the due/wake helpers drive the runner. All exercised
// against fixed timestamps — no clock, no Chrome.

import { describe, it, expect } from 'bun:test';
import {
  parseSchedule, computeNextRun, describeSchedule, dueRoutines, nextWakeAt,
  MIN_INTERVAL_MS,
} from '../../../extension/peerd-runtime/loop/schedule.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('parseSchedule', () => {
  it('parses an interval duration string', () => {
    expect(parseSchedule({ every: '30m' })).toEqual({ kind: 'interval', everyMs: 30 * MIN });
    expect(parseSchedule({ every: '6h' })).toEqual({ kind: 'interval', everyMs: 6 * HOUR });
    expect(parseSchedule({ every: '1d' })).toEqual({ kind: 'interval', everyMs: DAY });
  });

  it('floors sub-minute intervals at MIN_INTERVAL_MS', () => {
    expect(parseSchedule({ every: '5s' })).toEqual({ kind: 'interval', everyMs: MIN_INTERVAL_MS });
  });

  it('parses a daily HH:MM into minutes since local midnight', () => {
    expect(parseSchedule({ dailyAt: '08:00' })).toEqual({ kind: 'daily', atMinutes: 480 });
    expect(parseSchedule({ dailyAt: '00:00' })).toEqual({ kind: 'daily', atMinutes: 0 });
    expect(parseSchedule({ dailyAt: '23:59' })).toEqual({ kind: 'daily', atMinutes: 23 * 60 + 59 });
  });

  it('interval wins when both fields are supplied (more explicit)', () => {
    expect(parseSchedule({ every: '1h', dailyAt: '08:00' })).toEqual({ kind: 'interval', everyMs: HOUR });
  });

  it('rejects malformed or empty specs', () => {
    expect(parseSchedule({})).toBeNull();
    expect(parseSchedule({ every: 'soon' })).toBeNull();
    expect(parseSchedule({ every: '' })).toBeNull();
    expect(parseSchedule({ dailyAt: '25:00' })).toBeNull();
    expect(parseSchedule({ dailyAt: '8am' })).toBeNull();
    expect(parseSchedule(null as any)).toBeNull();
  });
});

describe('computeNextRun — interval', () => {
  const schedule = { kind: 'interval' as const, everyMs: HOUR };
  const anchor = 1_000_000; // arbitrary creation time

  it('returns the first slot strictly after fromMs', () => {
    // fresh: from === anchor → one interval out
    expect(computeNextRun(schedule, anchor, anchor)).toBe(anchor + HOUR);
    // mid-interval → still the next grid point
    expect(computeNextRun(schedule, anchor + 10 * MIN, anchor)).toBe(anchor + HOUR);
  });

  it('collapses many missed intervals into the next FUTURE grid slot (catch-up)', () => {
    // browser was off for 3.5 intervals → next run is the 4th slot, not slot 1
    const from = anchor + 3 * HOUR + 30 * MIN;
    expect(computeNextRun(schedule, from, anchor)).toBe(anchor + 4 * HOUR);
  });

  it('stays phase-stable to the anchor grid', () => {
    const from = anchor + 2 * HOUR; // exactly on a grid point → strictly-after gives next
    expect(computeNextRun(schedule, from, anchor)).toBe(anchor + 3 * HOUR);
  });
});

describe('computeNextRun — daily (local wall-clock)', () => {
  const schedule = { kind: 'daily' as const, atMinutes: 8 * 60 }; // 08:00 local

  // Build a local timestamp so the assertion is timezone-agnostic.
  const localAt = (y: number, mo: number, d: number, h: number, mi: number) =>
    new Date(y, mo, d, h, mi, 0, 0).getTime();

  it('returns today 08:00 when it is still ahead', () => {
    const from = localAt(2026, 6, 15, 6, 0); // 06:00 local
    expect(computeNextRun(schedule, from, 0)).toBe(localAt(2026, 6, 15, 8, 0));
  });

  it('rolls to tomorrow 08:00 once today has passed', () => {
    const from = localAt(2026, 6, 15, 9, 0); // 09:00 local — past 08:00
    expect(computeNextRun(schedule, from, 0)).toBe(localAt(2026, 6, 16, 8, 0));
  });

  it('rolls to tomorrow when exactly at the trigger (strictly-after)', () => {
    const from = localAt(2026, 6, 15, 8, 0);
    expect(computeNextRun(schedule, from, 0)).toBe(localAt(2026, 6, 16, 8, 0));
  });
});

describe('describeSchedule', () => {
  it('renders compact interval labels', () => {
    expect(describeSchedule({ kind: 'interval', everyMs: 30 * MIN })).toBe('every 30m');
    expect(describeSchedule({ kind: 'interval', everyMs: 6 * HOUR })).toBe('every 6h');
    expect(describeSchedule({ kind: 'interval', everyMs: 2 * DAY })).toBe('every 2d');
  });

  it('renders a zero-padded daily label', () => {
    expect(describeSchedule({ kind: 'daily', atMinutes: 8 * 60 })).toBe('daily at 08:00');
    expect(describeSchedule({ kind: 'daily', atMinutes: 9 * 60 + 5 })).toBe('daily at 09:05');
  });
});

describe('dueRoutines / nextWakeAt', () => {
  const routines = [
    { id: 'a', enabled: true, nextRunAt: 100 },
    { id: 'b', enabled: true, nextRunAt: 300 },
    { id: 'c', enabled: false, nextRunAt: 50 },   // disabled → never due / never a wake
  ];

  it('returns only enabled routines at or before now', () => {
    expect(dueRoutines(routines, 200).map((r) => r.id)).toEqual(['a']);
    expect(dueRoutines(routines, 50).map((r) => r.id)).toEqual([]);   // c disabled
    expect(dueRoutines(routines, 300).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('picks the soonest enabled nextRunAt as the wake time', () => {
    expect(nextWakeAt(routines)).toBe(100);
    expect(nextWakeAt([{ enabled: false, nextRunAt: 5 }])).toBeNull();
    expect(nextWakeAt([])).toBeNull();
  });
});
