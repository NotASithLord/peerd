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

// ── grouping (P4) ───────────────────────────────────────────────────────────
// The seed ships 164 patterns already categorised. Flat, that was a wall nobody
// read; grouped, the page answers "what am I protected from" at a glance. What
// these pin is the part that could quietly lie: the counts, and whether a group
// can vanish.
import { groupDenylist, categoryLabel } from '../../extension/sidepanel/components/denylist-format.js';

const CATS = {
  banks_us: ['chase.com', '*.chase.com', 'wellsfargo.com'],
  health_us: ['uhc.com', 'cigna.com'],
};

const rows = (...ps: string[]) => ps.map((p) => ({ pattern: p, user: false }));

describe('groupDenylist', () => {
  test('counts come from the DATA — shown vs the category\'s real total', () => {
    // A hardcoded count is how a UI starts lying about what is enforced.
    const g = groupDenylist(rows('uhc.com'), CATS, [...CATS.banks_us, ...CATS.health_us]);
    const health = g.find((x) => x.key === 'health_us')!;
    expect(health.shown).toBe(1);
    expect(health.total).toBe(2);
    expect(health.label).toBe('Health (US)');
  });

  test('a category with no search hits STAYS listed at 0 of N', () => {
    // Dropping empty groups reads as "these protections do not exist".
    const g = groupDenylist(rows('uhc.com'), CATS, [...CATS.banks_us, ...CATS.health_us]);
    const banks = g.find((x) => x.key === 'banks_us')!;
    expect(banks.shown).toBe(0);
    expect(banks.total).toBe(3);
    expect(g.length).toBe(2);           // both categories present
  });

  test("the user's own patterns lead, and are marked as theirs", () => {
    const active = [{ pattern: 'mybank.example', user: true }, ...rows('chase.com')];
    const g = groupDenylist(active, CATS, ['mybank.example', ...CATS.banks_us, ...CATS.health_us]);
    expect(g[0].key).toBe('__user');
    expect(g[0].label).toBe('Your patterns');
    expect(g[0].user).toBe(true);
    expect(g[0].rows.map((r) => r.pattern)).toEqual(['mybank.example']);
  });

  test('a seed pattern in NO category still surfaces under Your patterns', () => {
    // A taxonomy gap must never hide an enforced pattern.
    const g = groupDenylist(rows('orphan.example'), CATS, ['orphan.example', ...CATS.banks_us]);
    expect(g[0].rows.map((r) => r.pattern)).toEqual(['orphan.example']);
  });

  test('no user patterns and no orphans → no Your-patterns group at all', () => {
    const g = groupDenylist(rows('chase.com'), CATS, [...CATS.banks_us, ...CATS.health_us]);
    expect(g.some((x) => x.key === '__user')).toBe(false);
  });

  test('an unknown category key renders humanized rather than vanishing', () => {
    const g = groupDenylist(rows('x.test'), { new_sector: ['x.test'] }, ['x.test']);
    expect(g[0].label).toBe('New sector');
  });

  test('no categories at all → one group, nothing lost', () => {
    const g = groupDenylist(rows('a.com', 'b.com'), {}, ['a.com', 'b.com']);
    expect(g.length).toBe(1);
    expect(g[0].shown).toBe(2);
  });

  test('categoryLabel maps every shipped key', () => {
    expect(categoryLabel('banks_us')).toBe('Banks (US)');
    expect(categoryLabel('identity')).toBe('Identity & SSO');
    expect(categoryLabel('password_managers')).toBe('Password managers');
  });
});
