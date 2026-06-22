// normalizeDenylistPattern — the validation gate in front of the user
// denylist editor. Fail-closed: anything the matcher can't honor → null.

import { describe, test, expect } from 'bun:test';
import { normalizeDenylistPattern } from '../../extension/peerd-egress/denylist/denylist.js';

describe('normalizeDenylistPattern', () => {
  test('accepts exact hosts and leading-*. globs, lowercased', () => {
    expect(normalizeDenylistPattern('Chase.com')).toBe('chase.com');
    expect(normalizeDenylistPattern('*.Chase.com')).toBe('*.chase.com');
    expect(normalizeDenylistPattern('  mail.proton.me  ')).toBe('mail.proton.me');
  });

  test('tolerates pasted URLs by stripping scheme/path/port', () => {
    expect(normalizeDenylistPattern('https://chase.com/login?x=1#f')).toBe('chase.com');
    expect(normalizeDenylistPattern('http://bank.example.org:8443/x')).toBe('bank.example.org');
  });

  test('rejects what the matcher cannot honor', () => {
    expect(normalizeDenylistPattern('')).toBe(null);
    expect(normalizeDenylistPattern('   ')).toBe(null);
    expect(normalizeDenylistPattern('localhost')).toBe(null);        // no dot
    expect(normalizeDenylistPattern('*chase*.com')).toBe(null);      // mid-pattern wildcard
    expect(normalizeDenylistPattern('foo.*.com')).toBe(null);
    expect(normalizeDenylistPattern('cha se.com')).toBe(null);       // space
    expect(normalizeDenylistPattern('-bad.com')).toBe(null);         // label can't start with -
    expect(normalizeDenylistPattern('bad-.com')).toBe(null);         // ...or end with -
    expect(normalizeDenylistPattern('*.')).toBe(null);
    expect(normalizeDenylistPattern(42 as unknown as string)).toBe(null);
  });

  test('round-trips with the matcher', async () => {
    const { matchesDenylist } = await import('../../extension/peerd-egress/denylist/denylist.js');
    const p = normalizeDenylistPattern('*.EVIL.example')!;
    expect(matchesDenylist('sub.evil.example', [p])).toBe(true);
    expect(matchesDenylist('evil.example', [p])).toBe(false);
  });
});
