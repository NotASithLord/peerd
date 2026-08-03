import { describe, test, expect } from 'bun:test';
import {
  coarseElapsed,
  buildTemporalBlock,
} from '../../extension/peerd-runtime/clock/context.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('coarseElapsed', () => {
  test('floors sub-minute gaps up to at least 1m', () => {
    expect(coarseElapsed(0)).toBe('1m');
    expect(coarseElapsed(30 * 1000)).toBe('1m');
    expect(coarseElapsed(90 * 1000)).toBe('1m');
  });

  test('renders whole minutes below an hour', () => {
    expect(coarseElapsed(47 * MIN)).toBe('47m');
    expect(coarseElapsed(59 * MIN + 59 * 1000)).toBe('59m');
  });

  test('renders whole hours bare and adds trailing minutes otherwise', () => {
    expect(coarseElapsed(HOUR)).toBe('1h');
    expect(coarseElapsed(3 * HOUR)).toBe('3h');
    expect(coarseElapsed(2 * HOUR + 1 * MIN)).toBe('2h 1m');
    expect(coarseElapsed(23 * HOUR + 59 * MIN)).toBe('23h 59m');
  });

  test('renders days and drops the hours beyond a day', () => {
    expect(coarseElapsed(DAY)).toBe('1 day');
    expect(coarseElapsed(2 * DAY)).toBe('2 days');
    expect(coarseElapsed(3 * DAY + 7 * HOUR)).toBe('3 days');
  });
});

describe('buildTemporalBlock', () => {
  const nowMs = Date.UTC(2026, 5, 5, 14, 34, 21);
  const now = 'now 2026-06-05T14:34:21Z';

  test('emits a bare block on the first turn', () => {
    expect(buildTemporalBlock({ lastTurnAt: null, nowMs })).toBe(
      `<time>${now}</time>`,
    );
  });

  test('omits the elapsed clause for a fast follow-up under the noise floor', () => {
    expect(buildTemporalBlock({ lastTurnAt: nowMs - 30 * 1000, nowMs })).toBe(
      `<time>${now}</time>`,
    );
  });

  test('appends the elapsed clause once the gap reaches the noise floor', () => {
    expect(buildTemporalBlock({ lastTurnAt: nowMs - MIN, nowMs })).toBe(
      `<time>${now} · 1m since the user's previous message</time>`,
    );
  });

  test('appends a coarse elapsed clause for a real gap', () => {
    expect(
      buildTemporalBlock({ lastTurnAt: nowMs - (2 * HOUR + 1 * MIN), nowMs }),
    ).toBe(`<time>${now} · 2h 1m since the user's previous message</time>`);
  });
});
