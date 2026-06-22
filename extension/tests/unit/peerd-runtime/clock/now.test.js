// @ts-check
// Clock primitives — pure time math.

import { describe, it, expect } from '../../../framework.js';
import { formatDelta, isoSecondsZ, parseDuration } from '/peerd-runtime/clock/now.js';

describe('clock.now', () => {
  describe('formatDelta', () => {
    it('renders sub-second deltas as 0s', () => {
      expect(formatDelta(0)).toBe('0s');
      expect(formatDelta(999)).toBe('0s');
    });

    it('renders seconds when < 60s', () => {
      expect(formatDelta(1_000)).toBe('1s');
      expect(formatDelta(47_000)).toBe('47s');
      expect(formatDelta(59_999)).toBe('59s');
    });

    it('renders minutes when < 60m', () => {
      expect(formatDelta(60_000)).toBe('1m');
      expect(formatDelta(22 * 60_000)).toBe('22m');
      expect(formatDelta(59 * 60_000 + 999)).toBe('59m');
    });

    it('renders hours when < 24h', () => {
      expect(formatDelta(60 * 60_000)).toBe('1h');
      expect(formatDelta(3_700_000)).toBe('1h1m');
    });

    it('renders days for >= 24h', () => {
      expect(formatDelta(24 * 60 * 60_000)).toBe('1d');
      expect(formatDelta(25 * 60 * 60_000)).toBe('1d1h');
    });

    it('clamps negatives to 0', () => {
      expect(formatDelta(-1000)).toBe('0s');
    });

    it('returns ? for non-finite', () => {
      expect(formatDelta(NaN)).toBe('?');
      expect(formatDelta(Infinity)).toBe('?');
    });
  });

  describe('isoSecondsZ', () => {
    it('strips fractional seconds', () => {
      // why: keep the temporal block compact — 4 chars saved per turn.
      expect(isoSecondsZ(0)).toBe('1970-01-01T00:00:00Z');
      expect(isoSecondsZ(1_716_000_000_000)).toBe('2024-05-18T02:40:00Z');
    });
  });

  describe('parseDuration', () => {
    it('parses single units', () => {
      expect(parseDuration('47s')).toBe(47_000);
      expect(parseDuration('5m')).toBe(300_000);
      expect(parseDuration('2h')).toBe(2 * 60 * 60_000);
      expect(parseDuration('1d')).toBe(24 * 60 * 60_000);
    });
    it('parses compound units', () => {
      expect(parseDuration('1h30m')).toBe(90 * 60_000);
      expect(parseDuration('2h 15m 30s')).toBe(2 * 60 * 60_000 + 15 * 60_000 + 30_000);
    });
    it('returns NaN for junk', () => {
      const bad = ['', '5', '5x', 'abc', '5m abc', 'm', ' '];
      for (const v of bad) expect(Number.isNaN(parseDuration(v))).toBe(true);
    });
    it('is case-insensitive on units', () => {
      expect(parseDuration('5M')).toBe(300_000);
    });
  });
});
