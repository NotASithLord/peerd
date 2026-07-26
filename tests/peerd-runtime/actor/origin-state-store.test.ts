// issue 251 — the origin state's plumbing. The rule is tested next door and the
// shell above it; this is the layer where a correct decision quietly stops
// mattering, because nothing wrote it down or two writers raced.

import { describe, test, expect } from 'bun:test';
import { makeOriginStateStore } from '../../../extension/peerd-runtime/actor/origin-state-store.js';

const harness = (stored: Record<string, any> = {}) => {
  const saves: Array<{ id: string; state: any }> = [];
  const loads: string[] = [];
  const store = makeOriginStateStore({
    load: async (id) => {
      loads.push(id);
      // A real await, so a second caller arriving mid-load exercises the
      // in-flight-share path rather than a synchronously-resolved cache.
      await Promise.resolve();
      return stored[id] ?? null;
    },
    save: async (id, state) => { saves.push({ id, state: { ...state } }); },
    onError: () => {},
  });
  return { store, saves, loads };
};

describe('hydration', () => {
  test('the seed is used when nothing is stored', async () => {
    const { store } = harness();
    await store.hydrate('a', { mode: 'roaming' } as any);
    expect(store.read('a')).toEqual({ mode: 'roaming' } as any);
  });

  test('a stored state wins over the seed', async () => {
    const { store } = harness({ a: { mode: 'bound', ownedOrigin: 'https://app.test', excursionsUsed: 2 } });
    await store.hydrate('a', { mode: 'roaming' } as any);
    expect(store.read('a')).toEqual({ mode: 'bound', ownedOrigin: 'https://app.test', excursionsUsed: 2 } as any);
  });

  test('a stored record with NO mode falls back to the seed mode', async () => {
    // decideLanding fails closed on an unrecognized mode, so a record written
    // before the field existed would END every actor rather than merely forget a
    // budget. The seed is what keeps an upgrade from looking like an attack.
    const { store } = harness({ a: { ownedOrigin: 'https://app.test' } });
    await store.hydrate('a', { mode: 'roaming' } as any);
    expect(store.read('a')!.mode).toBe('roaming');
  });

  test('loads once, even when two callers race a cold cache', async () => {
    const { store, loads } = harness({ a: { mode: 'bound' } });
    await Promise.all([
      store.hydrate('a', { mode: 'roaming' } as any),
      store.hydrate('a', { mode: 'roaming' } as any),
      store.hydrate('a', { mode: 'roaming' } as any),
    ]);
    expect(loads).toEqual(['a']);
    // …and both callers see the SAME object, so a write through one is visible
    // through the other. Two cached copies would silently split the state.
    expect(store.read('a')).toBe(store.read('a'));
  });

  test('a load that throws still yields a usable seeded state', async () => {
    const store = makeOriginStateStore({
      load: async () => { throw new Error('idb is having a day'); },
      save: async () => {},
      onError: () => {},
    });
    await store.hydrate('a', { mode: 'roaming' } as any);
    expect(store.read('a')!.mode).toBe('roaming');
  });
});

describe('the sync read is the lock\'s contract', () => {
  test('un-hydrated reads as null — which the shell treats as NO LOCK', async () => {
    // This is why the SW hydrates at context-build time rather than lazily at
    // judge time: the failure mode of forgetting is silent absence of the lock.
    const { store } = harness();
    expect(store.read('never-seen')).toBeNull();
  });
});

