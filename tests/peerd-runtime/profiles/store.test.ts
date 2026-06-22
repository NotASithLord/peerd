// Profiles — pure core + store over an in-memory idb fake.
//
// The default profile is the SHAPE multi-profile will reuse (ROADMAP
// "Profiles", deprioritized): one 'default' record carrying peerName +
// the onboardingComplete latch. These tests pin the contract the SW
// and the onboarding flow rely on: idempotent ensureDefault, the
// peer-name normalization chokepoint, identity-preserving update, and
// the one-shot completeOnboarding latch.

import { describe, test, expect } from 'bun:test';

import {
  DEFAULT_PROFILE_ID, DEFAULT_PEER_NAME, PEER_NAME_MAX,
  normalizePeerName, defaultProfileRecord,
} from '../../../extension/peerd-runtime/profiles/profile.js';
import { createProfileStore }
  from '../../../extension/peerd-runtime/profiles/store.js';
import { ProfileNotFoundError }
  from '../../../extension/peerd-runtime/errors.js';

/** Minimal in-memory stand-in for the egress idb adapter. */
const fakeIdb = () => {
  const stores = new Map<string, Map<string, any>>();
  const s = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  return {
    get: async (store: string, key: string) => s(store).get(key),
    put: async (store: string, value: any) => { s(store).set(value.id, value); },
    getAll: async (store: string) => [...s(store).values()],
    del: async (store: string, key: string) => { s(store).delete(key); },
  };
};

// ── pure core ───────────────────────────────────────────────────────────

describe('normalizePeerName', () => {
  test('trims and collapses internal whitespace', () => {
    expect(normalizePeerName('  my   peer  ')).toBe('my peer');
  });
  test('caps at PEER_NAME_MAX', () => {
    const long = 'x'.repeat(PEER_NAME_MAX + 20);
    expect(normalizePeerName(long).length).toBe(PEER_NAME_MAX);
  });
  test('empty / whitespace-only / non-string falls back to the default', () => {
    expect(normalizePeerName('')).toBe(DEFAULT_PEER_NAME);
    expect(normalizePeerName('   ')).toBe(DEFAULT_PEER_NAME);
    expect(normalizePeerName(undefined)).toBe(DEFAULT_PEER_NAME);
    expect(normalizePeerName(42 as any)).toBe(DEFAULT_PEER_NAME);
  });
  test('a cap that leaves trailing whitespace still trims', () => {
    // 31 chars + space + more — the slice lands on the space.
    const name = `${'a'.repeat(PEER_NAME_MAX - 1)} bcd`;
    expect(normalizePeerName(name)).toBe('a'.repeat(PEER_NAME_MAX - 1));
  });
});

describe('defaultProfileRecord', () => {
  test('carries the multi-profile-ready shape with the latch open', () => {
    const rec = defaultProfileRecord({ now: () => 1234 });
    expect(rec).toEqual({
      id: DEFAULT_PROFILE_ID,
      peerName: DEFAULT_PEER_NAME,
      createdAt: 1234,
      onboardingComplete: false,
    });
  });
});

// ── store ───────────────────────────────────────────────────────────────

describe('createProfileStore', () => {
  test('requires an idb adapter', () => {
    expect(() => createProfileStore({} as any)).toThrow(TypeError);
  });

  test('ensureDefault creates once and is idempotent', async () => {
    const store = createProfileStore({ idb: fakeIdb(), now: () => 1000 });
    const first = await store.ensureDefault();
    expect(first.id).toBe(DEFAULT_PROFILE_ID);
    expect(first.onboardingComplete).toBe(false);

    // A later call must NOT reset user state (peerName, the latch).
    await store.update(DEFAULT_PROFILE_ID, { peerName: 'jarvis', onboardingComplete: true });
    const again = await store.ensureDefault();
    expect(again.peerName).toBe('jarvis');
    expect(again.onboardingComplete).toBe(true);
  });

  test('update patches but preserves id and createdAt', async () => {
    const store = createProfileStore({ idb: fakeIdb(), now: () => 1000 });
    await store.ensureDefault();
    const updated = await store.update(DEFAULT_PROFILE_ID, {
      peerName: 'hal', id: 'evil', createdAt: 9,
    } as any);
    expect(updated.peerName).toBe('hal');
    expect(updated.id).toBe(DEFAULT_PROFILE_ID);
    expect(updated.createdAt).toBe(1000);
  });

  test('update of a missing profile throws the named error', async () => {
    const store = createProfileStore({ idb: fakeIdb(), now: () => 1000 });
    await expect(store.update('nope', { peerName: 'x' }))
      .rejects.toBeInstanceOf(ProfileNotFoundError);
  });

  test('completeOnboarding latches, normalizes, and stamps onboardedAt', async () => {
    let t = 1000;
    const store = createProfileStore({ idb: fakeIdb(), now: () => t });
    // why no prior ensureDefault: onboarding can complete before any
    // state push materialized the record — it must self-create.
    t = 2000;
    const rec = await store.completeOnboarding({ peerName: '  my  peer ' });
    expect(rec.peerName).toBe('my peer');
    expect(rec.onboardingComplete).toBe(true);
    expect(rec.onboardedAt).toBe(2000);
    expect((await store.get(DEFAULT_PROFILE_ID))!.onboardingComplete).toBe(true);
  });

  test('completeOnboarding with no name (skip) keeps the default peer name', async () => {
    const store = createProfileStore({ idb: fakeIdb(), now: () => 1000 });
    const rec = await store.completeOnboarding({});
    expect(rec.peerName).toBe(DEFAULT_PEER_NAME);
    expect(rec.onboardingComplete).toBe(true);
  });

  test('list returns profiles oldest first', async () => {
    const idb = fakeIdb();
    const store = createProfileStore({ idb, now: () => 5 });
    await store.ensureDefault();
    // Simulate a future second profile written directly.
    await idb.put('profiles', { id: 'work', peerName: 'w', createdAt: 1, onboardingComplete: true });
    const all = await store.list();
    expect(all.map((p: any) => p.id)).toEqual(['work', DEFAULT_PROFILE_ID]);
  });
});
