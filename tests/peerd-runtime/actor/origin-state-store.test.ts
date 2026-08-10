// issue 251 — the origin state's plumbing. The rule is tested next door and the
// shell above it; this is the layer where a correct decision quietly stops
// mattering, because nothing wrote it down or two writers raced.

import { describe, test, expect } from 'bun:test';
import { makeOriginStateStore } from '../../../extension/peerd-runtime/actor/origin-state-store.js';
import { makeJudgeLanding } from '../../../extension/peerd-runtime/actor/origin-lock.js';

const harness = () => {
  const saves: Array<{ id: string; state: any }> = [];
  const store = makeOriginStateStore({
    save: async (id, state) => { saves.push({ id, state: { ...state } }); },
    onError: () => {},
  });
  return { store, saves };
};

describe('hydration', () => {
  test('an actor with no durable state starts ROAMING', () => {
    // The weaker mode: it holds no authority. An actor whose record predates the
    // field, or whose mint path forgot to set it, must start with less.
    const { store } = harness();
    store.hydrate('a', undefined);
    expect(store.read('a')).toEqual({ mode: 'roaming' } as any);
  });

  test('the durable state is adopted verbatim', () => {
    const { store } = harness();
    const authGrant = { returnTo: 'https://app.test', idpOrigin: 'https://idp.test', deadline: 99 };
    store.hydrate('a', { mode: 'bound', ownedOrigin: 'https://app.test', excursionsUsed: 2, authGrant } as any);
    expect(store.read('a')).toEqual({
      mode: 'bound', ownedOrigin: 'https://app.test', excursionsUsed: 2, authGrant,
    } as any);
  });

  test('a stored record with an UNRECOGNIZED mode is passed through, not repaired', () => {
    // decideLanding already ends an actor whose mode it does not recognize.
    // Quietly rewriting the mode here would BYPASS that guard — the store would
    // be making a policy decision, and the fail-closed branch would be dead code.
    const { store } = harness();
    store.hydrate('a', { ownedOrigin: 'https://app.test' } as any);
    expect(store.read('a')!.mode).toBeUndefined();
  });

  test('it is synchronous, so there is no window where the lock reads as absent', () => {
    // If hydration were async, the very first tool call of a turn could observe
    // read() === null — which the shell treats as NO LOCK. That is the one call
    // most likely to be the one that matters.
    const { store } = harness();
    store.hydrate('a', { mode: 'bound', ownedOrigin: 'https://app.test' } as any);
    expect(store.read('a')!.mode).toBe('bound');
  });

  test('the cache WINS over a later re-seed with a staler record', async () => {
    // Verdicts write the cache; the record catches up. A re-seed that overwrote
    // the cache would roll back a decision already acted on — e.g. restoring a
    // spent excursion budget on the next context build.
    const { store } = harness();
    store.hydrate('a', { mode: 'bound', ownedOrigin: null } as any);
    await store.write('a', { ownedOrigin: 'https://app.test' });
    store.hydrate('a', { mode: 'bound', ownedOrigin: null } as any);   // stale record
    expect(store.read('a')!.ownedOrigin).toBe('https://app.test');
  });

  test('two callers hydrating the same actor share ONE object', () => {
    // Two cached copies would silently split the state: a write through one
    // would be invisible to the judge reading the other.
    const { store } = harness();
    store.hydrate('a', { mode: 'roaming' } as any);
    store.hydrate('a', { mode: 'roaming' } as any);
    expect(store.read('a')).toBe(store.read('a'));
  });

  test('a bound actor is NEVER silently demoted to roaming', () => {
    // The failure this replaces: the store used to load the record itself, and a
    // load that threw fell back to the roaming seed. For the credential scope
    // that is a WIDENING — bound may spend its session on one origin, roaming on
    // any non-sensitive one — which is the wrong direction for an error path.
    // With the caller supplying the record there is no such path at all.
    const { store } = harness();
    store.hydrate('a', { mode: 'bound', ownedOrigin: 'https://app.test' } as any);
    expect(store.read('a')!.mode).toBe('bound');
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
  test('a roaming retirement is durable and survives a fresh store hydrate', async () => {
    const { store, saves } = harness();
    store.hydrate('a', { mode: 'roaming' } as any);
    await store.write('a', { retired: true });
    expect(saves.at(-1)).toEqual({ id: 'a', state: { mode: 'roaming', retired: true } });

    const restarted = makeOriginStateStore({ save: async () => {}, onError: () => {} });
    restarted.hydrate('a', saves.at(-1)!.state);
    expect(restarted.read('a')).toMatchObject({ mode: 'roaming', retired: true });
  });

  test('authority is published to the cache only after the durable write resolves', async () => {
    let release = () => {};
    const store = makeOriginStateStore({
      save: () => new Promise((resolve) => { release = resolve; }),
      onError: () => {},
    });
    store.hydrate('a', { mode: 'bound', ownedOrigin: null } as any);
    const pending = store.write('a', { ownedOrigin: 'https://app.test' });
    await Promise.resolve();
    expect(store.read('a')!.ownedOrigin).toBe(null);
    release();
    await pending;
    expect(store.read('a')!.ownedOrigin).toBe('https://app.test');
  });

  test('a no-op patch does not touch storage', async () => {
    // The common verdict is "continue, nothing changed", whose patch is
    // { excursion: null } over a state that has no excursion. Persisting that
    // would put an IDB write on every single DOM tool call.
    const { store, saves } = harness();
    store.hydrate('a', { mode: 'roaming' } as any);
    await store.write('a', { excursion: null });
    await store.write('a', { excursion: null });
    await store.settled();
    expect(saves).toEqual([]);
  });

  test('a real change IS persisted, as the whole state', async () => {
    const { store, saves } = harness();
    store.hydrate('a', { mode: 'bound', ownedOrigin: null } as any);
    await store.write('a', { ownedOrigin: 'https://app.test' });
    await store.settled();
    expect(saves).toHaveLength(1);
    expect(saves[0]!.state).toEqual({ mode: 'bound', ownedOrigin: 'https://app.test' } as any);
  });

  test('an excursion is compared structurally, not by reference', async () => {
    const excursion = { returnTo: 'https://app.test', idpOrigin: 'https://idp.test', deadline: 99, authorized: true as const };
    const { store, saves } = harness();
    store.hydrate('a', { mode: 'bound', ownedOrigin: 'https://app.test', excursion } as any);
    await store.write('a', { excursion: { ...excursion } });         // same values, new object
    await store.settled();
    expect(saves).toEqual([]);
    await store.write('a', { excursion: { ...excursion, deadline: 100 } });
    await store.settled();
    expect(saves).toHaveLength(1);
  });

  test('an auth grant is compared structurally and survives restart hydration', async () => {
    const authGrant = { returnTo: 'https://app.test', idpOrigin: 'https://idp.test', deadline: 99 };
    const { store, saves } = harness();
    store.hydrate('a', { mode: 'bound', ownedOrigin: 'https://app.test', authGrant } as any);
    await store.write('a', { authGrant: { ...authGrant } });
    expect(saves).toEqual([]);
    await store.write('a', { authGrant: { ...authGrant, deadline: 100 } });
    await store.settled();
    expect(saves).toHaveLength(1);

    const restarted = makeOriginStateStore({ save: async () => {}, onError: () => {} });
    restarted.hydrate('a', saves[0]!.state);
    expect(restarted.read('a')!.authGrant).toEqual({ ...authGrant, deadline: 100 });
  });

  test('concurrent writes do not lose an increment', async () => {
    // The tool loop runs READ-class calls concurrently (partitionToolBatch), and
    // every DOM tool judges its landing. Two judges read-modify-writing the same
    // actor is not hypothetical — and the field at risk is the excursion LIFETIME
    // CAP, whose whole job is to be un-refreshable.
    const { store, saves } = harness();
    store.hydrate('a', { mode: 'bound', ownedOrigin: 'https://app.test', excursionsUsed: 0 } as any);
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

  test('a save that throws rejects and leaves the heap state unchanged', async () => {
    const store = makeOriginStateStore({
      save: async () => { throw new Error('quota'); },
      onError: () => {},
    });
    store.hydrate('a', { mode: 'bound', ownedOrigin: null } as any);
    await expect(store.write('a', { ownedOrigin: 'https://app.test' })).rejects.toThrow('origin_state_persistence_failed');
    await store.settled();
    expect(store.read('a')!.ownedOrigin).toBe(null);
  });

  test('one failed save does not poison later ones', async () => {
    // The chain is shared across every actor. If a rejection propagated, one
    // actor's storage error would silently stop persisting for all of them.
    let calls = 0;
    const saved: any[] = [];
    const store = makeOriginStateStore({
      save: async (_id, state) => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        saved.push({ ...state });
      },
      onError: () => {},
    });
    store.hydrate('a', { mode: 'bound', ownedOrigin: null } as any);
    await expect(store.write('a', { ownedOrigin: 'https://one.test' })).rejects.toThrow('origin_state_persistence_failed');
    await store.write('a', { ownedOrigin: 'https://two.test' });
    await store.settled();
    expect(saved).toHaveLength(1);
    expect(saved[0].ownedOrigin).toBe('https://two.test');
  });
});

describe('serialized authority decisions', () => {
  const judgeFor = (store: ReturnType<typeof makeOriginStateStore>) => makeJudgeLanding({
    getState: () => store.read('a'),
    saveState: (patch) => store.write('a', patch),
    onStop: () => {},
    isIdp: (url) => new URL(url).origin === 'https://idp.test',
    now: () => 1_000,
  });

  test('a queued consume cannot resurrect a grant cleared by its predecessor', async () => {
    const { store } = harness();
    store.hydrate('a', {
      mode: 'bound', ownedOrigin: 'https://app.test', excursionsUsed: 0,
      authGrant: { returnTo: 'https://app.test', idpOrigin: 'https://idp.test', deadline: 9_000 },
    } as any);
    const judge = judgeFor(store);
    const clear = store.serialize('a', () => store.write('a', { authGrant: null }));
    const staleConsume = store.serialize('a', () => judge('https://idp.test/login'));
    await Promise.all([clear, staleConsume]);
    expect(store.read('a')!.authGrant).toBeNull();
    expect(store.read('a')!.excursion ?? null).toBeNull();
  });

  test('a later wait cannot overwrite a home discharge', async () => {
    const { store } = harness();
    store.hydrate('a', {
      mode: 'bound', ownedOrigin: 'https://app.test', excursionsUsed: 1,
      excursion: {
        returnTo: 'https://app.test', idpOrigin: 'https://idp.test', deadline: 9_000, authorized: true,
      },
    } as any);
    const judge = judgeFor(store);
    await Promise.all([
      store.serialize('a', () => judge('https://app.test/home')),
      store.serialize('a', () => judge('https://idp.test/login')),
    ]);
    expect(store.read('a')!.excursion ?? null).toBeNull();
  });

  test('an already-running old judge cannot stop a newly stamped turn', async () => {
    let releaseSave = () => {};
    let saveStarted = () => {};
    const started = new Promise<void>((resolve) => { saveStarted = resolve; });
    const store = makeOriginStateStore({
      save: () => new Promise<void>((resolve) => {
        releaseSave = resolve;
        saveStarted();
      }),
      onError: () => {},
    });
    store.hydrate('a', {
      mode: 'bound', ownedOrigin: 'https://app.test',
      excursion: {
        returnTo: 'https://app.test', idpOrigin: 'https://idp.test', deadline: 9_000, authorized: true,
      },
    } as any);
    let turnToken = 1;
    const oldToken = turnToken;
    const stops: any[] = [];
    const oldJudge = makeJudgeLanding({
      getState: () => store.read('a'),
      saveState: (patch) => store.write('a', patch),
      onStop: (event) => { stops.push(event); },
      isCurrent: () => turnToken === oldToken,
      now: () => 1_000,
    });

    const oldDecision = store.serialize('a', () => oldJudge('https://elsewhere.test'));
    await started;
    // This mirrors runActorTurn: stamp T2 before awaiting the policy lane.
    turnToken = 2;
    const newTurnBarrier = store.serialize('a', () => undefined);
    releaseSave();
    await Promise.all([oldDecision, newTurnBarrier]);

    expect(stops).toEqual([]);
  });
});

describe('forget', () => {
  test('drops the cache, so the next read is unlocked again', async () => {
    const { store } = harness();
    store.hydrate('a', { mode: 'roaming' } as any);
    store.forget('a');
    expect(store.read('a')).toBeNull();
    expect(store.isHydrated('a')).toBe(false);
  });
});
