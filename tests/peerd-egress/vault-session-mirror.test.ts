// The chrome.storage.session DK mirror: the one piece of vault state that
// OUTLIVES the service worker.
//
// Two properties are under test, both of them things the SW's own idle timer
// cannot provide (it dies with the SW):
//
//   1. After lock() returns, nothing can resurrect the mirror — including a
//      lock that runs when SW MEMORY is already clear (a fresh SW that never
//      resumed, a double lock), and including a persist that was already in
//      flight when the lock landed.
//   2. The mirror is time-bounded. attemptResume refuses AND purges a mirror
//      past its auto-lock window, a resume preserves the original deadline
//      rather than extending it, and a mirror with no deadline at all (the
//      pre-deadline format) fails closed.
//
// Bun ships real WebCrypto, so the key plumbing here is production code end
// to end; only the Argon2id derive and the clock are injected fakes.

import { describe, test, expect } from 'bun:test';
import {
  createVault, planMirrorResume, makeMirrorRecord,
} from '../../extension/peerd-egress/vault/vault.js';

const SESSION_DK_KEY = 'vault.unlocked.v1';
const PASS = 'correct-horse-battery-staple';
const MINUTE = 60 * 1000;
const RAW_KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32)));

const PRF = {
  prfOutput: new Uint8Array(32).fill(0xab),
  credentialId: new Uint8Array([1, 2, 3]),
  prfSalt: new Uint8Array(32).fill(0x42),
};

const makeKV = () => {
  const store = new Map<string, any>();
  return {
    store,
    get: async (k: string) => store.get(k),
    set: async (k: string, v: any) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
    list: async (prefix = '') => {
      const out: Record<string, any> = {};
      for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
      return out;
    },
    clear: async () => { store.clear(); },
  };
};

/** @param delayMs widen the write window so a lock can race a persist. */
const makeSession = (delayMs = 0, onSet = () => {}) => {
  const store = new Map<string, any>();
  const wait = () => (delayMs ? new Promise((r) => setTimeout(r, delayMs)) : Promise.resolve());
  return {
    store,
    sessionGet: async (k: string) => store.get(k),
    sessionSet: async (k: string, v: any) => { onSet(); await wait(); store.set(k, v); },
    sessionDelete: async (k: string) => { await wait(); store.delete(k); },
  };
};

// Deterministic stand-in for the vendored WASM derive (see vault-kdf.test.ts).
const fakeArgon2 = async ({ passphrase, salt, memKiB, iters, parallelism }: any) => {
  const head = new TextEncoder().encode(`${passphrase}|${memKiB}|${iters}|${parallelism}|`);
  const buf = new Uint8Array(head.length + salt.length);
  buf.set(head);
  buf.set(salt, head.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
};

/** Let fire-and-forget policy restamps and failed cleanup tails drain. */
const flush = () => new Promise((r) => setTimeout(r, 5));

/** A movable clock, so "an hour later" costs nothing. */
const makeClock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};

// ---------------------------------------------------------------------------
// The pure decision
// ---------------------------------------------------------------------------

