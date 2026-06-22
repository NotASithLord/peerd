// @ts-check
// Vault tests.
//
// These hit real SubtleCrypto (so they only pass in a real browser
// runtime — not in jsdom, which is fine because we don't use jsdom).
// PBKDF2 at 600k iterations is slow; we use a wrapper with a smaller
// iteration count would be tempting but skipped — the test cost is real
// and worth paying so we exercise the production parameters.
//
// Tests that need the auto-lock timer use fakeTimers (mocks/clock.js)
// so we don't actually wait 15 minutes.

import { describe, it, expect } from '../../framework.js';
import { createVault, deriveArgon2id } from '/peerd-egress/index.js';

// Real WASM, small memory: fast enough for every test where the 64 MiB
// production cost isn't the thing under test.
const SMALL_PARAMS = Object.freeze({
  algo: 'argon2id', memKiB: 8 * 1024, iters: 2, parallelism: 1,
});

import { makeMockKV } from '../../mocks/kv.js';
import { fakeTimers } from '../../mocks/clock.js';

/** @param {ReturnType<typeof makeMockKV>} [kvOverride] */
const newVault = (kvOverride) => {
  const kv = kvOverride ?? makeMockKV();
  const timers = fakeTimers();
  const v = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS,
    kv,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { v, kv, timers };
};

