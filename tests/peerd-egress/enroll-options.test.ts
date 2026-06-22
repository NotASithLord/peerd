// WebAuthn enrollment planning — the pure decision half of the passkey
// flow (extension/peerd-egress/vault/enroll-options.js): capability
// probe results in → enrollment choices out, plus the post-create() PRF
// verdict, transport sanitation, and the label table. The imperative
// shell (navigator.credentials, the probes themselves) is exercised by
// the in-browser suite against CDP virtual authenticators.

import { describe, test, expect } from 'bun:test';
import {
  planEnrollment,
  authenticatorSelectionFor,
  evaluateCreatePrf,
  sanitizeTransports,
  allowCredentialDescriptor,
  platformAuthenticatorLabel,
} from '../../extension/peerd-egress/vault/enroll-options.js';
import { createVault } from '../../extension/peerd-egress/vault/vault.js';

// ---------------------------------------------------------------------------
// planEnrollment
// ---------------------------------------------------------------------------

describe('planEnrollment', () => {
  test('no WebAuthn → nothing to offer', () => {
    expect(planEnrollment({
      webAuthnAvailable: false, platformAuthenticator: null, clientCapabilities: null,
    })).toEqual({ paths: [], prfHint: 'unknown' });
  });

  test('platform authenticator present → platform leads, security key always second', () => {
    const plan = planEnrollment({
      webAuthnAvailable: true, platformAuthenticator: true, clientCapabilities: null,
    });
    expect(plan.paths).toEqual(['platform', 'security-key']);
    expect(plan.prfHint).toBe('unknown');
  });

  test('no platform authenticator → security key is still offered (keys are pluggable)', () => {
    const plan = planEnrollment({
      webAuthnAvailable: true, platformAuthenticator: false, clientCapabilities: null,
    });
    expect(plan.paths).toEqual(['security-key']);
  });

  test('isUVPAA probe failure (null) is unknown, not "no"', () => {
    const plan = planEnrollment({
      webAuthnAvailable: true, platformAuthenticator: null, clientCapabilities: null,
    });
    // Can't confirm a platform authenticator → don't lead with one, but
    // the security-key path never depends on the probe.
    expect(plan.paths).toEqual(['security-key']);
  });

  test('getClientCapabilities can vouch for the platform authenticator when isUVPAA failed', () => {
    const plan = planEnrollment({
      webAuthnAvailable: true,
      platformAuthenticator: null,
      clientCapabilities: { userVerifyingPlatformAuthenticator: true, 'extension:prf': true },
    });
    expect(plan.paths).toEqual(['platform', 'security-key']);
    expect(plan.prfHint).toBe('supported');
  });

  test('client-level PRF unsupported → NO paths (no credential could ever unlock the vault)', () => {
    const plan = planEnrollment({
      webAuthnAvailable: true,
      platformAuthenticator: true,
      clientCapabilities: { 'extension:prf': false, userVerifyingPlatformAuthenticator: true },
    });
    expect(plan).toEqual({ paths: [], prfHint: 'unsupported' });
  });

  test('capability map without the prf key stays "unknown" — absence is not a no', () => {
    const plan = planEnrollment({
      webAuthnAvailable: true,
      platformAuthenticator: true,
      clientCapabilities: { conditionalGet: true },
    });
    expect(plan.prfHint).toBe('unknown');
    expect(plan.paths).toEqual(['platform', 'security-key']);
  });

  test('capabilities saying userVerifyingPlatformAuthenticator:false does not override isUVPAA:true', () => {
    // Two probes disagreeing → any "yes" wins; offering a platform path
    // that fails is recoverable (the create() errors), hiding a working
    // one is not.
    const plan = planEnrollment({
      webAuthnAvailable: true,
      platformAuthenticator: true,
      clientCapabilities: { userVerifyingPlatformAuthenticator: false },
    });
    expect(plan.paths).toEqual(['platform', 'security-key']);
  });
});

