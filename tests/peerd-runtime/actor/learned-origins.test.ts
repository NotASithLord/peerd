// issue 251 — the half of the classifier that grows with use.
//
// The invariant worth guarding: no AUTOMATIC path here makes an origin ordinary
// again, because a false positive costs a handoff while a false negative costs a
// roaming actor loose on a site the user is logged into. Hence the cap refuses to
// learn rather than evicting, and nothing decays.
//
// `forget`/`clear` are the deliberate exception, and the tests below pin what
// makes them safe: they are USER-initiated (settings-only routes, unreachable
// from the tool dispatcher), and a removal that races the boot read must WIN
// rather than being resurrected by storage.

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
    expect(store.snapshot().get('app.test')).toBe('password-field');
  });

  test('the FIRST reason sticks', async () => {
    // The reason explains to a user why a site is treated as theirs. The first
    // observation is the one that actually changed the classification;
    // overwriting it would make the explanation drift from the decision.
    const { store } = harness();
    await store.hydrate();
    store.note('https://app.test', 'password-field');
    expect(store.note('https://app.test', 'confirmed-write')).toBe(false);
    expect(store.snapshot().get('app.test')).toBe('password-field');
  });

  test('onLearn fires once per origin, never on a repeat', async () => {
    const { store, learns } = harness();
    await store.hydrate();
    store.note('https://app.test', 'password-field');
    store.note('https://app.test', 'password-field');
    expect(learns).toEqual([['app.test', 'password-field']]);
  });

  test('scheme and port variants share one host record and one audit event', async () => {
    const { store, learns } = harness();
    await store.hydrate();
    expect(store.note('https://app.test:8443', 'password-field')).toBe(true);
    expect(store.note('http://app.test:8080', 'confirmed-write')).toBe(false);
    expect(store.note('app.test', 'confirmed-write')).toBe(false);
    expect(store.entries()).toEqual([{ host: 'app.test', reason: 'password-field' }]);
    expect(learns).toEqual([['app.test', 'password-field']]);
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
    expect(store.snapshot().get('app.test')).toBe('confirmed-write');
    expect(store.hydrationStatus()).toEqual({ ready: true, ok: true });
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
    expect(store.hydrationStatus()).toEqual({ ready: true, ok: false });
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
    expect(store.snapshot().get('app.test')).toBe('password-field');
  });

  test('each save is the WHOLE set, so a partial write cannot lose an origin', async () => {
    const { store, saves } = harness();
    await store.hydrate();
    store.note('https://a.test', 'password-field');
    store.note('https://b.test', 'confirmed-write');
    await store.settled();
    expect(saves.at(-1)).toEqual({ 'a.test': 'password-field', 'b.test': 'confirmed-write' });
  });

  test('legacy origin keys migrate and duplicate ports collapse on hydrate', async () => {
    const { store, saves } = harness({
      'https://app.test:8443': 'password-field',
      'http://app.test:8080': 'confirmed-write',
      'https://other.test': 'confirmed-write',
    });
    await store.hydrate();
    await store.settled();
    expect(store.entries()).toEqual([
      { host: 'app.test', reason: 'password-field' },
      { host: 'other.test', reason: 'confirmed-write' },
    ]);
    expect(saves.at(-1)).toEqual({
      'app.test': 'password-field',
      'other.test': 'confirmed-write',
    });
  });

  test('oversized durable state is capped and compacted on hydrate', async () => {
    const stored = Object.fromEntries(Array.from(
      { length: MAX_LEARNED + 25 },
      (_, index) => [`stored-${index}.test`, 'password-field'],
    ));
    const { store, saves } = harness(stored);
    await store.hydrate();
    await store.settled();
    expect(store.size()).toBe(MAX_LEARNED);
    expect(Object.keys(saves.at(-1) ?? {})).toHaveLength(MAX_LEARNED);
    expect(saves.at(-1)?.['stored-0.test']).toBe('password-field');
    expect(saves.at(-1)?.[`stored-${MAX_LEARNED}.test`]).toBeUndefined();
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
    expect(store.snapshot().get('s0.test')).toBe('password-field');
    expect(store.size()).toBe(MAX_LEARNED);
  });

  test('port spelling cannot fill the cap', async () => {
    const { store } = harness();
    await store.hydrate();
    for (let port = 1; port <= MAX_LEARNED; port += 1) {
      store.note(`https://same.test:${port}`, 'password-field');
    }
    expect(store.size()).toBe(1);
    expect(store.note('https://another.test', 'password-field')).toBe(true);
  });
});