describe('writes', () => {
  test('the cache updates BEFORE the durable write resolves', async () => {
    const { store } = harness();
    await store.hydrate('a', { mode: 'bound', ownedOrigin: null } as any);
    const pending = store.write('a', { ownedOrigin: 'https://app.test' });
    // Not awaited: the next sync getState must already see it, because the very
    // next tool call may judge against it.
    expect(store.read('a')!.ownedOrigin).toBe('https://app.test');
    await pending;
  });

  test('a no-op patch does not touch storage', async () => {
    // The common verdict is "continue, nothing changed", whose patch is
    // { excursion: null } over a state that has no excursion. Persisting that
    // would put an IDB write on every single DOM tool call.
    const { store, saves } = harness();
    await store.hydrate('a', { mode: 'roaming' } as any);
    await store.write('a', { excursion: null });
    await store.write('a', { excursion: null });
    await store.settled();
    expect(saves).toEqual([]);
  });

  test('a real change IS persisted, as the whole state', async () => {
    const { store, saves } = harness();
    await store.hydrate('a', { mode: 'bound', ownedOrigin: null } as any);
    await store.write('a', { ownedOrigin: 'https://app.test' });
    await store.settled();
    expect(saves).toHaveLength(1);
    expect(saves[0]!.state).toEqual({ mode: 'bound', ownedOrigin: 'https://app.test' } as any);
  });

  test('an excursion is compared structurally, not by reference', async () => {
    const excursion = { returnTo: 'https://app.test', openedAt: 'https://idp.test', lastLanding: 'https://idp.test', budget: 3, deadline: 99 };
    const { store, saves } = harness();
    await store.hydrate('a', { mode: 'bound', ownedOrigin: 'https://app.test', excursion } as any);
    await store.write('a', { excursion: { ...excursion } });         // same values, new object
    await store.settled();
    expect(saves).toEqual([]);
    await store.write('a', { excursion: { ...excursion, budget: 2 } });  // budget actually spent
    await store.settled();
    expect(saves).toHaveLength(1);
  });

  test('concurrent writes do not lose an increment', async () => {
    // The tool loop runs READ-class calls concurrently (partitionToolBatch), and
    // every DOM tool judges its landing. Two judges read-modify-writing the same
    // actor is not hypothetical — and the field at risk is the excursion LIFETIME
    // CAP, whose whole job is to be un-refreshable.
    const { store, saves } = harness();
    await store.hydrate('a', { mode: 'bound', ownedOrigin: 'https://app.test', excursionsUsed: 0 } as any);
    await Promise.all([
      store.write('a', { excursionsUsed: 1 }),
      store.write('a', { ownedOrigin: 'https://app.test/x' }),
      store.write('a', { excursionsUsed: 2 }),
    ]);
    await store.settled();
    // Every durable write saw the previous one's result: the last snapshot is the
    // fully-merged state, not one writer's partial view.
    expect(saves.at(-1)!.state.excursionsUsed).toBe(2);
    expect(saves.at(-1)!.state.ownedOrigin).toBe('https://app.test/x');
    expect(store.read('a')!.excursionsUsed).toBe(2);
  });

  test('a write for an un-hydrated actor is dropped, never invented', async () => {
    // Merging a patch into nothing would MINT a state — i.e. lock an actor the
    // SW never decided to lock, on the strength of a stray call.
    const { store, saves } = harness();
    await store.write('ghost', { ownedOrigin: 'https://evil.test' });
    await store.settled();
    expect(saves).toEqual([]);
    expect(store.read('ghost')).toBeNull();
  });

  test('a save that throws leaves the heap state correct and does not reject', async () => {
    const store = makeOriginStateStore({
      load: async () => null,
      save: async () => { throw new Error('quota'); },
      onError: () => {},
    });
    await store.hydrate('a', { mode: 'bound', ownedOrigin: null } as any);
    await store.write('a', { ownedOrigin: 'https://app.test' });
    await store.settled();
    expect(store.read('a')!.ownedOrigin).toBe('https://app.test');
  });

  test('one failed save does not poison later ones', async () => {
    // The chain is shared across every actor. If a rejection propagated, one
    // actor's storage error would silently stop persisting for all of them.
    let calls = 0;
    const saved: any[] = [];
    const store = makeOriginStateStore({
      load: async () => null,
      save: async (_id, state) => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        saved.push({ ...state });
      },
      onError: () => {},
    });
    await store.hydrate('a', { mode: 'bound', ownedOrigin: null } as any);
    await store.write('a', { ownedOrigin: 'https://one.test' });
    await store.write('a', { ownedOrigin: 'https://two.test' });
    await store.settled();
    expect(saved).toHaveLength(1);
    expect(saved[0].ownedOrigin).toBe('https://two.test');
  });
});

describe('forget', () => {
  test('drops the cache, so the next read is unlocked again', async () => {
    const { store } = harness();
    await store.hydrate('a', { mode: 'roaming' } as any);
    store.forget('a');
    expect(store.read('a')).toBeNull();
    expect(store.isHydrated('a')).toBe(false);
  });
});
