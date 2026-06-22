// Denylist editor helpers — pure values-in/values-out, so they live on
// the bun surface (the Mithril component itself is covered by the
// in-browser tests at extension/tests/unit/sidepanel/).

import { describe, test, expect } from 'bun:test';
import {
  filterPatterns,
  denylistModel,
  removalCopy,
} from '../../extension/sidepanel/components/denylist-format.js';

const PATTERNS = ['chase.com', '*.chase.com', 'mail.proton.me', 'evil.example'];

describe('denylist-format', () => {
  describe('filterPatterns', () => {
    test('empty / blank queries pass everything through', () => {
      expect(filterPatterns(PATTERNS, '')).toEqual(PATTERNS);
      expect(filterPatterns(PATTERNS, '   ')).toEqual(PATTERNS);
      expect(filterPatterns(PATTERNS, undefined as any)).toEqual(PATTERNS);
    });

    test('matches case-insensitive substrings', () => {
      expect(filterPatterns(PATTERNS, 'CHASE')).toEqual(['chase.com', '*.chase.com']);
      expect(filterPatterns(PATTERNS, 'proton')).toEqual(['mail.proton.me']);
      // Mid-pattern fragments count — it's navigation, not matching policy.
      expect(filterPatterns(PATTERNS, '.com')).toEqual(['chase.com', '*.chase.com']);
    });

    test('trims the query and returns a fresh array', () => {
      expect(filterPatterns(PATTERNS, '  chase ')).toEqual(['chase.com', '*.chase.com']);
      const out = filterPatterns(PATTERNS, '');
      expect(out).not.toBe(PATTERNS); // caller can sort/mutate safely
    });

    test('no match returns empty', () => {
      expect(filterPatterns(PATTERNS, 'zzz')).toEqual([]);
    });
  });

  describe('denylistModel', () => {
    const DATA = {
      patterns: PATTERNS,            // effective list
      added: ['evil.example'],       // user overlay
      disabled: ['*.fidelity.com'],  // disabled seed
    };

    test('tags provenance from the added overlay', () => {
      const { active } = denylistModel(DATA, '');
      expect(active).toEqual([
        { pattern: 'chase.com', user: false },
        { pattern: '*.chase.com', user: false },
        { pattern: 'mail.proton.me', user: false },
        { pattern: 'evil.example', user: true },
      ]);
    });

    test('counts span BOTH sections so n-of-N is honest', () => {
      const all = denylistModel(DATA, '');
      expect(all.filtered).toBe(false);
      expect(all.shown).toBe(5);
      expect(all.total).toBe(5);

      const narrowed = denylistModel(DATA, 'fidelity');
      expect(narrowed.filtered).toBe(true);
      expect(narrowed.active).toEqual([]);
      expect(narrowed.disabled).toEqual(['*.fidelity.com']);
      expect(narrowed.shown).toBe(1);
      expect(narrowed.total).toBe(5);
    });

    test('blank query is not "filtered"', () => {
      expect(denylistModel(DATA, '  ').filtered).toBe(false);
    });

    test('tolerates a missing overlay (loading / error shapes)', () => {
      const model = denylistModel({}, 'x');
      expect(model.active).toEqual([]);
      expect(model.disabled).toEqual([]);
      expect(model.total).toBe(0);
    });
  });

  describe('removalCopy', () => {
    test('user-added patterns get a true Remove', () => {
      const { verb, consequence } = removalCopy('evil.example', true);
      expect(verb).toBe('Remove');
      expect(consequence).toContain('peerd will be able to act on evil.example again');
      // No false promise of reversibility-by-re-enable on a deleted row.
      expect(consequence).not.toContain('re-enable');
    });

    test('seed patterns get Disable and say so', () => {
      const { verb, consequence } = removalCopy('chase.com', false);
      expect(verb).toBe('Disable');
      expect(consequence).toContain('peerd will be able to act on chase.com again');
      expect(consequence).toContain("can't be deleted");
      expect(consequence).toContain('re-enable');
    });
  });
});