describe('the boot read races the first page walk', () => {
  test('a signal noted DURING hydration is not lost, and does not lose the stored set', async () => {
    // The load is async; the first DOM walk is not. An earlier draft let note()
    // fire mid-load and save a snapshot of a nearly-empty Map — clobbering the
    // durable set the read was about to deliver.
    let releaseLoad: (v: any) => void = () => {};
    const gate = new Promise((r) => { releaseLoad = r; });
    const saves: Array<Record<string, string>> = [];
    const store = makeLearnedOrigins({
      load: async () => { await gate; return { 'https://stored.test': 'confirmed-write' }; },
      save: async (all) => { saves.push({ ...all }); },
      onError: () => {},
    });
    const hydrating = store.hydrate();
    store.note('https://live.test', 'password-field');   // lands mid-load
    releaseLoad(null);
    await hydrating;
    await store.settled();
    // Both survive.
    expect(store.snapshot().get('live.test')).toBe('password-field');
    expect(store.snapshot().get('stored.test')).toBe('confirmed-write');
    // And the LAST durable write holds both, not the racing writer's view.
    expect(saves.at(-1)).toEqual({
      'live.test': 'password-field',
      'stored.test': 'confirmed-write',
    });
  });

  test('a live observation WINS over a stale stored reason for the same origin', async () => {
    let releaseLoad: (v: any) => void = () => {};
    const gate = new Promise((r) => { releaseLoad = r; });
    const store = makeLearnedOrigins({
      load: async () => { await gate; return { 'https://x.test': 'confirmed-write' }; },
      save: async () => {},
      onError: () => {},
    });
    const hydrating = store.hydrate();
    store.note('https://x.test', 'password-field');
    releaseLoad(null);
    await hydrating;
    expect(store.snapshot().get('x.test')).toBe('password-field');
  });

  test('live observations survive when stored entries fill the remaining cap', async () => {
    const stored = Object.fromEntries(Array.from(
      { length: MAX_LEARNED },
      (_, index) => [`stored-${index}.test`, 'confirmed-write'],
    ));
    let releaseLoad: (value: Record<string, string>) => void = () => {};
    const loadGate = new Promise<Record<string, string>>((resolve) => { releaseLoad = resolve; });
    const saves: Array<Record<string, string>> = [];
    const store = makeLearnedOrigins({
      load: async () => loadGate,
      save: async (all) => { saves.push({ ...all }); },
      onError: () => {},
    });
    const hydrating = store.hydrate();
    expect(store.note('https://live-a.test', 'password-field')).toBe(true);
    expect(store.note('https://live-b.test', 'confirmed-write')).toBe(true);
    releaseLoad(stored);
    await hydrating;
    await store.settled();
    expect(store.size()).toBe(MAX_LEARNED);
    expect(store.snapshot().get('live-a.test')).toBe('password-field');
    expect(store.snapshot().get('live-b.test')).toBe('confirmed-write');
    expect(Object.keys(saves.at(-1) ?? {})).toHaveLength(MAX_LEARNED);
    expect(saves.at(-1)?.['live-a.test']).toBe('password-field');
    expect(saves.at(-1)?.['live-b.test']).toBe('confirmed-write');
  });
});

