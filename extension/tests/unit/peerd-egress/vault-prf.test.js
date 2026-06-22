// @ts-check
// Vault — WebAuthn PRF unlock path.
//
// These tests don't run the WebAuthn ceremony (you can't drive a Touch
// ID prompt from a unit test). Instead they exercise the vault's
// crypto-side contract: given a 32-byte PRF output (the same shape an
// authenticator would return), can we round-trip enroll → lock →
// unlock-with-PRF and decrypt our secrets again?
//
// The 32-byte PRF output is treated as raw AES-KW key material by the
// vault. We feed deterministic fixed bytes here; in production the
// bytes come from the platform authenticator's HMAC.

import { describe, it, expect } from '../../framework.js';
import { createVault, deriveArgon2id } from '/peerd-egress/index.js';

// Real WASM, small memory: fast enough for every test where the 64 MiB
// production cost isn't the thing under test.
const SMALL_PARAMS = Object.freeze({
  algo: 'argon2id', memKiB: 8 * 1024, iters: 2, parallelism: 1,
});

import { makeMockKV } from '../../mocks/kv.js';
import { fakeTimers } from '../../mocks/clock.js';

const FIXED_PRF_OUTPUT = new Uint8Array(32).fill(0xab);
const ALT_PRF_OUTPUT   = new Uint8Array(32).fill(0xcd);
const FIXED_CRED_ID    = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
const FIXED_PRF_SALT   = new Uint8Array(32).fill(0x42);

/** @param {ReturnType<typeof makeMockKV>} [kvOverride] */
const newVault = (kvOverride) => {
  const kv = kvOverride ?? makeMockKV();
  const timers = fakeTimers();
  const v = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS,
    kv,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    autoLockMs: 0,
  });
  return { v, kv, timers };
};

