import { describe, test, expect } from 'bun:test';
import {
  formatDelta,
  isoSecondsZ,
  parseDuration,
} from '../../extension/peerd-runtime/clock/now.js';

describe('formatDelta', () => {
  test('returns ? for non-finite input', () => {
    expect(formatDelta(NaN)).toBe('?');
    expect(formatDelta(Infinity)).toBe('?');
  });

  test('clamps sub-second and negative input to 0s', () => {
    expect(formatDelta(-5000)).toBe('0s');
    expect(formatDelta(0)).toBe('0s');
    expect(formatDelta(999)).toBe('0s');
  });

  test('formats seconds and minutes', () => {
    expect(formatDelta(1_000)).toBe('1s');
    expect(formatDelta(47_000)).toBe('47s');
    expect(formatDelta(59_999)).toBe('59s');
    expect(formatDelta(60_000)).toBe('1m');
    expect(formatDelta(5 * 60_000)).toBe('5m');
  });

  test('formats hours, adding minutes only when nonzero', () => {
    expect(formatDelta(3_600_000)).toBe('1h');
    expect(formatDelta(3_600_000 + 60_000)).toBe('1h1m');
    expect(formatDelta(2 * 3_600_000 + 3 * 60_000)).toBe('2h3m');
  });

  test('formats days, adding hours only when nonzero', () => {
    expect(formatDelta(86_400_000)).toBe('1d');
    expect(formatDelta(86_400_000 + 3_600_000)).toBe('1d1h');
    expect(formatDelta(2 * 86_400_000)).toBe('2d');
  });
});

describe('isoSecondsZ', () => {
  test('drops the fractional seconds from the ISO timestamp', () => {
    expect(isoSecondsZ(Date.UTC(2026, 5, 5, 14, 34, 21, 123))).toBe(
      '2026-06-05T14:34:21Z',
    );
  });

  test('formats the unix epoch', () => {
    expect(isoSecondsZ(0)).toBe('1970-01-01T00:00:00Z');
  });

  test('defaults to the current time in the same shape', () => {
    expect(isoSecondsZ()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe('parseDuration', () => {
  test('parses single-unit durations', () => {
    expect(parseDuration('47s')).toBe(47_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('2d')).toBe(172_800_000);
  });

  test('sums multiple units, with or without whitespace between pairs', () => {
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('1h 30m')).toBe(5_400_000);
  });

  test('is case insensitive', () => {
    expect(parseDuration('1H30M')).toBe(5_400_000);
  });

  test('returns NaN for malformed or non-string input', () => {
    expect(parseDuration('')).toBeNaN();
    expect(parseDuration('5')).toBeNaN();
    expect(parseDuration('5x')).toBeNaN();
    expect(parseDuration('5m junk')).toBeNaN();
    expect(parseDuration(123 as unknown as string)).toBeNaN();
  });
});
