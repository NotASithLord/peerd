import { describe, expect, test } from 'bun:test';
import {
  decideNumericTabAuthority,
  numericTabAuthorityRefusal,
  IDENTITY_PROVIDER_TRANSIT_ONLY_CODE,
  NUMERIC_TAB_POLICY_UNAVAILABLE_CODE,
  NUMERIC_TAB_SENSITIVE_CODE,
} from '../../../extension/peerd-runtime/actor/numeric-tab-authority.js';

describe('numeric tab authority', () => {
  test('binds an ordinary browser-observed origin', () => {
    expect(decideNumericTabAuthority('HTTPS://Example.com:443/path?q=secret', {
      policyReady: true,
    })).toEqual({ allowed: true, origin: 'https://example.com' });
  });

  test.each([
    ['ugc-zone', { isUgcZone: (origin: string) => origin === 'https://account.test' }],
    ['vault-secret', { hasVaultSecret: (origin: string) => origin === 'https://account.test' }],
    ['password-field', { learned: new Map([['https://account.test', 'password-field' as const]]) }],
    ['confirmed-write', { learned: new Map([['https://account.test', 'confirmed-write' as const]]) }],
  ])('refuses the %s sensitivity signal', (reason, signals) => {
    const decision = decideNumericTabAuthority('https://account.test/inbox?token=hidden', {
      policyReady: true,
      ...signals,
    });
    expect(decision).toMatchObject({
      allowed: false,
      code: NUMERIC_TAB_SENSITIVE_CODE,
      reason,
      origin: 'https://account.test',
      suggestedHandle: 'site:https://account.test',
      requiresUserIntent: true,
      retryable: false,
    });
  });

  test('an identity provider is refused without suggesting a standalone site actor', () => {
    const decision = decideNumericTabAuthority('https://accounts.google.com/o/oauth2', {
      policyReady: true,
      isKnownIdp: (origin) => origin === 'https://accounts.google.com',
    });
    expect(decision).toMatchObject({
      allowed: false,
      code: IDENTITY_PROVIDER_TRANSIT_ONLY_CODE,
      reason: 'identity-provider',
      suggestedHandle: null,
      requiresUserIntent: false,
    });
    if (decision.allowed) throw new Error('expected a refusal');
    const refusal = numericTabAuthorityRefusal(decision);
    expect(refusal.content).not.toContain('site:https://accounts.google.com');
    expect(refusal.content).toContain("Continue through the relying site already named in the user's request");
    expect(refusal.content).toContain('If none was named, ask which site');
    expect(refusal.structured).toMatchObject({ transitOnly: true, requiresRelyingSite: true });
  });

  test.each([
    ['policy not ready', 'https://example.com', false],
    ['unnameable URL', 'about:blank', true],
    ['malformed URL', 'not a URL', true],
  ])('fails closed when %s', (_label, url, policyReady) => {
    expect(decideNumericTabAuthority(url, { policyReady })).toEqual({
      allowed: false,
      code: NUMERIC_TAB_POLICY_UNAVAILABLE_CODE,
      retryable: false,
      origin: null,
      reason: null,
      suggestedHandle: null,
      requiresUserIntent: false,
    });
  });

  test('projects only the canonical origin and explicit recovery handle', () => {
    const decision = decideNumericTabAuthority('https://account.test/inbox?prompt=ignore-me', {
      policyReady: true,
      learned: new Set(['https://account.test']),
    });
    if (decision.allowed) throw new Error('expected a refusal');
    const refusal = numericTabAuthorityRefusal(decision);
    expect(refusal).toMatchObject({
      ok: false,
      error: NUMERIC_TAB_SENSITIVE_CODE,
      outcomeKind: 'pre-effect-failure',
      structured: {
        performed: false,
        outcomeKnown: true,
        retryable: false,
        origin: 'https://account.test',
        suggestedHandle: 'site:https://account.test',
        requiresUserIntent: true,
      },
    });
    expect(refusal.content).not.toContain('/inbox');
    expect(refusal.content).not.toContain('prompt');
    expect(refusal.content).not.toContain('ignore-me');
  });

  test('an unavailable policy requires a reload instead of an automatic retry', () => {
    const decision = decideNumericTabAuthority('https://account.test/inbox', {
      policyReady: false,
    });
    if (decision.allowed) throw new Error('expected a refusal');
    expect(numericTabAuthorityRefusal(decision)).toMatchObject({
      ok: false,
      error: NUMERIC_TAB_POLICY_UNAVAILABLE_CODE,
      outcomeKind: 'pre-effect-failure',
      structured: {
        performed: false,
        outcomeKnown: true,
        retryable: false,
      },
    });
    expect(numericTabAuthorityRefusal(decision).content).toContain('reload peerd');
    expect(numericTabAuthorityRefusal(decision).content).toContain('Do not retry automatically');
  });
});
