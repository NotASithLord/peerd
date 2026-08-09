// issue 251 — the one narrow exemption's input. A false positive here REMOVES a
// protection (it opens the corridor a bound actor is otherwise never allowed),
// so most of these tests are about what must NOT match.

import { describe, test, expect } from 'bun:test';
import { isKnownIdp, isKnownIdpHost, knownIdpSeeds } from '../../../extension/peerd-runtime/actor/idp-registry.js';

describe('what counts', () => {
  test('dedicated auth hosts', () => {
    for (const url of [
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      'https://login.microsoftonline.com/common/oauth2/authorize',
      'https://appleid.apple.com/auth/authorize',
      'https://signin.aws.amazon.com/saml',
    ]) expect(isKnownIdp(url)).toBe(true);
  });

  test('identity vendors, on their customers\' subdomains', () => {
    expect(isKnownIdp('https://acme.okta.com/app/x')).toBe(true);
    expect(isKnownIdp('https://login.acme.auth0.com/authorize')).toBe(true);
    expect(isKnownIdp('https://onelogin.com/login')).toBe(true);
  });
});

describe('what deliberately does not count', () => {
  test('full products that merely also speak OAuth', () => {
    // Admitting these would hand a bound actor a budgeted corridor onto the
    // WHOLE site — issues, settings, mail — under the opener exemption, on a
    // site the user is logged into. That is worse than what the excursion exists
    // to prevent. The cost is that "sign in with GitHub" ends the actor.
    for (const url of [
      'https://github.com/login/oauth/authorize',
      'https://gitlab.com/oauth/authorize',
      'https://www.facebook.com/dialog/oauth',
      'https://twitter.com/i/oauth2/authorize',
    ]) expect(isKnownIdp(url)).toBe(false);
  });

  test('http is never an IdP', () => {
    // A sign-in over cleartext is a downgrade attack or an already-lost
    // credential; either way not a reason to open a corridor.
    expect(isKnownIdp('http://accounts.google.com/o/oauth2')).toBe(false);
    expect(isKnownIdp('http://acme.okta.com/')).toBe(false);
  });

  test('lookalike hosts that merely CONTAIN a vendor domain', () => {
    // The suffix rule is `host === s || host.endsWith('.' + s)` precisely so
    // these fail. `okta.com.evil.test` is the classic one; `notokta.com` is the
    // one a naive `includes` would wave through.
    for (const url of [
      'https://okta.com.evil.test/login',
      'https://notokta.com/login',
      'https://evil-auth0.com/authorize',
      'https://auth0.com.attacker.test/',
    ]) expect(isKnownIdp(url)).toBe(false);
  });

  test('an exact-set host on a non-default port is not the login box', () => {
    expect(isKnownIdp('https://accounts.google.com:8443/o/oauth2')).toBe(false);
    expect(isKnownIdp('https://acme.okta.com:8443/app')).toBe(false);
  });

  test('the default port spelled out still matches', () => {
    expect(isKnownIdp('https://accounts.google.com:443/o/oauth2')).toBe(true);
  });

  test('case and trailing junk cannot spell around the set', () => {
    expect(isKnownIdp('HTTPS://ACCOUNTS.GOOGLE.COM/o/oauth2')).toBe(true);
    // A trailing-dot FQDN resolves to the same host but is a DIFFERENT string;
    // it must not sneak in, and it must not be treated as an IdP either.
    expect(isKnownIdp('https://accounts.google.com./o/oauth2')).toBe(false);
  });

  test('non-URLs, non-http schemes and junk', () => {
    for (const input of [null, undefined, '', 'accounts.google.com', 'data:text/html,x', 'javascript:1']) {
      expect(isKnownIdp(input as any)).toBe(false);
    }
  });
});

describe('the seed list itself', () => {
  test('is exposed, frozen, and https-only by construction', () => {
    const seeds = knownIdpSeeds();
    expect(Object.isFrozen(seeds.origins)).toBe(true);
    expect(seeds.origins.every((o) => o.startsWith('https://'))).toBe(true);
    // A suffix entry must be a bare registrable domain — a scheme or a path in
    // here would silently never match anything.
    expect(seeds.suffixes.every((s) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s))).toBe(true);
  });
});

describe('host-level IdP sensitivity', () => {
  test.each([
    ['https://accounts.google.com:8443/o/oauth2'],
    ['http://accounts.google.com/login'],
    ['http://tenant.okta.com:8080/app'],
    ['https://accounts.google.com./login'],
  ])('matches the authentication host regardless of cookie-sharing scheme or port: %s', (url) => {
    expect(isKnownIdpHost(url)).toBe(true);
  });

  test.each([
    ['https://accounts.google.com.evil.test/login'],
    ['https://evil-okta.com/login'],
    ['data:text/html,accounts.google.com'],
  ])('keeps host matching anchored: %s', (url) => {
    expect(isKnownIdpHost(url)).toBe(false);
  });
});
