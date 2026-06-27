// The web actor's credential rule lives AT THE EGRESS BOUNDARY: the user's session
// rides a request ONLY when it is same-origin to the actor's owned tab. Everything
// cross-origin — and the whole 0-tab state — is sessionless. This is what bounds the
// relaxation: an injected web actor can never point a credentialed fetch at a
// DIFFERENT site the user is logged into and read it out. A tool can't override it
// (the wrapper overwrites whatever credentials the caller passed).

import { describe, test, expect } from 'bun:test';
import { sessionScopedCredentials, withSessionScopedCredentials } from '../../extension/peerd-egress/fetch/web-fetch.js';

describe('sessionScopedCredentials — same-origin gets the session, else sessionless', () => {
  const ORIGIN = 'https://app.example.com';
  test('same-origin → include', () => {
    expect(sessionScopedCredentials('https://app.example.com/api/me', ORIGIN)).toBe('include');
    expect(sessionScopedCredentials('https://app.example.com/', ORIGIN)).toBe('include');
  });
  test('cross-origin → omit (different host, scheme, or port)', () => {
    expect(sessionScopedCredentials('https://evil.example.com/steal', ORIGIN)).toBe('omit');
    expect(sessionScopedCredentials('https://app.example.com:8443/x', ORIGIN)).toBe('omit'); // port differs
    expect(sessionScopedCredentials('http://app.example.com/x', ORIGIN)).toBe('omit');       // scheme differs
  });
  test('no owned tab (0-tab state) → omit', () => {
    expect(sessionScopedCredentials('https://app.example.com/api', null)).toBe('omit');
    expect(sessionScopedCredentials('https://app.example.com/api', undefined)).toBe('omit');
  });
  test('an unparseable url → omit (fail safe)', () => {
    expect(sessionScopedCredentials('not a url', ORIGIN)).toBe('omit');
  });
});

describe('withSessionScopedCredentials — the boundary owns the decision', () => {
  const seenInit = () => {
    const calls: any[] = [];
    const inner = async (_res: any, init: any) => { calls.push(init); return {} as any; };
    return { inner, calls };
  };

  test('attaches include for same-origin, omit for cross-origin, reading the origin LIVE', () => {
    const { inner, calls } = seenInit();
    let origin: string | null = 'https://app.example.com';
    const fetchFn = withSessionScopedCredentials(inner, () => origin);
    return (async () => {
      await fetchFn('https://app.example.com/api/me');
      expect(calls[0].credentials).toBe('include');
      await fetchFn('https://other.example.com/x');
      expect(calls[1].credentials).toBe('omit');
      // a mid-turn tab adoption changes the session origin — read live, per call.
      origin = 'https://other.example.com';
      await fetchFn('https://other.example.com/x');
      expect(calls[2].credentials).toBe('include');
    })();
  });

  test("a caller-supplied credentials is OVERWRITTEN — a tool can't force the session", async () => {
    const { inner, calls } = seenInit();
    const fetchFn = withSessionScopedCredentials(inner, () => 'https://app.example.com');
    await fetchFn('https://evil.example.com/x', { credentials: 'include', method: 'GET' });
    expect(calls[0].credentials).toBe('omit');   // boundary wins
    expect(calls[0].method).toBe('GET');         // other init preserved
  });
});