describe('planMirrorResume', () => {
  const fresh = (over: Record<string, unknown> = {}) =>
    ({ dk: RAW_KEY_B64, unlockedAt: 1000, autoLockMs: 45 * MINUTE, ...over });

  test('nothing stored is absent, not a refusal — there is nothing to purge', () => {
    for (const stored of [undefined, null, '']) {
      expect(planMirrorResume({ stored, now: 1, autoLockMs: MINUTE }))
        .toEqual({ action: 'absent' });
    }
  });

  test('resumes a mirror inside its window, carrying the original timestamp', () => {
    expect(planMirrorResume({ stored: fresh(), now: 1000 + 44 * MINUTE, autoLockMs: 0 }))
      .toEqual({ action: 'resume', dk: RAW_KEY_B64, unlockedAt: 1000 });
  });

  test('refuses at the deadline, not a millisecond after', () => {
    const at = (now: number) => planMirrorResume({ stored: fresh(), now, autoLockMs: 0 }).action;
    expect(at(1000 + 45 * MINUTE - 1)).toBe('resume');
    expect(at(1000 + 45 * MINUTE)).toBe('refuse');
    expect(at(1000 + 10 * 45 * MINUTE)).toBe('refuse');
  });

  test('a bare base64 string — the pre-deadline format — fails closed', () => {
    expect(planMirrorResume({ stored: RAW_KEY_B64, now: 1, autoLockMs: MINUTE }))
      .toEqual({ action: 'refuse', reason: 'legacy' });
  });

  test('a record with no usable timestamp fails closed', () => {
    for (const stored of [
      fresh({ unlockedAt: undefined }),
      fresh({ unlockedAt: 0 }),
      fresh({ unlockedAt: 'yesterday' }),
      fresh({ unlockedAt: Number.NaN }),
      fresh({ dk: undefined }),
      fresh({ dk: '' }),
      42,
    ]) {
      expect(planMirrorResume({ stored, now: 1000, autoLockMs: MINUTE }).action).toBe('refuse');
    }
  });

  test('the recorded policy wins over the caller\'s — the SW boot race', () => {
    // why: the SW builds the vault with the DEFAULT interval and only applies
    // the user's stored setting once storage loads, which a boot-time resume
    // races. Judging the mirror against the policy in force when it was
    // WRITTEN is what keeps a "never auto-lock" user from being logged out by
    // a default they turned off.
    const optedOut = fresh({ autoLockMs: 0 });
    expect(planMirrorResume({ stored: optedOut, now: 1000 + 500 * MINUTE, autoLockMs: 45 * MINUTE }))
      .toMatchObject({ action: 'resume' });
    const tight = fresh({ autoLockMs: MINUTE });
    expect(planMirrorResume({ stored: tight, now: 1000 + 5 * MINUTE, autoLockMs: 0 }))
      .toMatchObject({ action: 'refuse', reason: 'expired' });
  });

  test('falls back to the current policy when the record carries none', () => {
    const noPolicy = { dk: RAW_KEY_B64, unlockedAt: 1000 };
    expect(planMirrorResume({ stored: noPolicy, now: 1000 + 2 * MINUTE, autoLockMs: MINUTE }))
      .toMatchObject({ action: 'refuse', reason: 'expired' });
    expect(planMirrorResume({ stored: noPolicy, now: 1000 + 2 * MINUTE, autoLockMs: 5 * MINUTE }))
      .toMatchObject({ action: 'resume' });
  });
});

describe('makeMirrorRecord', () => {
  test('normalizes every "never auto-lock" spelling to 0', () => {
    for (const ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(makeMirrorRecord({ dk: 'x', unlockedAt: 1, autoLockMs: ms }).autoLockMs).toBe(0);
    }
    expect(makeMirrorRecord({ dk: 'x', unlockedAt: 1, autoLockMs: MINUTE }).autoLockMs).toBe(MINUTE);
  });
});

// ---------------------------------------------------------------------------
// lock() vs the mirror
// ---------------------------------------------------------------------------

