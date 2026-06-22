// Idle vault auto-lock: the unwrapped DK must not sit live indefinitely.
// We drive the lifecycle through attemptResume() (fast — importKey of raw
// bytes, no KEK derivation) with injected fake timers so we can fire the
// idle callback deterministically.

import { describe, test, expect } from 'bun:test';
import { createVault, DEFAULT_AUTO_LOCK_MS } from '../../extension/peerd-egress/vault/vault.js';

const SESSION_DK_KEY = 'vault.unlocked.v1';
const RAW_KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32))); // 32 zero bytes = a valid AES-256 key

const makeTimers = () => {
  const pending = new Map<number, () => void>();
  let id = 0;
  return {
    setTimer: (fn: () => void) => { const i = ++id; pending.set(i, fn); return i; },
    clearTimer: (i: number) => { pending.delete(i); },
    fireAll: () => { for (const fn of [...pending.values()]) fn(); },
    count: () => pending.size,
  };
};

const makeSession = () => {
  const store = new Map<string, string>([[SESSION_DK_KEY, RAW_KEY_B64]]);
  return {
    sessionGet: async (k: string) => store.get(k),
    sessionSet: async (k: string, v: string) => { store.set(k, v); },
    sessionDelete: async (k: string) => { store.delete(k); },
  };
};

const newVault = (autoLockMs: number, t: ReturnType<typeof makeTimers>) => createVault({
  kv: { get: async () => undefined, set: async () => {}, delete: async () => {}, list: async () => ({}), clear: async () => {} },
  sessionCache: makeSession(),
  autoLockMs,
  setTimer: t.setTimer,
  clearTimer: t.clearTimer,
  now: () => 1,
});

describe('vault idle auto-lock', () => {
  test('default interval is 45 minutes', () => {
    expect(DEFAULT_AUTO_LOCK_MS).toBe(45 * 60 * 1000);
  });

  test('arms a timer on unlock and locks when it fires', async () => {
    const t = makeTimers();
    const vault = newVault(1000, t);
    expect(await vault.attemptResume()).toBe(true);
    expect(vault.isLocked()).toBe(false);
    expect(t.count()).toBe(1);          // idle timer armed
    t.fireAll();
    expect(vault.isLocked()).toBe(true); // fired → vault locked
  });

  test('setAutoLockMs(0) disables the idle timer without locking', async () => {
    const t = makeTimers();
    const vault = newVault(1000, t);
    await vault.attemptResume();
    expect(t.count()).toBe(1);
    vault.setAutoLockMs(0);
    expect(t.count()).toBe(0);           // no pending idle timer
    expect(vault.isLocked()).toBe(false); // still unlocked — just no idle lock
  });

  test('setAutoLockMs(positive) re-arms while unlocked', async () => {
    const t = makeTimers();
    const vault = newVault(0, t);        // start with idle lock disabled
    await vault.attemptResume();
    expect(t.count()).toBe(0);
    vault.setAutoLockMs(500);
    expect(t.count()).toBe(1);           // re-armed immediately
    t.fireAll();
    expect(vault.isLocked()).toBe(true);
  });

  test('a fresh (still-locked) vault arms nothing', async () => {
    const t = makeTimers();
    // no session key → attemptResume can't unlock
    const vault = createVault({
      kv: { get: async () => undefined, set: async () => {}, delete: async () => {}, list: async () => ({}), clear: async () => {} },
      sessionCache: { sessionGet: async () => undefined, sessionSet: async () => {}, sessionDelete: async () => {} },
      autoLockMs: 1000, setTimer: t.setTimer, clearTimer: t.clearTimer, now: () => 1,
    });
    expect(await vault.attemptResume()).toBe(false);
    expect(vault.isLocked()).toBe(true);
    expect(t.count()).toBe(0);
    vault.setAutoLockMs(500);            // locked → no timer armed
    expect(t.count()).toBe(0);
  });
});