describe('vault', () => {
  describe('initialize', () => {
    it('marks the vault unlocked after init', async () => {
      const { v } = newVault();
      await v.initialize('hunter2-very-long-passphrase');
      expect(v.isLocked()).toBe(false);
      expect(await v.isInitialized()).toBe(true);
    });

    it('refuses to re-initialize an existing vault', async () => {
      const { v } = newVault();
      await v.initialize('first-passphrase-here');
      await expect(() => v.initialize('second-passphrase-here'))
        .toThrow(e => e.name === 'VaultAlreadyInitializedError');
    });
  });

  describe('unlock', () => {
    it('round-trips: init → lock → unlock with correct passphrase', async () => {
      const { v, kv } = newVault();
      await v.initialize('correct-horse-battery-staple');
      v.lock();
      expect(v.isLocked()).toBe(true);

      // Re-create vault against the same kv to simulate SW restart.
      const { v: v2 } = newVault(kv);
      await v2.unlock('correct-horse-battery-staple');
      expect(v2.isLocked()).toBe(false);
    });

    it('rejects wrong passphrase with WrongPassphraseError', async () => {
      const { v, kv } = newVault();
      await v.initialize('the-right-passphrase');
      v.lock();
      const { v: v2 } = newVault(kv);
      await expect(() => v2.unlock('the-wrong-passphrase'))
        .toThrow(e => e.name === 'WrongPassphraseError');
      expect(v2.isLocked()).toBe(true);
    });

    it('throws VaultNotInitializedError when no vault exists', async () => {
      const { v } = newVault();
      await expect(() => v.unlock('whatever'))
        .toThrow(e => e.name === 'VaultNotInitializedError');
    });
  });

  describe('secrets', () => {
    it('round-trips a secret', async () => {
      const { v } = newVault();
      await v.initialize('passphrase-for-secrets-test');
      await v.setSecret('anthropic_api_key', 'sk-ant-xxx-yyy');
      expect(await v.getSecret('anthropic_api_key')).toBe('sk-ant-xxx-yyy');
    });

    it('returns null for missing secrets (not throws)', async () => {
      const { v } = newVault();
      await v.initialize('passphrase-for-missing-test');
      expect(await v.getSecret('does-not-exist')).toBe(null);
    });

    it('cannot read secrets when locked', async () => {
      const { v } = newVault();
      await v.initialize('passphrase-for-lock-test');
      await v.setSecret('k', 'v');
      v.lock();
      await expect(() => v.getSecret('k'))
        .toThrow(e => e.name === 'VaultLockedError');
    });

    it('cannot write secrets when locked', async () => {
      const { v } = newVault();
      await v.initialize('passphrase-for-lock-write-test');
      v.lock();
      await expect(() => v.setSecret('k', 'v'))
        .toThrow(e => e.name === 'VaultLockedError');
    });

    it('lists stored secret names without decrypting', async () => {
      const { v } = newVault();
      await v.initialize('passphrase-for-list-test');
      await v.setSecret('anthropic', 'sk-a');
      await v.setSecret('openai', 'sk-o');
      const names = await v.listSecretNames();
      expect(names.length).toBe(2);
      expect(names).toContain('anthropic');
      expect(names).toContain('openai');
    });

    it('deletes a secret', async () => {
      const { v } = newVault();
      await v.initialize('passphrase-for-delete-test');
      await v.setSecret('temp', 'value');
      await v.deleteSecret('temp');
      expect(await v.getSecret('temp')).toBe(null);
    });
  });

  describe('at-rest secrecy', () => {
    it('does not store API key plaintext in the kv', async () => {
      // Defense-in-depth: even if vault.js has a bug, we never want the
      // plaintext API key to land in chrome.storage.
      const { v, kv } = newVault();
      await v.initialize('passphrase-for-secrecy-test');
      const sentinel = 'sk-ant-this-must-not-leak-9e1a73c4';
      await v.setSecret('k', sentinel);
      const dump = JSON.stringify([...kv._dump().entries()],
        // Uint8Array doesn't JSON-stringify usefully; coerce to array
        (_, value) => value instanceof Uint8Array ? [...value] : value);
      expect(dump.includes(sentinel)).toBe(false);
    });

    it('does not store the passphrase in the kv', async () => {
      const { v, kv } = newVault();
      const passphrase = 'an-unusual-string-9c7e1a2b';
      await v.initialize(passphrase);
      const dump = JSON.stringify([...kv._dump().entries()]);
      expect(dump.includes(passphrase)).toBe(false);
    });
  });

  describe('auto-lock', () => {
    it('locks after the idle interval', async () => {
      const kv = makeMockKV();
      const timers = fakeTimers();
      const v = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS,
        kv,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        autoLockMs: 1000,
      });
      await v.initialize('passphrase-for-autolock-test');
      expect(v.isLocked()).toBe(false);

      timers.tick(999);
      expect(v.isLocked()).toBe(false);

      timers.tick(1);
      expect(v.isLocked()).toBe(true);
    });

    it('persists the DK to sessionCache on unlock; resumes from it', async () => {
      // Use a tiny in-memory mock sessionCache that matches the
      // chrome.storage.session shape we depend on.
      /** @type {Map<string, any>} */
      const session = new Map();
      const sessionCache = {
        /** @param {string} k */
        sessionGet: async (k) => session.get(k),
        /** @param {string} k @param {any} v */
        sessionSet: async (k, v) => { session.set(k, v); },
        /** @param {string} k */
        sessionDelete: async (k) => { session.delete(k); },
      };
      const kv = makeMockKV();
      const timers = fakeTimers();
      const v1 = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS,
        kv, sessionCache,
        setTimer: timers.setTimer, clearTimer: timers.clearTimer,
        autoLockMs: 0,
      });
      await v1.initialize('passphrase-for-resume-test');
      await v1.setSecret('k', 'plaintext-value');

      // Microtask: persist runs without await; let it complete.
      await new Promise((r) => setTimeout(r, 0));
      expect(session.has('vault.unlocked.v1')).toBe(true);

      // Simulate SW death + fresh boot: build a new vault against the
      // same kv + same sessionCache; the new vault should resume
      // unlocked without needing the passphrase.
      const v2 = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS,
        kv, sessionCache,
        setTimer: timers.setTimer, clearTimer: timers.clearTimer,
        autoLockMs: 0,
      });
      expect(v2.isLocked()).toBe(true);
      const resumed = await v2.attemptResume();
      expect(resumed).toBe(true);
      expect(v2.isLocked()).toBe(false);
      // Existing secrets are decryptable with the resumed DK.
      expect(await v2.getSecret('k')).toBe('plaintext-value');
    });

    it('lock() clears the persisted DK so resume fails afterward', async () => {
      /** @type {Map<string, any>} */
      const session = new Map();
      const sessionCache = {
        /** @param {string} k */
        sessionGet: async (k) => session.get(k),
        /** @param {string} k @param {any} v */
        sessionSet: async (k, v) => { session.set(k, v); },
        /** @param {string} k */
        sessionDelete: async (k) => { session.delete(k); },
      };
      const kv = makeMockKV();
      const timers = fakeTimers();
      const v = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS,
        kv, sessionCache,
        setTimer: timers.setTimer, clearTimer: timers.clearTimer,
        autoLockMs: 0,
      });
      await v.initialize('passphrase-for-lock-clear');
      await new Promise((r) => setTimeout(r, 0));
      expect(session.has('vault.unlocked.v1')).toBe(true);

      v.lock();
      // sessionDelete is fire-and-forget; let microtask flush.
      await new Promise((r) => setTimeout(r, 0));
      expect(session.has('vault.unlocked.v1')).toBe(false);

      // Fresh vault can't resume.
      const v2 = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS,
        kv, sessionCache,
        setTimer: timers.setTimer, clearTimer: timers.clearTimer,
        autoLockMs: 0,
      });
      expect(await v2.attemptResume()).toBe(false);
      expect(v2.isLocked()).toBe(true);
    });

    it('attemptResume returns false when no sessionCache is wired', async () => {
      const { v } = newVault();
      expect(await v.attemptResume()).toBe(false);
    });

    it('autoLockMs <= 0 disables the idle timer entirely', async () => {
      const kv = makeMockKV();
      const timers = fakeTimers();
      const v = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS,
        kv,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        autoLockMs: 0,                  // V1 SW default
      });
      await v.initialize('passphrase-for-no-autolock');
      expect(v.isLocked()).toBe(false);
      // Advance well past any reasonable idle threshold.
      timers.tick(60 * 60 * 1000);
      expect(v.isLocked()).toBe(false);
      // Manual lock still works.
      v.lock();
      expect(v.isLocked()).toBe(true);
    });

    it('touch() resets the idle timer', async () => {
      const kv = makeMockKV();
      const timers = fakeTimers();
      const v = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS,
        kv,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        autoLockMs: 1000,
      });
      await v.initialize('passphrase-for-touch-test');

      timers.tick(900);
      v.touch();
      timers.tick(900);
      // 1800ms total elapsed; without touch this would have fired at
      // 1000ms. After touch the timer is re-armed at +1000ms, so we're
      // 100ms into the new window.
      expect(v.isLocked()).toBe(false);

      timers.tick(101);
      expect(v.isLocked()).toBe(true);
    });
  });
});
