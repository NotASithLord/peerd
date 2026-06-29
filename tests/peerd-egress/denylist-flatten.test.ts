// flattenCategorisedDenylist — the seed denylist JSON groups patterns by
// category (banks_us, health_us, …) for human readability; the matcher just
// wants the flat list. These pin the flatten contract in the Bun suite (the
// in-browser tier covers the happy path; the bypass-shaped edges + the
// flatten→match round-trip live here) — a flatten that silently drops or
// reorders patterns would punch a hole in the denylist without failing the
// matcher's own tests.

import { describe, test, expect } from 'bun:test';
import {
  flattenCategorisedDenylist,
  findDenylistMatch,
} from '../../extension/peerd-egress/denylist/denylist.js';

describe('flattenCategorisedDenylist — shape handling', () => {
  test('flattens multiple categories, preserving order', () => {
    const seed = {
      categories: {
        banks_us: ['chase.com', '*.chase.com'],
        health_us: ['mychart.com'],
      },
    };
    expect(flattenCategorisedDenylist(seed)).toEqual([
      'chase.com',
      '*.chase.com',
      'mychart.com',
    ]);
  });

  test('an empty category contributes nothing', () => {
    const seed = { categories: { banks_us: ['chase.com'], empty: [] } };
    expect(flattenCategorisedDenylist(seed)).toEqual(['chase.com']);
  });

  // why: every "not really the seed shape" input must fail closed to [] — a
  // thrown error or a non-array return would break callers that spread the
  // result straight into the matcher's pattern list.
  test('missing / empty / nullish inputs all yield []', () => {
    expect(flattenCategorisedDenylist({ categories: {} })).toEqual([]);
    expect(flattenCategorisedDenylist({})).toEqual([]);
    expect(flattenCategorisedDenylist(null)).toEqual([]);
    expect(flattenCategorisedDenylist(undefined)).toEqual([]);
  });
});

describe('flattenCategorisedDenylist — round-trips into the matcher', () => {
  // The real call site: load the categorised seed, flatten it, then match
  // live hostnames against the flat list. This guards the seam between the
  // two pure functions, not either one in isolation.
  const patterns = flattenCategorisedDenylist({
    categories: {
      banks_us: ['chase.com', '*.chase.com'],
      mail: ['*.proton.me'],
    },
  });

  test('flattened patterns block the apex and its subdomains', () => {
    expect(findDenylistMatch('chase.com', patterns)).toBe('chase.com');
    expect(findDenylistMatch('login.chase.com', patterns)).toBe('*.chase.com');
    expect(findDenylistMatch('mail.proton.me', patterns)).toBe('*.proton.me');
  });

  test('flattening does not let a lookalike host through', () => {
    expect(findDenylistMatch('evilchase.com', patterns)).toBe(null);
    expect(findDenylistMatch('protonmail.com', patterns)).toBe(null);
  });
});