describe('vault.prf', () => {
  describe('prfStatus', () => {
    it('reports not-enrolled on a fresh vault', async () => {
      const { v } = newVault();
      await v.initialize('passphrase-for-prf-status-fresh');
      const status = await v.prfStatus();
      expect(status.enrolled).toBe(false);
    });

    it('reports enrolled after enrollPrf and exposes credentialId + prfSalt', async () => {
      const { v } = newVault();
      await v.initialize('passphrase-for-prf-status-enrolled');
      await v.enrollPrf({
        prfOutput:    FIXED_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      });
      // prfStatus() returns a (non-discriminated) union; this branch is
      // prfStatus() returns a discriminated union; assert enrolled, then the
      // `if` narrows it to the branch carrying the opaque base64 fields.
      const status = await v.prfStatus();
      expect(status.enrolled).toBe(true);
      // why: these are passed opaquely back to the side panel as base64;
      // we don't need to decode them in the test, just confirm they exist.
      if (status.enrolled) {
        expect(typeof status.credentialId).toBe('string');
        expect(typeof status.prfSalt).toBe('string');
      }
    });
  });

  describe('enrollPrf', () => {
    it('refuses when locked', async () => {
      const { v } = newVault();
      await v.initialize('passphrase-for-prf-enroll-locked');
      v.lock();
      await expect(() => v.enrollPrf({
        prfOutput:    FIXED_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      })).toThrow(e => e.name === 'VaultLockedError');
    });

    it('refuses 31-byte and 33-byte PRF outputs', async () => {
      const { v } = newVault();
      await v.initialize('passphrase-for-prf-enroll-bad-len');
      await expect(() => v.enrollPrf({
        prfOutput:    new Uint8Array(31),
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      })).toThrow(e => /32 bytes/.test(e?.message));
      await expect(() => v.enrollPrf({
        prfOutput:    new Uint8Array(33),
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      })).toThrow(e => /32 bytes/.test(e?.message));
    });

    it('is idempotent — re-enrolling with new bytes overwrites', async () => {
      const { v, kv } = newVault();
      await v.initialize('passphrase-for-prf-enroll-idempotent');
      await v.enrollPrf({
        prfOutput:    FIXED_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      });
      const firstWrap = (await kv.get('vault.v1')).wrappedDK_prf;
      await v.enrollPrf({
        prfOutput:    ALT_PRF_OUTPUT,
        credentialId: new Uint8Array([0x99]),
        prfSalt:      new Uint8Array(32).fill(0x77),
      });
      const secondWrap = (await kv.get('vault.v1')).wrappedDK_prf;
      // why: re-wrap with a different KEK MUST produce different bytes
      // because the DK is identical but the wrapping key changed.
      expect(firstWrap !== secondWrap).toBe(true);
    });
  });

  describe('unlockWithPrf', () => {
    it('round-trips: init → enroll → lock → unlock-with-PRF', async () => {
      const { v, kv } = newVault();
      await v.initialize('passphrase-for-prf-roundtrip');
      await v.setSecret('anthropic', 'sk-ant-the-secret');
      await v.enrollPrf({
        prfOutput:    FIXED_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      });
      v.lock();
      expect(v.isLocked()).toBe(true);

      // Simulate SW restart with the same kv.
      const { v: v2 } = newVault(kv);
      await v2.unlockWithPrf(FIXED_PRF_OUTPUT);
      expect(v2.isLocked()).toBe(false);
      // The DK recovered via PRF must decrypt secrets stored under the
      // passphrase-DK — they're the SAME DK, just wrapped twice.
      expect(await v2.getSecret('anthropic')).toBe('sk-ant-the-secret');
    });

    it('passphrase unlock still works after PRF enrollment', async () => {
      // Critical: PRF is an alternative path, NOT a replacement. The
      // user must always be able to fall back to their passphrase.
      const { v, kv } = newVault();
      await v.initialize('the-original-passphrase-9c1f');
      await v.setSecret('k', 'fallback-test-value');
      await v.enrollPrf({
        prfOutput:    FIXED_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      });
      v.lock();
      const { v: v2 } = newVault(kv);
      await v2.unlock('the-original-passphrase-9c1f');
      expect(v2.isLocked()).toBe(false);
      expect(await v2.getSecret('k')).toBe('fallback-test-value');
    });

    it('rejects wrong PRF output with PrfUnlockFailedError', async () => {
      const { v, kv } = newVault();
      await v.initialize('passphrase-for-prf-wrong-bytes');
      await v.enrollPrf({
        prfOutput:    FIXED_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      });
      v.lock();
      const { v: v2 } = newVault(kv);
      await expect(() => v2.unlockWithPrf(ALT_PRF_OUTPUT))
        .toThrow(e => e.name === 'PrfUnlockFailedError');
      expect(v2.isLocked()).toBe(true);
    });

    it('throws PrfNotEnrolledError when no PRF wrap is stored', async () => {
      const { v, kv } = newVault();
      await v.initialize('passphrase-for-prf-no-enroll');
      v.lock();
      const { v: v2 } = newVault(kv);
      await expect(() => v2.unlockWithPrf(FIXED_PRF_OUTPUT))
        .toThrow(e => e.name === 'PrfNotEnrolledError');
    });

    it('throws VaultNotInitializedError if there is no vault at all', async () => {
      const { v } = newVault();
      await expect(() => v.unlockWithPrf(FIXED_PRF_OUTPUT))
        .toThrow(e => e.name === 'VaultNotInitializedError');
    });
  });

  describe('disablePrf', () => {
    it('removes the PRF wrap and leaves the passphrase wrap intact', async () => {
      const { v, kv } = newVault();
      await v.initialize('passphrase-for-prf-disable');
      await v.setSecret('k', 'still-here');
      await v.enrollPrf({
        prfOutput:    FIXED_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      });
      await v.disablePrf();

      // PRF unlock no longer possible.
      v.lock();
      const { v: v2 } = newVault(kv);
      await expect(() => v2.unlockWithPrf(FIXED_PRF_OUTPUT))
        .toThrow(e => e.name === 'PrfNotEnrolledError');

      // Passphrase unlock still works and secrets are intact.
      await v2.unlock('passphrase-for-prf-disable');
      expect(await v2.getSecret('k')).toBe('still-here');
    });

    it('is idempotent when no PRF is enrolled', async () => {
      const { v } = newVault();
      await v.initialize('passphrase-for-prf-disable-idempotent');
      // Should not throw.
      await v.disablePrf();
      const status = await v.prfStatus();
      expect(status.enrolled).toBe(false);
    });

    it('refuses when locked', async () => {
      const { v } = newVault();
      await v.initialize('passphrase-for-prf-disable-locked');
      v.lock();
      await expect(() => v.disablePrf())
        .toThrow(e => e.name === 'VaultLockedError');
    });
  });

  // ── Passkey-first: a vault keyed ONLY by the authenticator's PRF, with
  //    no passphrase factor. The recovery passphrase is added later (or
  //    never). Mirrors the WebAuthn-available sign-up path. ──────────────
  describe('initializeWithPrfOnly (passkey-only)', () => {
    it('creates an unlocked vault with a PRF wrap and NO passphrase wrap', async () => {
      const { v, kv } = newVault();
      await v.initializeWithPrfOnly({
        prfOutput:    FIXED_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      });
      expect(v.isLocked()).toBe(false);
      const stored = await kv.get('vault.v1');
      expect(typeof stored.wrappedDK_prf).toBe('string');
      // why: the whole point — there is no passphrase factor at sign-up.
      expect(stored.wrappedDK).toBe(undefined);
      expect(stored.salt).toBe(undefined);
      expect((await v.prfStatus()).enrolled).toBe(true);
      expect(await v.hasRecoveryPassphrase()).toBe(false);
    });

    it('round-trips: init → lock → unlock-with-PRF decrypts secrets', async () => {
      const { v, kv } = newVault();
      await v.initializeWithPrfOnly({
        prfOutput:    FIXED_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      });
      await v.setSecret('anthropic', 'sk-ant-passkey-only');
      v.lock();
      const { v: v2 } = newVault(kv);   // simulate SW restart
      await v2.unlockWithPrf(FIXED_PRF_OUTPUT);
      expect(v2.isLocked()).toBe(false);
      expect(await v2.getSecret('anthropic')).toBe('sk-ant-passkey-only');
    });

    it('refuses to initialize over an existing vault', async () => {
      const { v } = newVault();
      await v.initializeWithPrfOnly({
        prfOutput:    FIXED_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      });
      await expect(() => v.initializeWithPrfOnly({
        prfOutput:    ALT_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      })).toThrow(e => e.name === 'VaultAlreadyInitializedError');
    });

    it('passphrase unlock throws RecoveryPassphraseNotSetError until one is set', async () => {
      const { v, kv } = newVault();
      await v.initializeWithPrfOnly({
        prfOutput:    FIXED_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      });
      v.lock();
      const { v: v2 } = newVault(kv);
      await expect(() => v2.unlock('any-passphrase-here'))
        .toThrow(e => e.name === 'RecoveryPassphraseNotSetError');
      expect(v2.isLocked()).toBe(true);
    });
  });

  describe('setRecoveryPassphrase', () => {
    it('adds a passphrase factor to a passkey-only vault — both factors then unlock the same DK', async () => {
      const { v, kv } = newVault();
      await v.initializeWithPrfOnly({
        prfOutput:    FIXED_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      });
      await v.setSecret('k', 'recover-me');
      expect(await v.hasRecoveryPassphrase()).toBe(false);
      await v.setRecoveryPassphrase('my-recovery-passphrase');
      expect(await v.hasRecoveryPassphrase()).toBe(true);

      // Passphrase unlock now works after a restart…
      v.lock();
      const { v: v2 } = newVault(kv);
      await v2.unlock('my-recovery-passphrase');
      expect(await v2.getSecret('k')).toBe('recover-me');

      // …and the passkey still unlocks the very same DK.
      v2.lock();
      const { v: v3 } = newVault(kv);
      await v3.unlockWithPrf(FIXED_PRF_OUTPUT);
      expect(await v3.getSecret('k')).toBe('recover-me');
    });

    it('refuses when the vault is locked', async () => {
      const { v, kv } = newVault();
      await v.initializeWithPrfOnly({
        prfOutput:    FIXED_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      });
      v.lock();
      const { v: v2 } = newVault(kv);
      await expect(() => v2.setRecoveryPassphrase('whatever-passphrase'))
        .toThrow(e => e.name === 'VaultLockedError');
    });

    it('replacing the recovery passphrase invalidates the old one', async () => {
      const { v, kv } = newVault();
      await v.initializeWithPrfOnly({
        prfOutput:    FIXED_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      });
      await v.setRecoveryPassphrase('first-recovery-pass');
      await v.setRecoveryPassphrase('second-recovery-pass');
      v.lock();
      const { v: v2 } = newVault(kv);
      await expect(() => v2.unlock('first-recovery-pass'))
        .toThrow(e => e.name === 'WrongPassphraseError');
      await v2.unlock('second-recovery-pass');
      expect(v2.isLocked()).toBe(false);
    });
  });

  describe('disablePrf — last-factor guard', () => {
    it('refuses to remove the passkey when it is the only factor', async () => {
      const { v } = newVault();
      await v.initializeWithPrfOnly({
        prfOutput:    FIXED_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      });
      await expect(() => v.disablePrf())
        .toThrow(e => e.name === 'RecoveryPassphraseNotSetError');
      // Nothing was removed — the passkey is still enrolled.
      expect((await v.prfStatus()).enrolled).toBe(true);
    });

    it('allows removing the passkey once a recovery passphrase exists', async () => {
      const { v, kv } = newVault();
      await v.initializeWithPrfOnly({
        prfOutput:    FIXED_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      });
      await v.setSecret('k', 'kept');
      await v.setRecoveryPassphrase('the-recovery-pass');
      await v.disablePrf();
      expect((await v.prfStatus()).enrolled).toBe(false);

      // PRF no longer unlocks; the recovery passphrase does.
      v.lock();
      const { v: v2 } = newVault(kv);
      await expect(() => v2.unlockWithPrf(FIXED_PRF_OUTPUT))
        .toThrow(e => e.name === 'PrfNotEnrolledError');
      await v2.unlock('the-recovery-pass');
      expect(await v2.getSecret('k')).toBe('kept');
    });
  });

  describe('hasRecoveryPassphrase', () => {
    it('is true for a passphrase-initialized vault', async () => {
      const { v } = newVault();
      await v.initialize('a-real-passphrase');
      expect(await v.hasRecoveryPassphrase()).toBe(true);
    });

    it('is false for a passkey-only vault', async () => {
      const { v } = newVault();
      await v.initializeWithPrfOnly({
        prfOutput:    FIXED_PRF_OUTPUT,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      });
      expect(await v.hasRecoveryPassphrase()).toBe(false);
    });
  });

  describe('at-rest secrecy', () => {
    it('does not store the PRF output bytes in the kv', async () => {
      // Defense-in-depth: the wrapped DK should be opaque to anyone with
      // storage access, and the PRF output itself must never land at rest.
      const { v, kv } = newVault();
      await v.initialize('passphrase-for-prf-secrecy');
      const sentinelBytes = new Uint8Array(32);
      crypto.getRandomValues(sentinelBytes);
      await v.enrollPrf({
        prfOutput:    sentinelBytes,
        credentialId: FIXED_CRED_ID,
        prfSalt:      FIXED_PRF_SALT,
      });
      const dump = JSON.stringify([...kv._dump().entries()],
        (_, value) => value instanceof Uint8Array ? [...value] : value);
      // Look for the first 8 bytes of the PRF output as a hex string.
      const head = [...sentinelBytes.slice(0, 8)]
        .map(b => b.toString(16).padStart(2, '0')).join('');
      expect(dump.toLowerCase().includes(head)).toBe(false);
    });
  });
});
