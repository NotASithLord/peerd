// issue 251 — the sensitivity classifier: is this an origin the user has an
// identity on?
//
// The security property under test is NOT "does it catch every credentialed
// site" — it cannot, and it fails open by design. It is:
//   - the two SEEDS (curated registry, user-authored vault secret) always win,
//     and win in that order, so the handoff notice cites the strongest signal
//   - the LEARNED set works, and carries provenance when it has it
//   - a non-origin (blank tab, extension page, IP, localhost) is never
//     sensitive — there is nothing to be signed in to
//   - it never throws on junk, because it runs on every landing

import { describe, test, expect } from 'bun:test';
import {
  classifyOriginSensitivity, learnedOriginCovers, sameOrigin, sensitivityHost,
  LEARNED_REASONS,
} from '../../../extension/peerd-runtime/actor/origin-sensitivity.js';
import { isKnownIdpHost } from '../../../extension/peerd-runtime/actor/idp-registry.js';

const ugcOnly = { isUgcZone: (o: string) => o === 'https://github.com' };

describe('sensitivity — the seeds', () => {
  test.each([
    ['https://accounts.google.com/o/oauth2'],
    ['https://tenant.okta.com/app/login'],
  ])('a dedicated identity provider is transit-only sensitive: %s', (url) => {
    expect(classifyOriginSensitivity(url, { isKnownIdp: isKnownIdpHost })).toMatchObject({
      sensitive: true,
      reason: 'identity-provider',
    });
  });

  test.each([
    ['http://accounts.google.com/o/oauth2'],
    ['https://accounts.google.com:8443/o/oauth2'],
  ])('cookie-sharing spellings remain sensitive outside the strict corridor: %s', (url) => {
    expect(classifyOriginSensitivity(url, { isKnownIdp: isKnownIdpHost }).sensitive).toBe(true);
  });

  test('a lookalike host stays ordinary', () => {
    expect(classifyOriginSensitivity('https://accounts.google.com.evil.test/login', {
      isKnownIdp: isKnownIdpHost,
    }).sensitive).toBe(false);
  });

  test('a UGC-registry origin is sensitive, attributed to the registry', () => {
    const v = classifyOriginSensitivity('https://github.com', ugcOnly);
    expect(v.sensitive).toBe(true);
    expect(v.reason).toBe('ugc-zone');
    expect(v.origin).toBe('https://github.com');
  });

  test('the UGC signal is INJECTED, not imported — absent means simply not that signal', () => {
    // why this matters: the registry lands on its own schedule (#242 / PR #250).
    // The classifier must be usable, and testable, without it.
    expect(classifyOriginSensitivity('https://github.com').sensitive).toBe(false);
  });

  test('an origin the user stored a credential for is sensitive', () => {
    const v = classifyOriginSensitivity('https://api.stripe.com', {
      hasVaultSecret: (o) => o === 'https://api.stripe.com',
    });
    expect(v.reason).toBe('vault-secret');
  });

  test('classification is on the ORIGIN, not the path', () => {
    // #242 gates one write and is path-scoped; being BOUND is about the whole
    // site's session, so a repo root is as sensitive as an issue page.
    expect(classifyOriginSensitivity('https://github.com/acme/widget', ugcOnly).sensitive).toBe(true);
  });

  test('a seed outranks the learned set, so the notice cites the stronger signal', () => {
    const v = classifyOriginSensitivity('https://github.com', {
      ...ugcOnly,
      learned: new Map([['https://github.com', 'password-field' as const]]),
    });
    expect(v.reason).toBe('ugc-zone');
  });
});

