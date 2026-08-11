import { describe, test, expect } from 'bun:test';
import { makeLearnedOriginRoutes } from '../../extension/background/routes/learned-origins.js';

// The settings view of the learned host set, and the only un-learn path. What
// these pin: the host is CANONICALIZED with the same normalizer `note` uses (a
// mismatch would silently no-op and read as a broken button), a removal is not
// reported until it is durable, and the routes never audit themselves (the
// store's onForget hook owns that, or every removal is recorded twice).

const makeDeps = (learned: Record<string, string> = {}, over: any = {}) => {
  const map = new Map(Object.entries(learned));
  const settledCalls: number[] = [];
  const deps = {
    learnedOrigins: {
      // The routes gate every handler on hydration (see the cold-worker tests
      // at the bottom); a stand-in that omits it is not the real interface.
      hydrate: async () => {},
      entries: () => [...map.entries()]
        .map(([host, reason]) => ({ host, reason }))
        .sort((a, b) => a.host.localeCompare(b.host)),
      forget: (o: string) => map.delete(o),
      clear: () => { const n = map.size; map.clear(); return n; },
      settled: async () => { settledCalls.push(map.size); },
      ...over.learnedOrigins,
    },
    // Stands in for the SW's normalizeApiOrigin: canonical origin or null.
    normalizeApiOrigin: (raw: unknown) => {
      if (typeof raw !== 'string' || !raw) return null;
      try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin; } catch { return null; }
    },
    ...over,
  };
  return { deps, map, settledCalls };
};

describe('learned/list', () => {
  test('returns the sorted set', async () => {
    const { deps } = makeDeps({ 'b.test': 'password-field', 'a.test': 'confirmed-write' });
    expect(await makeLearnedOriginRoutes(deps)['learned/list']()).toEqual({
      ok: true,
      origins: [
        { host: 'a.test', reason: 'confirmed-write' },
        { host: 'b.test', reason: 'password-field' },
      ],
    });
  });

  test('an empty set is a successful empty list, not an error', async () => {
    const { deps } = makeDeps();
    expect(await makeLearnedOriginRoutes(deps)['learned/list']()).toEqual({ ok: true, origins: [] });
  });
});

describe('learned/forget', () => {
  test('canonicalizes the origin before deleting', async () => {
    // The UI renders `app.test`; a caller passing an old origin-shaped value
    // must still hit the same host key the classifier looks up.
    const { deps, map } = makeDeps({ 'app.test': 'password-field' });
    const r = await makeLearnedOriginRoutes(deps)['learned/forget']({ host: 'https://app.test:8443/login?x=1' });
    expect(r.ok).toBe(true);
    expect(map.has('app.test')).toBe(false);
  });

  test('refuses a non-origin instead of no-oping silently', async () => {
    const { deps } = makeDeps({ 'app.test': 'password-field' });
    for (const bad of ['', 'not a url', null, undefined, 42]) {
      expect(await makeLearnedOriginRoutes(deps)['learned/forget']({ host: bad }))
        .toEqual({ ok: false, error: 'invalid-origin' });
    }
  });

  test('reports not-learned for an origin that was never in the set', async () => {
    const { deps } = makeDeps({ 'app.test': 'password-field' });
    expect(await makeLearnedOriginRoutes(deps)['learned/forget']({ host: 'other.test' }))
      .toEqual({ ok: false, error: 'not-learned' });
  });

  test('waits for the durable write before replying', async () => {
    // The caller re-renders from this reply. Replying early would show a row gone
    // that a mid-flight service-worker eviction could still bring back.
    const order: string[] = [];
    const { deps } = makeDeps({ 'app.test': 'password-field' }, {
      learnedOrigins: {
        hydrate: async () => { order.push('hydrate'); },
        entries: () => { order.push('entries'); return []; },
        forget: () => { order.push('forget'); return true; },
        clear: () => 0,
        settled: async () => { order.push('settled'); },
      },
    });
    await makeLearnedOriginRoutes(deps)['learned/forget']({ host: 'app.test' });
    expect(order).toEqual(['hydrate', 'forget', 'settled', 'entries']);
  });

  test('does not audit — the store hook owns that, so a removal is recorded once', async () => {
    const audits: any[] = [];
    const { deps } = makeDeps({ 'app.test': 'password-field' }, {
      auditLog: { append: async (e: any) => { audits.push(e); } },
    });
    await makeLearnedOriginRoutes(deps)['learned/forget']({ host: 'app.test' });
    expect(audits).toEqual([]);
  });
});

