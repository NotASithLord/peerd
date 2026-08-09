// The PURE login-affordance classifier. Values in, a verdict out — no DOM, no
// chrome, no clock. These probes ARE the decision table: passkey (two signals),
// SSO supported vs. corridor-refused, password (no fill), the non-login negatives,
// and the adversarial cases (a "Delete account" button must never read as login;
// a "Sign in with GitHub" lookalike must be refused). isKnownIdp is INJECTED as a
// stub so the classifier stays IO-free and the corridor decision is explicit here.

import { describe, test, expect } from 'bun:test';
import {
  classifyLoginAffordance, loginTargetReader, SUPPORTED_SSO_PROVIDERS,
} from '../../../extension/peerd-runtime/tools/login-affordance.js';
import { isKnownIdp as realIsKnownIdp } from '../../../extension/peerd-runtime/actor/idp-registry.js';

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

  test('VERIFIED only when the destination is a proven IdP; a name alone is supported-but-unverified', () => {
    // href to a known IdP → verified (auto-clickable)
    const byHref = classifyLoginAffordance(
      { tag: 'button', name: 'Sign in with Google', href: 'https://accounts.google.com/o/oauth2/v2/auth' },
      deps,
    );
    expect(byHref).toMatchObject({
      method: 'sso', supported: true, verified: true,
      idpOrigin: 'https://accounts.google.com',
    });
    // form action to a known IdP → verified too
    const byForm = classifyLoginAffordance(
      { tag: 'input', type: 'submit', name: 'Continue', formAction: 'https://acme.okta.com/sso' },
      deps,
    );
    expect(byForm).toMatchObject({
      method: 'sso', supported: true, verified: true,
      idpOrigin: 'https://acme.okta.com',
    });
    // NAME only, no destination to check → supported but NOT verified (assisted-manual)
    const byName = classifyLoginAffordance({ tag: 'button', name: 'Sign in with Google' }, deps);
    expect(byName).toMatchObject({ method: 'sso', supported: true, verified: false });
    // a recognized name pointing at a NON-IdP destination stays unverified
    const wrongDest = classifyLoginAffordance(
      { tag: 'button', name: 'Continue with Google', href: 'https://evil.example.com/steal' },
      deps,
    );
    expect(wrongDest).toMatchObject({ method: 'sso', supported: true, verified: false });
  });

  test('passkey is verified:true; password/unknown are verified:false (shape consistency)', () => {
    expect(classifyLoginAffordance({ tag: 'input', autocomplete: 'webauthn' }, deps).verified).toBe(true);
    expect(classifyLoginAffordance({ tag: 'input', type: 'password' }, deps).verified).toBe(false);
    expect(classifyLoginAffordance({ tag: 'button', name: 'Submit' }, deps).verified).toBe(false);
  });

  test('provider is a CANONICAL single-word title-cased label, never the raw greedy phrase', () => {
    const v = classifyLoginAffordance(
      { tag: 'button', name: 'Continue with google to approve the pending transfer' },
      deps,
    );
    expect(v.method).toBe('sso');
    expect(v.provider).toBe('Google');   // NOT 'google to approve the pending transfer'
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

// The injected page READER — the ground-truth extractor. It reads ATTRIBUTES and
// structure only and must NEVER fold a field VALUE into descriptor.name, or a bare
// <input type=password> would leak the typed secret. We drive the REAL body against a
// tiny fake DOM (same precedent as clickInjected's Bun coverage).
describe('loginTargetReader — never reads a field value as a name', () => {
  const withFakeDocument = (el: any, run: () => void) => {
    const g = globalThis as any;
    const prevDoc = g.document;
    g.document = {
      querySelectorAll: (_sel: string) => [el],
      querySelector: () => null,
      getElementById: () => null,
    };
    try { run(); } finally { g.document = prevDoc; }
  };

  test('input[type=password] with a value reads name="" (the value is NOT read)', () => {
    const attrs: Record<string, string> = { type: 'password', value: 'hunter2' };
    const el: any = {
      tagName: 'INPUT',
      innerText: '', textContent: '',
      getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
      closest: () => null,
      formAction: undefined,
    };
    withFakeDocument(el, () => {
      const r: any = loginTargetReader('input[type=password]', 0, null);
      expect(r.ok).toBe(true);
      expect(r.descriptor.name).toBe('');          // NOT 'hunter2'
      expect(r.descriptor.name).not.toContain('hunter2');
    });
  });

  test('a submit input DOES read its value — there the value is the CONTROL LABEL', () => {
    const attrs: Record<string, string> = { type: 'submit', value: 'Sign in with Google' };
    const el: any = {
      tagName: 'INPUT',
      innerText: '', textContent: '',
      getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
      closest: () => null,
      formAction: 'https://accounts.google.com/signin',
    };
    withFakeDocument(el, () => {
      const r: any = loginTargetReader('input[type=submit]', 0, null);
      expect(r.ok).toBe(true);
      expect(r.descriptor.name).toBe('Sign in with Google');
      expect(r.descriptor.formAction).toBe('https://accounts.google.com/signin');
    });
  });

  test('a type=button inside an IdP-action form does NOT capture formAction → NOT verified (a non-submit click is not the form destination)', () => {
    // <form action="accounts.google.com"><button type=button onclick=evil>Sign in with Google</button></form>
    // The onclick does NOT submit the form, so the form action is NOT where the click
    // leads — reading it would be a false "verified" signal auto-clicking the evil handler.
    const attrs: Record<string, string> = { type: 'button' };
    const form: any = { getAttribute: (n: string) => (n === 'action' ? 'https://accounts.google.com/signin' : null), action: 'https://accounts.google.com/signin' };
    const el: any = {
      tagName: 'BUTTON',
      innerText: 'Sign in with Google', textContent: 'Sign in with Google',
      getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
      closest: (sel: string) => (sel === 'form' ? form : null),
      formAction: 'https://accounts.google.com/signin',   // reflected by the DOM but MUST be ignored
    };
    withFakeDocument(el, () => {
      const r: any = loginTargetReader('button', 0, null);
      expect(r.ok).toBe(true);
      expect(r.descriptor.formAction).toBe('');   // NOT captured — type=button doesn't submit
      // and so the classifier must NOT mark it a verified (auto-clickable) destination
      const v = classifyLoginAffordance(r.descriptor, { isKnownIdp: () => true });
      expect(v.method).toBe('sso');
      expect(v.verified).toBe(false);
    });
  });
});

// Corridor subset: with Fix 5 every SUPPORTED provider NAME must correspond to a host
// the REAL isKnownIdp accepts — a "recognized name" that lands off the corridor would
// be a name-only auto-click risk (removed 'amazon'/'ping'; kept 'aws'/'pingidentity').
describe('SUPPORTED_SSO_PROVIDERS ⊆ the isKnownIdp corridor', () => {
  // one representative host per supported provider word
  const REP_HOST: Record<string, string> = {
    google: 'accounts.google.com',
    apple: 'appleid.apple.com',
    microsoft: 'login.microsoftonline.com',
    azure: 'login.microsoftonline.com',
    okta: 'acme.okta.com',
    auth0: 'acme.auth0.com',
    onelogin: 'acme.onelogin.com',
    pingidentity: 'acme.pingidentity.com',
    duo: 'acme.duosecurity.com',
    workos: 'acme.workos.com',
    jumpcloud: 'acme.jumpcloud.com',
    atlassian: 'id.atlassian.com',
    spotify: 'accounts.spotify.com',
    yahoo: 'login.yahoo.com',
    aws: 'signin.aws.amazon.com',
  };

  test('every supported provider name maps to a host isKnownIdp accepts', () => {
    for (const name of SUPPORTED_SSO_PROVIDERS) {
      const host = REP_HOST[name];
      expect(host, `no representative host for supported provider "${name}"`).toBeTruthy();
      expect(realIsKnownIdp(`https://${host}`), `isKnownIdp rejected ${host} for "${name}"`).toBe(true);
    }
  });

  test('the dropped ambiguous names are gone', () => {
    expect(SUPPORTED_SSO_PROVIDERS.has('amazon')).toBe(false);
    expect(SUPPORTED_SSO_PROVIDERS.has('ping')).toBe(false);
  });
});