describe('lock() and the session mirror', () => {
  test('clears the mirror even when SW memory is already clear', async () => {
    // The regression: a lock arriving on a service worker that never resumed
    // (or a second lock after the first) used to early-return on `dk === null`
    // BEFORE clearing storage, leaving the raw DK bytes behind.
    const kv = makeKV();
    const sessionCache = makeSession();
    const first = createVault({ kv, sessionCache, argon2: fakeArgon2, autoLockMs: 0 });
    await first.initialize(PASS);
    await flush();
    expect(sessionCache.store.has(SESSION_DK_KEY)).toBe(true);

    // A fresh SW: locked memory, no resume attempted, and the user hits Lock.
    const revived = createVault({ kv, sessionCache, argon2: fakeArgon2, autoLockMs: 0 });
    expect(revived.isLocked()).toBe(true);
    revived.lock();
    await flush();
    expect(sessionCache.store.has(SESSION_DK_KEY)).toBe(false);
    expect(await revived.attemptResume()).toBe(false);
  });

  test('a double lock still leaves the mirror gone', async () => {
    const sessionCache = makeSession();
    const v = createVault({ kv: makeKV(), sessionCache, argon2: fakeArgon2, autoLockMs: 0 });
    await v.initialize(PASS);
    await flush();
    v.lock();
    await flush();
    // Second lock: a no-op in memory, and it must not fail or re-write.
    v.lock();
    await flush();
    expect(sessionCache.store.has(SESSION_DK_KEY)).toBe(false);
  });

  test('a lock landing mid-resume wins over the resume', async () => {
    const kv = makeKV();
    const sessionCache = makeSession();
    const first = createVault({ kv, sessionCache, argon2: fakeArgon2, autoLockMs: 0 });
    await first.initialize(PASS);
    await flush();

    const revived = createVault({ kv, sessionCache, argon2: fakeArgon2, autoLockMs: 0 });
    const resuming = revived.attemptResume();
    revived.lock();                            // the user hits Lock mid-boot
    expect(await resuming).toBe(false);
    expect(revived.isLocked()).toBe(true);
    await flush();
    expect(sessionCache.store.has(SESSION_DK_KEY)).toBe(false);
  });

  test('a resume issued immediately after lock waits for a delayed mirror delete', async () => {
    const kv = makeKV();
    const sessionCache = makeSession(20);
    const v = createVault({ kv, sessionCache, argon2: fakeArgon2, autoLockMs: 0 });
    await v.initialize(PASS);
    expect(sessionCache.store.has(SESSION_DK_KEY)).toBe(true);

    const locking = v.lock();
    const resuming = v.attemptResume();
    await expect(locking).resolves.toBeUndefined();
    expect(await resuming).toBe(false);
    expect(v.isLocked()).toBe(true);
    expect(sessionCache.store.has(SESSION_DK_KEY)).toBe(false);
  });

  test('a persist still in flight when the lock lands cannot resurrect it', async () => {
    // The other half of the regression: _persistDK's write completing AFTER a
    // lock. The slow sessionSet widens the window; the epoch check + the
    // serialized queue mean the lock wins by CALL order.
    let markSetStarted = () => {};
    const setStarted = new Promise<void>((resolve) => { markSetStarted = resolve; });
    const sessionCache = makeSession(20, markSetStarted);
    const v = createVault({ kv: makeKV(), sessionCache, argon2: fakeArgon2, autoLockMs: 0 });
    const initializing = v.initialize(PASS);
    await setStarted;
    await v.lock();
    await expect(initializing).rejects.toMatchObject({ name: 'VaultLockedError' });
    await new Promise((r) => setTimeout(r, 100));
    expect(sessionCache.store.has(SESSION_DK_KEY)).toBe(false);
    expect(v.isLocked()).toBe(true);
  });

  test('initialize and unlock fail closed when the restart mirror cannot persist', async () => {
    const failingSession = () => {
      const store = new Map<string, any>();
      return {
        store,
        sessionGet: async (key: string) => store.get(key),
        sessionSet: async () => { throw new Error('session storage unavailable'); },
        sessionDelete: async (key: string) => { store.delete(key); },
      };
    };

    const initialized = createVault({
      kv: makeKV(), sessionCache: failingSession(), argon2: fakeArgon2, autoLockMs: 0,
    });
    await expect(initialized.initialize(PASS)).rejects.toThrow('session storage unavailable');
    expect(initialized.isLocked()).toBe(true);

    const kv = makeKV();
    const seed = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await seed.initialize(PASS);
    await seed.lock();
    const unlocked = createVault({
      kv, sessionCache: failingSession(), argon2: fakeArgon2, autoLockMs: 0,
    });
    await expect(unlocked.unlock(PASS)).rejects.toThrow('session storage unavailable');
    expect(unlocked.isLocked()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The mirror's lifetime
// ---------------------------------------------------------------------------

describe('the mirror expires with the auto-lock window', () => {
  const seed = async (clock: ReturnType<typeof makeClock>, autoLockMs: number) => {
    const kv = makeKV();
    const sessionCache = makeSession();
    const v = createVault({ kv, sessionCache, argon2: fakeArgon2, autoLockMs, now: clock.now });
    await v.initialize(PASS);
    await v.setSecret('anthropic', 'sk-ant-bounded');
    await flush();
    return { kv, sessionCache };
  };

  test('every entry path stamps the deadline onto the mirror', async () => {
    const clock = makeClock();
    for (const enter of [
      (v: any) => v.initialize(PASS),
      (v: any) => v.initializeWithPrfOnly(PRF),
    ]) {
      const sessionCache = makeSession();
      const v = createVault({
        kv: makeKV(), sessionCache, argon2: fakeArgon2, autoLockMs: 45 * MINUTE, now: clock.now,
      });
      await enter(v);
      await flush();
      expect(sessionCache.store.get(SESSION_DK_KEY)).toMatchObject({
        unlockedAt: clock.now(), autoLockMs: 45 * MINUTE,
      });
    }
    // …and the same for the two re-entry paths, against an existing blob.
    const kv = makeKV();
    const sessionCache = makeSession();
    const seedVault = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await seedVault.initialize(PASS);
    await seedVault.enrollPrf(PRF);
    seedVault.lock();

    for (const enter of [
      (v: any) => v.unlock(PASS),
      (v: any) => v.unlockWithPrf(PRF.prfOutput),
    ]) {
      sessionCache.store.clear();
      clock.advance(MINUTE);
      const v = createVault({
        kv, sessionCache, argon2: fakeArgon2, autoLockMs: 45 * MINUTE, now: clock.now,
      });
      await enter(v);
      await flush();
      expect(sessionCache.store.get(SESSION_DK_KEY)).toMatchObject({
        unlockedAt: clock.now(), autoLockMs: 45 * MINUTE,
      });
    }
  });

  test('a stale mirror is REFUSED and PURGED by attemptResume', async () => {
    const clock = makeClock();
    const { kv, sessionCache } = await seed(clock, 45 * MINUTE);

    // The SW died with the idle timer still pending; the user came back the
    // next morning believing the vault auto-locked an hour in.
    clock.advance(12 * 60 * MINUTE);
    const revived = createVault({
      kv, sessionCache, argon2: fakeArgon2, autoLockMs: 45 * MINUTE, now: clock.now,
    });
    expect(await revived.attemptResume()).toBe(false);
    expect(revived.isLocked()).toBe(true);
    await flush();
    // Purged, not merely declined: the bytes do not survive to be judged again.
    expect(sessionCache.store.has(SESSION_DK_KEY)).toBe(false);
    // And the vault is genuinely locked, not half-adopted.
    await expect(revived.getSecret('anthropic')).rejects.toMatchObject({ name: 'VaultLockedError' });
    await expect(revived.enrollPrf(PRF)).rejects.toMatchObject({ name: 'VaultLockedError' });
    // The passphrase still opens it — refusing a resume is not data loss.
    await revived.unlock(PASS);
    expect(await revived.getSecret('anthropic')).toBe('sk-ant-bounded');
  });

  test('a resume does not extend the window', async () => {
    const clock = makeClock();
    const { kv, sessionCache } = await seed(clock, 45 * MINUTE);
    const unlockedAt = clock.now();

    // Restart 40 minutes in: still inside the window, so it resumes…
    clock.advance(40 * MINUTE);
    const second = createVault({
      kv, sessionCache, argon2: fakeArgon2, autoLockMs: 45 * MINUTE, now: clock.now,
    });
    expect(await second.attemptResume()).toBe(true);
    await flush();
    // …anchored to the ORIGINAL unlock, in memory and in storage alike.
    expect(second.unlockedAt()).toBe(unlockedAt);
    expect(sessionCache.store.get(SESSION_DK_KEY)).toMatchObject({ unlockedAt });

    // Restart again 10 minutes later: 50 > 45 since the real unlock, so the
    // window is spent — a resume-per-window loop cannot keep it alive.
    clock.advance(10 * MINUTE);
    const third = createVault({
      kv, sessionCache, argon2: fakeArgon2, autoLockMs: 45 * MINUTE, now: clock.now,
    });
    expect(await third.attemptResume()).toBe(false);
    await flush();
    expect(sessionCache.store.has(SESSION_DK_KEY)).toBe(false);
  });

  test('a resumed vault can still enroll and re-wrap — the seam survives', async () => {
    const clock = makeClock();
    const { kv, sessionCache } = await seed(clock, 45 * MINUTE);
    clock.advance(MINUTE);
    const revived = createVault({
      kv, sessionCache, argon2: fakeArgon2, autoLockMs: 45 * MINUTE, now: clock.now,
    });
    expect(await revived.attemptResume()).toBe(true);
    await revived.enrollPrf(PRF);
    await revived.setRecoveryPassphrase('a-different-passphrase-entirely');
    revived.lock();

    const viaPrf = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await viaPrf.unlockWithPrf(PRF.prfOutput);
    expect(await viaPrf.getSecret('anthropic')).toBe('sk-ant-bounded');
  });

  test('the pre-deadline mirror format is refused and purged', async () => {
    const kv = makeKV();
    const sessionCache = makeSession();
    const seedVault = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await seedVault.initialize(PASS);
    // What an install upgraded mid-session would find: bare base64, no age.
    sessionCache.store.set(SESSION_DK_KEY, RAW_KEY_B64);

    const v = createVault({ kv, sessionCache, argon2: fakeArgon2, autoLockMs: 45 * MINUTE });
    expect(await v.attemptResume()).toBe(false);
    await flush();
    expect(sessionCache.store.has(SESSION_DK_KEY)).toBe(false);
  });

  test('"never auto-lock" keeps the unbounded mirror it always had', async () => {
    const clock = makeClock();
    const { kv, sessionCache } = await seed(clock, 0);
    expect(sessionCache.store.get(SESSION_DK_KEY)).toMatchObject({ autoLockMs: 0 });

    clock.advance(30 * 24 * 60 * MINUTE);      // a month later
    const revived = createVault({ kv, sessionCache, argon2: fakeArgon2, autoLockMs: 0, now: clock.now });
    expect(await revived.attemptResume()).toBe(true);
    expect(await revived.getSecret('anthropic')).toBe('sk-ant-bounded');
  });

  test('setAutoLockMs re-stamps the mirror, so tightening the setting reaches it', async () => {
    const clock = makeClock();
    const kv = makeKV();
    const sessionCache = makeSession();
    const v = createVault({ kv, sessionCache, argon2: fakeArgon2, autoLockMs: 0, now: clock.now });
    await v.initialize(PASS);
    await flush();
    expect(sessionCache.store.get(SESSION_DK_KEY)).toMatchObject({ autoLockMs: 0 });

    v.setAutoLockMs(5 * MINUTE);               // the user picks a tighter policy
    await flush();
    expect(sessionCache.store.get(SESSION_DK_KEY))
      .toMatchObject({ autoLockMs: 5 * MINUTE, unlockedAt: clock.now() });

    clock.advance(6 * MINUTE);
    const revived = createVault({ kv, sessionCache, argon2: fakeArgon2, autoLockMs: 0, now: clock.now });
    expect(await revived.attemptResume()).toBe(false);
  });

  test('setAutoLockMs on a LOCKED vault never re-writes a mirror', async () => {
    // why: at SW boot the settings load and the resume race each other. If the
    // settings landed first and re-stamped, it would resurrect a mirror the
    // boot may be about to purge.
    const sessionCache = makeSession();
    const v = createVault({ kv: makeKV(), sessionCache, argon2: fakeArgon2, autoLockMs: 0 });
    v.setAutoLockMs(5 * MINUTE);
    await flush();
    expect(sessionCache.store.size).toBe(0);
  });
});