describe('learned/clear', () => {
  test('empties the set and reports how many it forgot', async () => {
    const { deps, map } = makeDeps({ 'a.test': 'password-field', 'b.test': 'confirmed-write' });
    const r = await makeLearnedOriginRoutes(deps)['learned/clear']();
    expect(r).toEqual({ ok: true, origins: [], forgotten: 2 });
    expect(map.size).toBe(0);
  });

  test('clearing an empty set succeeds with a zero count', async () => {
    // why not an error: the UI shows this as an outcome ("cleared"), and a set
    // that was already empty is the requested end state, not a failure.
    const { deps } = makeDeps();
    expect(await makeLearnedOriginRoutes(deps)['learned/clear']())
      .toEqual({ ok: true, origins: [], forgotten: 0 });
  });
});

// ── the cold-service-worker gate ────────────────────────────────────────────
//
// These use the REAL store, not a stand-in, because the bug they pin lived in the
// seam BETWEEN them: the SW kicks learnedOrigins.hydrate() at boot without
// awaiting it, and a settings message is exactly what wakes a cold worker. Before
// the routes awaited hydration, `learned/list` reported an empty list for a
// profile full of learned hosts and `learned/clear` reported success while
// forgetting nothing — the boot read then restored everything.
import { makeLearnedOrigins } from '../../extension/peerd-runtime/actor/learned-origins.js';

const coldStore = (stored: Record<string, string>) => {
  let release: (v: unknown) => void = () => {};
  const gate = new Promise((r) => { release = r; });
  const saves: Array<Record<string, string>> = [];
  let loads = 0;
  const store = makeLearnedOrigins({
    load: async () => { loads += 1; await gate; return stored; },
    save: async (all) => { saves.push({ ...all }); },
    onError: () => {},
  });
  // Exactly what the SW does at boot: kick it, never await it.
  const booting = store.hydrate();
  return { store, saves, release, booting, loads: () => loads };
};

const routesFor = (store: any) => makeLearnedOriginRoutes({
  learnedOrigins: store,
  normalizeApiOrigin: (raw: unknown) => {
    if (typeof raw !== 'string' || !raw) return null;
    try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).origin; } catch { return null; }
  },
});

describe('routes wait for the durable set', () => {
  test('learned/list does not report an empty list while the boot read is in flight', async () => {
    const { store, release } = coldStore({ 'https://a.test': 'password-field' });
    const pending = routesFor(store)['learned/list']();
    release(null);
    expect(await pending).toEqual({ ok: true, origins: [{ host: 'a.test', reason: 'password-field' }] });
  });

  test('learned/clear on a cold worker forgets what is really there, and says how many', async () => {
    // The failure this replaces: ok:true, forgotten:0, no durable write, and
    // hydration then restored all of it.
    const { store, saves, release, booting } = coldStore({
      'https://a.test': 'password-field',
      'https://b.test': 'confirmed-write',
    });
    const pending = routesFor(store)['learned/clear']();
    release(null);
    expect(await pending).toEqual({ ok: true, origins: [], forgotten: 2 });
    await booting;
    await store.settled();
    expect(store.size()).toBe(0);              // nothing came back
    expect(saves.at(-1)).toEqual({});          // and storage really is empty
  });

  test('learned/forget on a cold worker removes the row instead of reporting not-learned', async () => {
    const { store, release, booting } = coldStore({ 'https://a.test': 'password-field' });
    const pending = routesFor(store)['learned/forget']({ host: 'a.test' });
    release(null);
    expect((await pending).ok).toBe(true);
    await booting;
    expect(store.snapshot().has('a.test')).toBe(false);
  });

  test('the boot read is shared, not re-run per route call', async () => {
    // hydrate() is memoized: a route joining an in-flight read must not start a
    // competing load whose merge could race the first one.
    const { store, release, loads } = coldStore({ 'https://a.test': 'password-field' });
    const routes = routesFor(store);
    const both = Promise.all([routes['learned/list'](), routes['learned/list']()]);
    release(null);
    await both;
    expect(loads()).toBe(1);
  });
});