// ---------------------------------------------------------------------------
// authenticatorSelectionFor
// ---------------------------------------------------------------------------

describe('authenticatorSelectionFor', () => {
  test('platform flavor pins attachment to "platform"', () => {
    expect(authenticatorSelectionFor('platform')).toEqual({
      residentKey: 'required',
      userVerification: 'required',
      authenticatorAttachment: 'platform',
    });
  });

  test('security-key flavor pins attachment to "cross-platform"', () => {
    expect(authenticatorSelectionFor('security-key')).toEqual({
      residentKey: 'required',
      userVerification: 'required',
      authenticatorAttachment: 'cross-platform',
    });
  });

  test('no flavor → NO attachment key at all (the pre-flavor full-picker behavior)', () => {
    const sel = authenticatorSelectionFor(undefined);
    expect(sel).toEqual({ residentKey: 'required', userVerification: 'required' });
    // why explicit: { authenticatorAttachment: undefined } and an absent
    // key serialize differently into the WebAuthn call; only absence
    // preserves the legacy picker exactly.
    expect('authenticatorAttachment' in sel).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateCreatePrf — the PRF-honesty verdict after create()
// ---------------------------------------------------------------------------

describe('evaluateCreatePrf', () => {
  test('results.first present → ready', () => {
    expect(evaluateCreatePrf({ prf: { enabled: true, results: { first: new ArrayBuffer(32) } } }))
      .toBe('ready');
  });

  test('enabled:false → unsupported (enrollment must fail)', () => {
    expect(evaluateCreatePrf({ prf: { enabled: false } })).toBe('unsupported');
  });

  test('enabled:true without results → follow-up get()', () => {
    expect(evaluateCreatePrf({ prf: { enabled: true } })).toBe('follow-up');
  });

  test('no prf entry at all (older client) → follow-up, the get() is the honest gate', () => {
    expect(evaluateCreatePrf({})).toBe('follow-up');
    expect(evaluateCreatePrf(undefined)).toBe('follow-up');
  });

  test('empty prf object → follow-up (no verdict either way)', () => {
    expect(evaluateCreatePrf({ prf: {} })).toBe('follow-up');
  });
});

// ---------------------------------------------------------------------------
// sanitizeTransports / allowCredentialDescriptor
// ---------------------------------------------------------------------------

describe('sanitizeTransports', () => {
  test('passes a normal getTransports() result through', () => {
    expect(sanitizeTransports(['usb', 'nfc'])).toEqual(['usb', 'nfc']);
    expect(sanitizeTransports(['internal'])).toEqual(['internal']);
  });

  test('null for non-arrays and empty arrays — callers omit the field', () => {
    expect(sanitizeTransports(undefined)).toBe(null);
    expect(sanitizeTransports(null)).toBe(null);
    expect(sanitizeTransports('usb')).toBe(null);
    expect(sanitizeTransports([])).toBe(null);
    expect(sanitizeTransports({})).toBe(null);
  });

  test('drops non-string and oversized entries, dedupes, caps the list', () => {
    expect(sanitizeTransports(['usb', 42, 'usb', '', 'x'.repeat(33), 'ble']))
      .toEqual(['usb', 'ble']);
    const many = Array.from({ length: 20 }, (_, i) => `t${i}`);
    expect(sanitizeTransports(many)!.length).toBe(8);
  });
});

describe('allowCredentialDescriptor', () => {
  const credentialId = new Uint8Array([1, 2, 3]);

  test('includes sanitized transports when usable', () => {
    expect(allowCredentialDescriptor({ credentialId, transports: ['usb', 'nfc'] }))
      .toEqual({ type: 'public-key', id: credentialId, transports: ['usb', 'nfc'] });
  });

  test('omits the transports key entirely when unusable — the legacy descriptor shape', () => {
    const desc = allowCredentialDescriptor({ credentialId, transports: undefined });
    expect(desc).toEqual({ type: 'public-key', id: credentialId });
    expect('transports' in desc).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// platformAuthenticatorLabel — LABEL only, never behavior
// ---------------------------------------------------------------------------

describe('platformAuthenticatorLabel', () => {
  test('recognizes macOS in both userAgentData and navigator.platform shapes', () => {
    expect(platformAuthenticatorLabel('macOS')).toBe('Touch ID');
    expect(platformAuthenticatorLabel('MacIntel')).toBe('Touch ID');
  });

  test('recognizes Windows in both shapes', () => {
    expect(platformAuthenticatorLabel('Windows')).toBe('Windows Hello');
    expect(platformAuthenticatorLabel('Win32')).toBe('Windows Hello');
  });

  test('null for everything else — the UI falls back to generic passkey copy', () => {
    expect(platformAuthenticatorLabel('Linux x86_64')).toBe(null);
    expect(platformAuthenticatorLabel('Android')).toBe(null);
    expect(platformAuthenticatorLabel('')).toBe(null);
    expect(platformAuthenticatorLabel(undefined)).toBe(null);
    expect(platformAuthenticatorLabel(42)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Vault blob schema — prfTransports is ADDITIVE and optional
// ---------------------------------------------------------------------------

const FIXED_PRF_OUTPUT = new Uint8Array(32).fill(0xab);
const FIXED_CRED_ID = new Uint8Array([1, 2, 3, 4]);
const FIXED_PRF_SALT = new Uint8Array(32).fill(0x42);

const makeMockKV = () => {
  const store = new Map<string, unknown>();
  return {
    get: async (k: string) => store.get(k),
    set: async (k: string, v: unknown) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
    // why: the KV contract requires clear; unused by these tests but the
    // Map-backed implementation is the faithful no-op-cost completion.
    clear: async () => { store.clear(); },
    // why: KV.list takes an OPTIONAL prefix; defaulting to '' keeps the
    // mock assignable and matches "no prefix = list everything".
    list: async (prefix = '') => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
      return out;
    },
  };
};

// why: the vault made argon2 injection REQUIRED for any passphrase
// factor (absent → initialize/setRecoveryPassphrase throw
// KdfUnavailableError). These tests exercise PRF transports on
// passphrase-initialized vaults, so they need a deterministic fake —
// same SHA-256-over-inputs shape as vault-kdf.test.ts.
const fakeArgon2 = async (
  { passphrase, salt, memKiB, iters, parallelism }:
  { passphrase: string; salt: Uint8Array; memKiB: number; iters: number; parallelism: number },
): Promise<Uint8Array> => {
  const head = new TextEncoder().encode(`${passphrase}|${memKiB}|${iters}|${parallelism}|`);
  const buf = new Uint8Array(head.length + salt.length);
  buf.set(head);
  buf.set(salt, head.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
};

const newVault = (kv = makeMockKV()) => ({
  kv,
  v: createVault({ kv, argon2: fakeArgon2, autoLockMs: 0, setTimer: () => 0, clearTimer: () => {} }),
});

describe('vault prfTransports (additive blob field)', () => {
  test('enrollPrf stores sanitized transports; prfStatus surfaces them', async () => {
    const { v, kv } = newVault();
    await v.initialize('passphrase-for-transports');
    await v.enrollPrf({
      prfOutput: FIXED_PRF_OUTPUT,
      credentialId: FIXED_CRED_ID,
      prfSalt: FIXED_PRF_SALT,
      transports: ['usb', 'nfc'],
    });
    const blob = await kv.get('vault.v1') as Record<string, unknown>;
    expect(blob.prfTransports).toEqual(['usb', 'nfc']);
    const status = await v.prfStatus();
    expect(status.enrolled).toBe(true);
    // why: prfStatus returns a union; only the enrolled branch carries
    // transports, so narrow before the property access.
    if (!('transports' in status)) throw new Error('expected enrolled prfStatus with transports');
    expect(status.transports).toEqual(['usb', 'nfc']);
  });

  test('enrollment without transports stores nothing and prfStatus omits the key (legacy shape)', async () => {
    const { v, kv } = newVault();
    await v.initialize('passphrase-no-transports');
    await v.enrollPrf({
      prfOutput: FIXED_PRF_OUTPUT,
      credentialId: FIXED_CRED_ID,
      prfSalt: FIXED_PRF_SALT,
    });
    const blob = await kv.get('vault.v1') as Record<string, unknown>;
    expect('prfTransports' in blob).toBe(false);
    const status = await v.prfStatus();
    expect(status.enrolled).toBe(true);
    expect('transports' in status).toBe(false);
  });

  test('re-enrolling WITHOUT transports clears the previous credential\'s list', async () => {
    // why: prfTransports describes the CURRENT credential; a stale list
    // from the replaced credential would mis-route the unlock prompt.
    const { v, kv } = newVault();
    await v.initialize('passphrase-reenroll');
    await v.enrollPrf({
      prfOutput: FIXED_PRF_OUTPUT, credentialId: FIXED_CRED_ID,
      prfSalt: FIXED_PRF_SALT, transports: ['usb'],
    });
    await v.enrollPrf({
      prfOutput: FIXED_PRF_OUTPUT, credentialId: new Uint8Array([9]),
      prfSalt: FIXED_PRF_SALT,
    });
    const blob = await kv.get('vault.v1') as Record<string, unknown>;
    expect('prfTransports' in blob).toBe(false);
  });

  test('garbage transports are dropped, never fail the enrollment', async () => {
    const { v, kv } = newVault();
    await v.initialize('passphrase-garbage-transports');
    await v.enrollPrf({
      prfOutput: FIXED_PRF_OUTPUT,
      credentialId: FIXED_CRED_ID,
      prfSalt: FIXED_PRF_SALT,
      // deliberately wrong shape — e.g. a tampered message payload
      transports: { evil: true } as unknown as string[],
    });
    const blob = await kv.get('vault.v1') as Record<string, unknown>;
    expect('prfTransports' in blob).toBe(false);
    expect((await v.prfStatus()).enrolled).toBe(true);
  });

  test('initializeWithPrfOnly records transports; disablePrf removes them with the wrap', async () => {
    const { v, kv } = newVault();
    await v.initializeWithPrfOnly({
      prfOutput: FIXED_PRF_OUTPUT,
      credentialId: FIXED_CRED_ID,
      prfSalt: FIXED_PRF_SALT,
      transports: ['internal'],
    });
    const status = await v.prfStatus();
    // why: same union narrowing as above — transports only exists on the
    // enrolled branch of the prfStatus return type.
    if (!('transports' in status)) throw new Error('expected enrolled prfStatus with transports');
    expect(status.transports).toEqual(['internal']);
    await v.setRecoveryPassphrase('a-recovery-passphrase');
    await v.disablePrf();
    const blob = await kv.get('vault.v1') as Record<string, unknown>;
    expect('prfTransports' in blob).toBe(false);
  });

  test('PRF unlock still works on a legacy blob with no prfTransports (no schema break)', async () => {
    const { v, kv } = newVault();
    await v.initialize('legacy-blob-passphrase');
    await v.setSecret('k', 'legacy-secret');
    await v.enrollPrf({
      prfOutput: FIXED_PRF_OUTPUT,
      credentialId: FIXED_CRED_ID,
      prfSalt: FIXED_PRF_SALT,
    });
    v.lock();
    const { v: v2 } = newVault(kv as ReturnType<typeof makeMockKV>);
    await v2.unlockWithPrf(FIXED_PRF_OUTPUT);
    expect(await v2.getSecret('k')).toBe('legacy-secret');
  });
});
