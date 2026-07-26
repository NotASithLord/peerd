// issue 251 — the half of the classifier that grows with use.
//
// The invariant worth guarding: this store can only ever mark an origin as MORE
// protected. Nothing in it makes an origin ordinary again, because a false
// positive costs a handoff while a false negative costs a roaming actor loose on
// a site the user is logged into.

import { describe, test, expect } from 'bun:test';
import { makeLearnedOrigins, MAX_LEARNED } from '../../../extension/peerd-runtime/actor/learned-origins.js';

const harness = (stored: Record<string, string> | null = null) => {
  const saves: Array<Record<string, string>> = [];
  const learns: Array<[string, string]> = [];
  const store = makeLearnedOrigins({
    load: async () => stored,
    save: async (all) => { saves.push({ ...all }); },
    onLearn: (o, r) => { learns.push([o, r]); },
    onError: () => {},
  });
  return { store, saves, learns };
};

describe('learning', () => {
  test('a noted origin is immediately readable — synchronously', async () => {
    // The classifier's check runs inside a per-tool-call hot path and inside a
    // credential-scope getter; neither can await. If the durable write had to
    // land first, the signal would arrive a tool call late.
    const { store } = harness();
    await store.hydrate();
    expect(store.note('https://app.test', 'password-field')).toBe(true);
    expect(store.snapshot().get('https://app.test')).toBe('password-field');
  });

  test('the FIRST reason sticks', async () => {
    // The reason explains to a user why a site is treated as theirs. The first
    // observation is the one that actually changed the classification;
    // overwriting it would make the explanation drift from the decision.
    const { store } = harness();
    await store.hydrate();
    store.note('https://app.test', 'password-field');
    expect(store.note('https://app.test', 'confirmed-write')).toBe(false);
    expect(store.snapshot().get('https://app.test')).toBe('password-field');
  });

  test('onLearn fires once per origin, never on a repeat', async () => {
    const { store, learns } = harness();
    await store.hydrate();
    store.note('https://app.test', 'password-field');
    store.note('https://app.test', 'password-field');
    expect(learns).toEqual([['https://app.test', 'password-field']]);
  });

  test('an unknown reason is refused', async () => {
    // The reason is rendered to the user and is part of the audit trail; a value
    // the classifier does not know would surface as a site being special for no
    // stated cause.
    const { store } = harness();
    await store.hydrate();
    expect(store.note('https://app.test', 'vibes' as any)).toBe(false);
    expect(store.size()).toBe(0);
  });

  test('junk origins are refused rather than stored', async () => {
    const { store } = harness();
    await store.hydrate();
    for (const bad of [null, undefined, '', 123]) {
      expect(store.note(bad as any, 'password-field')).toBe(false);
    }
    expect(store.size()).toBe(0);
  });
});

describe('persistence', () => {
  test('a stored set is restored', async () => {
    const { store } = harness({ 'https://app.test': 'confirmed-write' });
    await store.hydrate();
    expect(store.snapshot().get('https://app.test')).toBe('confirmed-write');
  });

  test('a stored entry with an unknown reason is dropped on load', async () => {
    const { store } = harness({ 'https://app.test': 'nonsense' });
    await store.hydrate();
    expect(store.size()).toBe(0);
  });

  test('a load failure leaves the set EMPTY rather than throwing', async () => {
    // Fail-open, the same direction the classifier already documents: with no
    // notes to read, "nothing learned yet" is the only honest answer.
    const store = makeLearnedOrigins({
      load: async () => { throw new Error('idb down'); },
      save: async () => {},
      onError: () => {},
    });
    await store.hydrate();
    expect(store.size()).toBe(0);
    expect(store.note('https://app.test', 'password-field')).toBe(true);
  });

  test('a save failure keeps the heap state and does not reject', async () => {
    const store = makeLearnedOrigins({
      load: async () => null,
      save: async () => { throw new Error('quota'); },
      onError: () => {},
    });
    await store.hydrate();
    store.note('https://app.test', 'password-field');
    await store.settled();
    expect(store.snapshot().get('https://app.test')).toBe('password-field');
  });

  test('each save is the WHOLE set, so a partial write cannot lose an origin', async () => {
    const { store, saves } = harness();
    await store.hydrate();
    store.note('https://a.test', 'password-field');
    store.note('https://b.test', 'confirmed-write');
    await store.settled();
    expect(saves.at(-1)).toEqual({ 'https://a.test': 'password-field', 'https://b.test': 'confirmed-write' });
  });
});

describe('the cap', () => {
  test('stops LEARNING rather than evicting', async () => {
    // Eviction would silently downgrade an origin this store had already decided
    // was the user's — the one move it must never make. Refusing to learn keeps
    // the failure on the fail-open side the classifier accounts for.
    const { store } = harness();
    await store.hydrate();
    for (let i = 0; i < MAX_LEARNED; i += 1) store.note(`https://s${i}.test`, 'password-field');
    expect(store.size()).toBe(MAX_LEARNED);
    expect(store.note('https://one-too-many.test', 'password-field')).toBe(false);
    // The very first origin is still there — nothing was traded away for it.
    expect(store.snapshot().get('https://s0.test')).toBe('password-field');
    expect(store.size()).toBe(MAX_LEARNED);
  });
});