describe('sensitivity — the learned set', () => {
  test('a learned origin is sensitive and keeps its provenance', () => {
    const v = classifyOriginSensitivity('https://bank.test', {
      learned: new Map([['https://bank.test', 'confirmed-write' as const]]),
    });
    expect(v.sensitive).toBe(true);
    expect(v.reason).toBe('confirmed-write');
  });

  test('a bare Set works, reporting the weaker signal rather than claiming one', () => {
    const v = classifyOriginSensitivity('https://bank.test', {
      learned: new Set(['https://bank.test']),
    });
    expect(v.sensitive).toBe(true);
    expect(LEARNED_REASONS).toContain(v.reason as any);
  });

  test('legacy normalized-origin keys remain readable during migration', () => {
    // Old durable records used origins. The classifier accepts that shape while
    // hydration compacts it to a host key.
    const v = classifyOriginSensitivity('HTTPS://Bank.test:443/login', {
      learned: new Set(['https://bank.test']),
    });
    expect(v.sensitive).toBe(true);
  });

  test('a learned host covers every scheme and port on that host', () => {
    const learned = new Map([['login.bank.test', 'password-field' as const]]);
    for (const landing of [
      'https://login.bank.test',
      'https://login.bank.test:8443/account',
      'http://login.bank.test:8080/account',
    ]) {
      expect(classifyOriginSensitivity(landing, { learned }).sensitive).toBe(true);
    }
  });

  test('a learned parent covers descendant hosts', () => {
    const learned = new Map([['bank.test', 'confirmed-write' as const]]);
    const v = classifyOriginSensitivity('https://private.accounts.bank.test/inbox', { learned });
    expect(v.sensitive).toBe(true);
    expect(v.reason).toBe('confirmed-write');
    expect(v.origin).toBe('https://private.accounts.bank.test');
  });

  test('a learned child does not poison its parent or a sibling', () => {
    const learned = new Map([['attacker.shared.test', 'password-field' as const]]);
    expect(classifyOriginSensitivity('https://shared.test', { learned }).sensitive).toBe(false);
    expect(classifyOriginSensitivity('https://victim.shared.test', { learned }).sensitive).toBe(false);
  });

  test('hostname boundaries prevent suffix lookalikes from matching', () => {
    const learned = new Map([['bank.test', 'password-field' as const]]);
    expect(classifyOriginSensitivity('https://secure.bank.test', { learned }).sensitive).toBe(true);
    expect(classifyOriginSensitivity('https://bank.test.evil.test', { learned }).sensitive).toBe(false);
    expect(classifyOriginSensitivity('https://notbank.test', { learned }).sensitive).toBe(false);
  });

  test('the closest learned host supplies the reason', () => {
    const learned = new Map([
      ['example.test', 'password-field' as const],
      ['accounts.example.test', 'confirmed-write' as const],
    ]);
    const v = classifyOriginSensitivity('https://private.accounts.example.test', { learned });
    expect(v.reason).toBe('confirmed-write');
  });
});

describe('learned cookie-host scope', () => {
  test('normalization removes scheme, port, path, and host casing', () => {
    expect(sensitivityHost('HTTP://Login.Bank.test:8080/path')).toBe('login.bank.test');
  });

  test('coverage is one-way from parent to descendant', () => {
    expect(learnedOriginCovers('https://example.test:8443', 'http://a.example.test:8080')).toBe(true);
    expect(learnedOriginCovers('https://a.example.test', 'https://example.test')).toBe(false);
    expect(learnedOriginCovers('https://a.example.test', 'https://b.example.test')).toBe(false);
  });
});

describe('sensitivity — nothing to be signed in to', () => {
  test.each([
    ['about:blank'], ['chrome-extension://abc/page.html'], ['http://localhost:3000'],
    ['http://127.0.0.1'], ['javascript:alert(1)'], ['data:text/html,hi'], [''],
  ])('%s is never sensitive', (input) => {
    expect(classifyOriginSensitivity(input, ugcOnly).sensitive).toBe(false);
  });

  test.each([[null], [undefined], [42], [{}], [[]]])('junk input %p does not throw', (input) => {
    expect(() => classifyOriginSensitivity(input as any, ugcOnly)).not.toThrow();
    expect(classifyOriginSensitivity(input as any, ugcOnly).sensitive).toBe(false);
  });

  test('a host that merely CONTAINS a sensitive one is not it', () => {
    // The normalize step is the same one the egress boundary uses, so
    // github.com.evil.test cannot borrow github's classification.
    expect(classifyOriginSensitivity('https://github.com.evil.test', ugcOnly).sensitive).toBe(false);
  });
});

describe('sameOrigin', () => {
  test('normalizes both sides — case, default port, path', () => {
    expect(sameOrigin('HTTPS://GitHub.com:443/a/b', 'https://github.com')).toBe(true);
  });

  test('different origins are different', () => {
    expect(sameOrigin('https://github.com', 'https://evil.test')).toBe(false);
    expect(sameOrigin('https://github.com', 'http://github.com')).toBe(false);   // scheme counts
    expect(sameOrigin('https://github.com:8443', 'https://github.com:9443')).toBe(false); // port counts
  });

  test('an unusable origin is never "the same as" anything, including another unusable one', () => {
    // why: two nulls must not compare equal, or a blank tab would read as
    // "still on the owned site" and the landing rule would wave it through.
    expect(sameOrigin('about:blank', 'about:blank')).toBe(false);
    expect(sameOrigin('about:blank', 'https://github.com')).toBe(false);
  });
});