describe('un-learning (user-initiated only)', () => {
  const forgetHarness = (stored: Record<string, string> | null = null) => {
    const saves: Array<Record<string, string>> = [];
    const forgets: string[][] = [];
    const store = makeLearnedOrigins({
      load: async () => stored,
      save: async (all) => { saves.push({ ...all }); },
      onForget: (origins) => { forgets.push([...origins]); },
      onError: () => {},
    });
    return { store, saves, forgets };
  };

  test('forget removes the origin from the synchronous read the classifier uses', async () => {
    const { store } = forgetHarness();
    await store.hydrate();
    store.note('https://app.test', 'password-field');
    expect(store.forget('https://app.test')).toBe(true);
    expect(store.snapshot().has('app.test')).toBe(false);
  });

  test('forget accepts another scheme and port spelling of the learned host', async () => {
    const { store, forgets } = forgetHarness({ 'https://app.test:8443': 'password-field' });
    await store.hydrate();
    expect(store.forget('http://app.test:8080/path')).toBe(true);
    expect(store.size()).toBe(0);
    expect(forgets).toEqual([['app.test']]);
  });

  test('forget persists — the removal survives the next boot read', async () => {
    const { store, saves } = forgetHarness({ 'https://app.test': 'password-field' });
    await store.hydrate();
    store.forget('https://app.test');
    await store.settled();
    expect(saves.at(-1)).toEqual({});
  });

  test('forget reports whether it did anything, and is audited once', async () => {
    const { store, forgets } = forgetHarness({ 'https://app.test': 'password-field' });
    await store.hydrate();
    expect(store.forget('https://nope.test')).toBe(false);  // never learned
    expect(store.forget('https://app.test')).toBe(true);
    expect(store.forget('https://app.test')).toBe(false);   // already gone
    expect(forgets).toEqual([['app.test']]);
  });

  test('forget ignores junk rather than throwing', async () => {
    const { store } = forgetHarness();
    await store.hydrate();
    expect(store.forget('')).toBe(false);
    expect(store.forget(null)).toBe(false);
    expect(store.forget(undefined)).toBe(false);
  });

  test('clear empties the set and returns how many it forgot', async () => {
    const { store, forgets } = forgetHarness({
      'https://a.test': 'password-field',
      'https://b.test': 'confirmed-write',
    });
    await store.hydrate();
    expect(store.clear()).toBe(2);
    expect(store.size()).toBe(0);
    expect(store.clear()).toBe(0);                 // idempotent
    expect(forgets).toEqual([['a.test', 'b.test']]);
  });

  // THE RACE THAT MATTERS. hydrate() MERGES (it must, so a signal landing during
  // the boot read is not lost) - so without tombstones a forget issued before the
  // read lands is undone by the very next line of storage, and the user watches a
  // row they deleted come back.
  test('a forget that races the boot read WINS over what storage brings back', async () => {
    let releaseLoad: (v: any) => void = () => {};
    const gate = new Promise((r) => { releaseLoad = r; });
    const store = makeLearnedOrigins({
      load: async () => { await gate; return { 'https://x.test': 'password-field' }; },
      save: async () => {},
      onError: () => {},
    });
    const hydrating = store.hydrate();
    store.note('https://x.test', 'password-field');
    expect(store.forget('https://x.test')).toBe(true);
    releaseLoad(null);
    await hydrating;
    expect(store.snapshot().has('x.test')).toBe(false);
  });

  test('a clear that races the boot read also suppresses rows this heap never saw', async () => {
    let releaseLoad: (v: any) => void = () => {};
    const gate = new Promise((r) => { releaseLoad = r; });
    const store = makeLearnedOrigins({
      load: async () => { await gate; return { 'https://unseen.test': 'password-field' }; },
      save: async () => {},
      onError: () => {},
    });
    const hydrating = store.hydrate();
    store.note('https://seen.test', 'password-field');
    store.clear();
    releaseLoad(null);
    await hydrating;
    expect(store.size()).toBe(0);
  });

  test('after hydrate settles, a later learn is kept normally (tombstones do not linger)', async () => {
    const { store } = forgetHarness({ 'https://app.test': 'password-field' });
    await store.hydrate();
    store.forget('https://app.test');
    // Re-learning is expected: the signal fires again next time peerd reads a
    // sign-in form there. A lingering tombstone would silently refuse it.
    expect(store.note('https://app.test', 'password-field')).toBe(true);
    expect(store.snapshot().get('app.test')).toBe('password-field');
  });
});

describe('entries (the settings list)', () => {
  test('returns a sorted, serializable COPY — not the live Map', async () => {
    const store = makeLearnedOrigins({
      load: async () => ({ 'https://b.test': 'password-field', 'https://a.test': 'confirmed-write' }),
      save: async () => {},
      onError: () => {},
    });
    await store.hydrate();
    expect(store.entries()).toEqual([
      { host: 'a.test', reason: 'confirmed-write' },
      { host: 'b.test', reason: 'password-field' },
    ]);
    // Mutating the returned array must not touch the classifier's own state:
    // this value crosses a message boundary to the settings page.
    store.entries().length = 0;
    expect(store.size()).toBe(2);
  });
});
