// Property fuzz for the denylist host matcher — the security-critical gate that
// keeps peerd off "sites it will never touch". The class of bug here is a
// BYPASS: a host that should match a pattern slipping through because of a
// host-form variation a browser treats as equivalent (case, a port, a trailing
// FQDN dot). A real bypass was already fixed for port + trailing dot; this pins
// the whole class with thousands of generated cases.
//
// Inputs are kept to the shapes the matcher actually receives — a URL.host
// ("hostname:port", port last) or a URL.hostname ("hostname", trailing dot
// possible). The PRNG is seeded so any failure reproduces from the fixed seed.

import { describe, test, expect } from 'bun:test';
import { findDenylistMatch } from '../../extension/peerd-egress/denylist/denylist.js';

const rng = (seed: number) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const randLabel = (r: () => number) => {
  const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const n = 1 + Math.floor(r() * 8);
  let s = '';
  for (let i = 0; i < n; i++) s += alpha[Math.floor(r() * alpha.length)];
  return s;
};
const randHost = (r: () => number) =>
  Array.from({ length: 2 + Math.floor(r() * 3) }, () => randLabel(r)).join('.');

// Equivalence-preserving mutations a browser/URL would treat as the SAME host.
// Case can always apply; a port (URL.host) and a trailing dot (URL.hostname) do
// NOT co-occur in a single URL field, so pick at most one.
const mutate = (r: () => number, host: string) => {
  let h = host;
  if (r() < 0.6) h = [...h].map((c) => (r() < 0.5 ? c.toUpperCase() : c)).join('');
  const form = r();
  if (form < 0.35) h = `${h}:${1 + Math.floor(r() * 65535)}`;   // URL.host (port last)
  else if (form < 0.7) h = h + '.'.repeat(1 + Math.floor(r() * 3)); // URL.hostname (trailing dot)
  return h;
};

describe('denylist matcher — property fuzz', () => {
  test('never throws on arbitrary host / pattern input', () => {
    const r = rng(0x1234);
    for (let i = 0; i < 2000; i++) {
      const host = r() < 0.5
        ? randHost(r)
        : Array.from({ length: Math.floor(r() * 24) }, () => Math.floor(r() * 128)).map((c) => String.fromCharCode(c)).join('');
      const patterns = Array.from({ length: Math.floor(r() * 4) },
        () => (r() < 0.5 ? randHost(r) : `*.${randHost(r)}`));
      expect(() => findDenylistMatch(host, patterns)).not.toThrow();
    }
  });

  test('a denylisted host stays matched under case / port / trailing-dot variation (no bypass)', () => {
    const r = rng(0xBEEF);
    for (let i = 0; i < 4000; i++) {
      const base = randHost(r);
      const wildcard = r() < 0.5;
      const pattern = wildcard ? `*.${base}` : base;
      const host = wildcard ? `${randLabel(r)}.${base}` : base;
      expect(findDenylistMatch(host, [pattern])).toBe(pattern); // the plain form matches
      const m = mutate(r, host);
      const got = findDenylistMatch(m, [pattern]);
      if (got !== pattern) throw new Error(`BYPASS: host="${m}" pattern="${pattern}" → ${String(got)}`);
    }
  });

  test('wildcard *.base matches a subdomain but NOT the apex or a glued host', () => {
    const r = rng(0x2468);
    for (let i = 0; i < 2000; i++) {
      const base = randHost(r);
      expect(findDenylistMatch(`${randLabel(r)}.${base}`, [`*.${base}`])).toBe(`*.${base}`); // subdomain → match
      expect(findDenylistMatch(base, [`*.${base}`])).toBe(null);        // apex → NOT a subdomain
      expect(findDenylistMatch(`x${base}`, [`*.${base}`])).toBe(null);  // glued (no dot) → no match
    }
  });

  test('known canonicalization edge cases (regression of the fixed bypasses)', () => {
    const P = ['chase.com'];
    expect(findDenylistMatch('chase.com', P)).toBe('chase.com');
    expect(findDenylistMatch('CHASE.COM', P)).toBe('chase.com');      // case
    expect(findDenylistMatch('Chase.Com.', P)).toBe('chase.com');     // case + trailing dot
    expect(findDenylistMatch('chase.com:8443', P)).toBe('chase.com'); // port
    expect(findDenylistMatch('chase.com..', P)).toBe('chase.com');    // multiple trailing dots
    // and the boundary non-matches the gate relies on
    expect(findDenylistMatch('evilchase.com', P)).toBe(null);
    expect(findDenylistMatch('chase.com.attacker.com', P)).toBe(null);
  });
});
