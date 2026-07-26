// issue 251 — the credential half of the lock.
//
// `ctx.activeTab.origin` is not just where the DOM tools point: it IS the web
// actor's session-credential scope, read live on every request by
// withSessionScopedCredentials. So a page that redirects itself onto a
// credentialed origin moves that scope with no tool call in between for the
// async judge to see, and `fetch_url` / `read_web_cache` / `site_client_*` never
// pass through resolveTargetTab at all.
//
// This getter is the answer, and its shape is the point: SYNCHRONOUS (so it can
// live inside the scope getter), SIDE-EFFECT-FREE (it is called per request, and
// must not spend excursion budget), and NARROWING ONLY (it can withhold a scope,
// never grant one).

import { describe, test, expect } from 'bun:test';
import { makeCredentialScope } from '../../../extension/peerd-runtime/actor/origin-lock.js';
import { mayHoldCredentials } from '../../../extension/peerd-runtime/actor/landing-rule.js';

const scopeFor = (state: any, origin: string | undefined, deps: any = {}) =>
  makeCredentialScope({ getState: () => state, getOrigin: () => origin, ...deps })();

describe('no state means no lock — pre-#251 behaviour, byte for byte', () => {
  test('the scope passes through untouched', () => {
    // The orchestrator, the engine kinds and the API actor all reach here. The
    // "which contexts are locked" decision is made once in the SW; refusing here
    // would re-litigate it per request and break everything unlocked.
    expect(scopeFor(null, 'https://anything.test')).toBe('https://anything.test');
  });
});

describe('roaming holds a session only where there is no identity to spend', () => {
  test('an ordinary site keeps its scope — same-site fetches work as before', () => {
    expect(scopeFor({ mode: 'roaming' }, 'https://blog.test')).toBe('https://blog.test');
  });

  test('a credentialed site loses it, instantly and synchronously', () => {
    // This is the window the async judge cannot cover: the tab moved by redirect,
    // and fetch_url could spend the new scope before any DOM tool re-entered the
    // chokepoint. Withholding needs no tool call to happen first.
    const deps = { hasVaultSecret: (o: string) => o === 'https://bank.test' };
    expect(scopeFor({ mode: 'roaming' }, 'https://bank.test', deps)).toBeUndefined();
  });
});

describe('bound holds a session only on the origin it owns', () => {
  const owned = { mode: 'bound', ownedOrigin: 'https://app.test' };

  test('home keeps it', () => {
    expect(scopeFor(owned, 'https://app.test')).toBe('https://app.test');
  });

  test('anywhere else loses it', () => {
    expect(scopeFor(owned, 'https://elsewhere.test')).toBeUndefined();
  });

  test('before the first landing there is nothing to be scoped to', () => {
    expect(scopeFor({ mode: 'bound', ownedOrigin: null }, 'https://app.test')).toBeUndefined();
  });

  test('an in-flight excursion does NOT re-open the scope', () => {
    // Signing in is a DOM flow — typing into a form — and the browser attaches
    // the IdP's own cookies regardless. Letting peerd's fetch ALSO ride the
    // user's session at an origin the actor does not own would hand the corridor
    // a capability the corridor was never for.
    const excursion = { returnTo: 'https://app.test', openedAt: 'https://idp.test', lastLanding: 'https://idp.test', budget: 3, deadline: 9e9 };
    expect(scopeFor({ ...owned, excursion }, 'https://idp.test')).toBeUndefined();
    // …not even back home while the corridor is still open.
    expect(scopeFor({ ...owned, excursion }, 'https://app.test')).toBeUndefined();
  });
});

describe('fail closed on anything unrecognizable', () => {
  test('an unknown mode withholds', () => {
    // Same reasoning as decideLanding: a record predating the field, a JSON
    // round-trip, or a typo must not fall through to a permissive default and
    // silently disable this.
    expect(scopeFor({ mode: 'wandering' }, 'https://app.test')).toBeUndefined();
    expect(scopeFor({}, 'https://app.test')).toBeUndefined();
  });

  test('an origin that cannot be named withholds', () => {
    for (const origin of ['http://192.168.1.9', 'https://evil.test.', 'about:blank', 'not-a-url']) {
      expect(scopeFor({ mode: 'roaming' }, origin)).toBeUndefined();
    }
  });

  test('no origin at all is simply no scope', () => {
    expect(scopeFor({ mode: 'roaming' }, undefined)).toBeUndefined();
    expect(scopeFor({ mode: 'roaming' }, '')).toBeUndefined();
  });
});

describe('the getter is free of consequences', () => {
  test('calling it repeatedly never mutates the state it reads', () => {
    // It shares a policy with judgeLanding but not a shape: that one is async
    // and SPENDS excursion budget. A credential-scope getter is called several
    // times per request and must not.
    const state: any = {
      mode: 'bound', ownedOrigin: 'https://app.test', excursionsUsed: 1,
      excursion: { returnTo: 'https://app.test', openedAt: 'https://idp.test', lastLanding: 'https://idp.test', budget: 3, deadline: 9e9 },
    };
    const before = JSON.stringify(state);
    const getScope = makeCredentialScope({ getState: () => state, getOrigin: () => 'https://idp.test' });
    for (let i = 0; i < 5; i += 1) getScope();
    expect(JSON.stringify(state)).toBe(before);
  });

  test('the state is read LIVE, not captured at build time', () => {
    // The SW builds this getter once per tool context, but navigate re-pins the
    // tab mid-turn. A getter that snapshotted the state would go stale exactly
    // when the tab moved — the case it exists for.
    let state: any = { mode: 'roaming' };
    const getScope = makeCredentialScope({
      getState: () => state,
      getOrigin: () => 'https://bank.test',
      hasVaultSecret: (o: string) => o === 'https://bank.test',
    });
    expect(getScope()).toBeUndefined();
    state = null;                              // unlocked
    expect(getScope()).toBe('https://bank.test');
  });
});

describe('the pure predicate underneath', () => {
  test('agrees with the getter, and is callable without the classifier', () => {
    expect(mayHoldCredentials({
      mode: 'roaming', origin: 'https://blog.test', originIsSensitive: false,
    })).toBe(true);
    expect(mayHoldCredentials({
      mode: 'roaming', origin: 'https://blog.test', originIsSensitive: true,
    })).toBe(false);
    expect(mayHoldCredentials({
      mode: 'bound', ownedOrigin: 'https://app.test', origin: 'https://app.test', originIsSensitive: true,
    })).toBe(true);
  });

  test('port and case differences are compared canonically, not textually', () => {
    // sameOrigin normalizes both sides; a textual compare would let
    // `https://APP.test` read as foreign and silently drop a legitimate scope.
    expect(mayHoldCredentials({
      mode: 'bound', ownedOrigin: 'https://app.test', origin: 'HTTPS://APP.TEST:443', originIsSensitive: true,
    })).toBe(true);
    expect(mayHoldCredentials({
      mode: 'bound', ownedOrigin: 'https://app.test', origin: 'https://app.test:8443', originIsSensitive: true,
    })).toBe(false);
  });
});
