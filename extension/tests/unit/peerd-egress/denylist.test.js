// @ts-check
// Denylist matcher tests.
//
// The boundary cases here are the bugs we want to catch — a naive
// endsWith() or substring matcher would pass the happy-path tests and
// silently fail the adversarial ones.

import { describe, it, expect } from '../../framework.js';
import {
  matchesDenylist,
  findDenylistMatch,
  flattenCategorisedDenylist,
} from '/peerd-egress/index.js';

describe('denylist', () => {
  describe('matchesDenylist — exact match', () => {
    it('matches exact host', () => {
      expect(matchesDenylist('chase.com', ['chase.com'])).toBe(true);
    });
    it('does NOT match subdomain when only the apex is listed', () => {
      expect(matchesDenylist('login.chase.com', ['chase.com'])).toBe(false);
    });
    it('does NOT match unrelated host', () => {
      expect(matchesDenylist('example.com', ['chase.com'])).toBe(false);
    });
    it('is case-insensitive on both sides', () => {
      expect(matchesDenylist('CHASE.COM', ['chase.com'])).toBe(true);
      expect(matchesDenylist('chase.com', ['CHASE.COM'])).toBe(true);
    });
  });

  describe('matchesDenylist — *.subdomain wildcard', () => {
    it('matches a direct subdomain', () => {
      expect(matchesDenylist('login.chase.com', ['*.chase.com'])).toBe(true);
    });
    it('matches a deeper subdomain', () => {
      expect(matchesDenylist('a.b.chase.com', ['*.chase.com'])).toBe(true);
    });
    it('does NOT match the apex itself', () => {
      // By convention *.chase.com is "any subdomain"; the apex is a
      // separate concept and the seed lists both apex + wildcard.
      expect(matchesDenylist('chase.com', ['*.chase.com'])).toBe(false);
    });
    it('does NOT match a host that is a substring suffix', () => {
      // Guard against endsWith() bugs: 'evilchase.com'.endsWith('chase.com')
      // is true, but `*.chase.com` requires a `.` boundary.
      expect(matchesDenylist('evilchase.com', ['*.chase.com'])).toBe(false);
    });
    it('does NOT match a host that contains the pattern as substring', () => {
      // The bug we are guarding against: a naive endsWith on `*.proton.me`
      // → `.proton.me` could match `protonmail.com` if the matcher does
      // hostname-as-string suffix checks without the dot boundary.
      expect(matchesDenylist('protonmail.com', ['*.proton.me'])).toBe(false);
    });
  });

  describe('findDenylistMatch', () => {
    it('returns the matched pattern', () => {
      const patterns = ['chase.com', '*.chase.com'];
      expect(findDenylistMatch('login.chase.com', patterns)).toBe('*.chase.com');
    });
    it('returns null when no pattern matches', () => {
      expect(findDenylistMatch('example.com', ['chase.com'])).toBe(null);
    });
    it('returns null on empty pattern list', () => {
      expect(findDenylistMatch('chase.com', [])).toBe(null);
    });
  });

  describe('flattenCategorisedDenylist', () => {
    it('flattens the seed JSON shape', () => {
      const input = { categories: { banks: ['chase.com'], health: ['mychart.com', '*.mychart.com'] } };
      const out = flattenCategorisedDenylist(input);
      expect(out).toEqual(['chase.com', 'mychart.com', '*.mychart.com']);
    });
    it('returns [] on missing categories key', () => {
      expect(flattenCategorisedDenylist({})).toEqual([]);
      expect(flattenCategorisedDenylist(null)).toEqual([]);
    });
  });
});
