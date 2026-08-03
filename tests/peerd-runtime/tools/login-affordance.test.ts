// The PURE login-affordance classifier. Values in, a verdict out — no DOM, no
// chrome, no clock. These probes ARE the decision table: passkey (two signals),
// SSO supported vs. corridor-refused, password (no fill), the non-login negatives,
// and the adversarial cases (a "Delete account" button must never read as login;
// a "Sign in with GitHub" lookalike must be refused). isKnownIdp is INJECTED as a
// stub so the classifier stays IO-free and the corridor decision is explicit here.

import { describe, test, expect } from 'bun:test';
import { classifyLoginAffordance } from '../../../extension/peerd-runtime/tools/login-affordance.js';

// A stub corridor: the dedicated identity providers only. Mirrors idp-registry.js's
// posture (https, dedicated auth hosts) without importing it — the injection point
// is exactly what keeps the core pure.
const isKnownIdp = (input: unknown): boolean => {
  let u: URL;
  try { u = new URL(String(input ?? '')); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return [
    'accounts.google.com', 'login.microsoftonline.com', 'appleid.apple.com',
  ].includes(u.hostname.toLowerCase()) || u.hostname.endsWith('.okta.com');
};
const deps = { isKnownIdp };

describe('classifyLoginAffordance — passkey', () => {
  test('by autocomplete token (webauthn) → supported passkey', () => {
    const v = classifyLoginAffordance({ tag: 'input', autocomplete: 'username webauthn' }, deps);
    expect(v).toMatchObject({ method: 'passkey', supported: true });
  });

  test('by accessible name (passkey / face / fingerprint) → supported passkey', () => {
    for (const name of ['Sign in with a passkey', 'Use your fingerprint', 'Use a security key', 'Use your face']) {
      const v = classifyLoginAffordance({ tag: 'button', name }, deps);
      expect(v).toMatchObject({ method: 'passkey', supported: true });
    }
  });

  test('passkey wins over the broader SSO regex ("sign in with a passkey" is NOT provider="passkey")', () => {
    const v = classifyLoginAffordance({ tag: 'button', name: 'Sign in with a passkey' }, deps);
    expect(v.method).toBe('passkey');
  });
});

describe('classifyLoginAffordance — SSO', () => {
  test('"Sign in with Google" → supported SSO, provider extracted', () => {
    const v = classifyLoginAffordance({ tag: 'button', name: 'Sign in with Google' }, deps);
    expect(v.method).toBe('sso');
    expect(v.supported).toBe(true);
    expect((v.provider ?? '').toLowerCase()).toContain('google');
  });

  test('an IdP href alone (no "sign in with" text) is recognized via isKnownIdp', () => {
    const v = classifyLoginAffordance(
      { tag: 'a', name: 'Continue', href: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' },
      deps,
    );
    expect(v).toMatchObject({ method: 'sso', supported: true });
  });

  test('"Continue with GitHub" → SSO but REFUSED (outside the corridor)', () => {
    const v = classifyLoginAffordance({ tag: 'button', name: 'Continue with GitHub' }, deps);
    expect(v.method).toBe('sso');
    expect(v.supported).toBe(false);
    expect(v.reason).toMatch(/corridor|origin lock/i);
  });

  test('GitLab and Facebook are refused too (full products that also speak OAuth)', () => {
    for (const name of ['Sign in with GitLab', 'Continue with Facebook']) {
      const v = classifyLoginAffordance({ tag: 'button', name }, deps);
      expect(v).toMatchObject({ method: 'sso', supported: false });
    }
  });

  test('an unknown SSO provider is refused, not silently supported', () => {
    const v = classifyLoginAffordance({ tag: 'button', name: 'Sign in with Wombat' }, deps);
    expect(v).toMatchObject({ method: 'sso', supported: false });
  });
});

describe('classifyLoginAffordance — password (Tier 0 holds no credentials)', () => {
  test('a password input → unsupported password (never filled)', () => {
    const v = classifyLoginAffordance({ tag: 'input', type: 'password' }, deps);
    expect(v).toMatchObject({ method: 'password', supported: false });
  });

  test('a submit button in a form with a password field, no passkey/SSO → password', () => {
    const v = classifyLoginAffordance({ tag: 'button', name: 'Log in', hasPasswordFieldInForm: true }, deps);
    expect(v).toMatchObject({ method: 'password', supported: false });
  });
});

describe('classifyLoginAffordance — negatives and adversarial', () => {
  test('a "Delete account" button must NOT classify as login', () => {
    const v = classifyLoginAffordance({ tag: 'button', name: 'Delete account' }, deps);
    expect(v).toMatchObject({ method: 'unknown', supported: false });
  });

  test('an ordinary "Submit" button is not a login affordance', () => {
    const v = classifyLoginAffordance({ tag: 'button', name: 'Submit' }, deps);
    expect(v.method).toBe('unknown');
  });

  test('untrusted name text is matched, never evaluated (a scripty name is just unknown)', () => {
    const v = classifyLoginAffordance({ tag: 'button', name: '"><script>alert(1)</script>' }, deps);
    expect(v.supported).toBe(false);
  });

  test('deterministic: identical input → identical verdict', () => {
    const input = { tag: 'button', name: 'Sign in with Google' };
    expect(classifyLoginAffordance(input, deps)).toEqual(classifyLoginAffordance(input, deps));
  });

  test('an empty / missing descriptor fails closed to unknown', () => {
    expect(classifyLoginAffordance({} as any, deps).supported).toBe(false);
    expect(classifyLoginAffordance(undefined as any, deps).supported).toBe(false);
  });
});
