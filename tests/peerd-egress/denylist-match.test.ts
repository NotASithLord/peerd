// findDenylistMatch — host normalization (denylist-bypass guard) + boundary
// correctness. The matcher receives URL.host / URL.hostname values from
// webFetch, the dispatcher origin gate, and the WebVM bridge; a :port or a
// trailing-dot FQDN must NOT slip a denylisted origin past the exact /
// `*.`-suffix checks.

import { describe, test, expect } from 'bun:test';
import { findDenylistMatch, matchesDenylist } from '../../extension/peerd-egress/denylist/denylist.js';

const PATTERNS = ['chase.com', '*.chase.com', '*.proton.me'];

describe('findDenylistMatch — host normalization (bypass guard)', () => {
  test('exact apex still matches', () => {
    expect(findDenylistMatch('chase.com', PATTERNS)).toBe('chase.com');
    expect(findDenylistMatch('mail.chase.com', PATTERNS)).toBe('*.chase.com');
  });

  test('trailing-dot FQDN does NOT bypass', () => {
    expect(findDenylistMatch('chase.com.', PATTERNS)).toBe('chase.com');
    expect(findDenylistMatch('mail.chase.com.', PATTERNS)).toBe('*.chase.com');
  });

  test('non-default port (URL.host form) does NOT bypass', () => {
    expect(findDenylistMatch('chase.com:8443', PATTERNS)).toBe('chase.com');
    expect(findDenylistMatch('mail.chase.com:8443', PATTERNS)).toBe('*.chase.com');
  });

  test('port + trailing dot together do NOT bypass', () => {
    expect(findDenylistMatch('chase.com.:8443', PATTERNS)).toBe('chase.com');
  });

  test('uppercase host is matched', () => {
    expect(findDenylistMatch('CHASE.COM.', PATTERNS)).toBe('chase.com');
    expect(matchesDenylist('Mail.Chase.Com:443', PATTERNS)).toBe(true);
  });
});

describe('findDenylistMatch — boundary correctness (no over-match)', () => {
  test('subdomain wildcard matches a real subdomain, not a substring', () => {
    expect(findDenylistMatch('mail.proton.me', PATTERNS)).toBe('*.proton.me');
    expect(findDenylistMatch('protonmail.com', PATTERNS)).toBe(null);
  });

  test('does not match a lookalike apex or a deeper foreign domain', () => {
    expect(findDenylistMatch('evilchase.com', PATTERNS)).toBe(null);
    expect(findDenylistMatch('chase.com.evil.com', PATTERNS)).toBe(null);
  });

  test('normalization cannot be abused to over-match', () => {
    // stripping a trailing dot must not turn a foreign host into a match
    expect(findDenylistMatch('notchase.com.', PATTERNS)).toBe(null);
    expect(findDenylistMatch('chase.com.attacker.com', PATTERNS)).toBe(null);
  });
});
