// DESIGN-19 — the site-client STORE over fake-indexeddb. Proves the two-tier
// meta/body split, the confirm-committed put (staleness stamping), the
// run-outcome bookkeeping (verify bumps, failures accrue), removal, and SW-death
// survival (a fresh store instance reads persisted rows). A distinct DB from
// skills — a client can never be loaded as a skill.

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { useFakeIndexedDB } from '../setup.ts';
import { createSiteClientStore } from '../../extension/peerd-runtime/site-clients/store.js';

beforeAll(async () => { await useFakeIndexedDB(); });

// Each store gets a UNIQUE db name (over the shared global fake IDB) so cases
// don't cross-talk — the store's dbName seam exists for exactly this.
let dbSeq = 0;
const makeStore = (now: () => number) =>
  createSiteClientStore({ now, dbName: `site-clients-test-${++dbSeq}` });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture; the store validates the real shape
const dossier = (over: Record<string, unknown> = {}): any => ({
  origin: 'api.stripe.com',
  summary: 'payments API',
  endpoints: [{ method: 'GET', path: '/v1/charges' }],
  auth: 'bearer',
  deriver: 'capture-cdp',
  ...over,
});

let clock = 1_000;
beforeEach(() => { clock = 1_000; });
const now = () => clock;

describe('createSiteClientStore — put / get / listMeta', () => {
  test('put stamps a full meta and stores the body separately', async () => {
    const store = makeStore(now);
    const meta = await store.put({ dossier: dossier(), body: 'export const ops = {}' });
    expect(meta.origin).toBe('https://api.stripe.com');
    expect(meta.auth).toBe('bearer');
    expect(meta.deriver).toBe('capture-cdp');
    expect(meta.sizeBytes).toBe('export const ops = {}'.length);
    expect(meta.derivedAt).toBe(1_000);
    expect(meta.lastVerifiedAt).toBe(0);
    expect(meta.recentFailures).toBe(0);

    const full = await store.get('https://api.stripe.com');
    expect(full?.body).toBe('export const ops = {}');
    expect(full?.meta.summary).toBe('payments API');
  });

  test('getMeta returns meta only; unknown origin → null', async () => {
    const store = makeStore(now);
    await store.put({ dossier: dossier(), body: 'x' });
    expect((await store.getMeta('https://api.stripe.com'))?.origin).toBe('https://api.stripe.com');
    expect(await store.getMeta('https://api.unknown.com')).toBeNull();
    expect(await store.get('https://api.unknown.com')).toBeNull();
  });

  test('a re-derivation preserves createdAt but bumps derivedAt + resets verification', async () => {
    const store = makeStore(now);
    await store.put({ dossier: dossier(), body: 'v1' });
    await store.recordRun('https://api.stripe.com', { ok: true });   // verify it
    expect((await store.getMeta('https://api.stripe.com'))?.lastVerifiedAt).toBe(1_000);

    clock = 5_000;
    const meta2 = await store.put({ dossier: dossier({ summary: 'v2' }), body: 'v2' });
    expect(meta2.createdAt).toBe(1_000);      // preserved
    expect(meta2.derivedAt).toBe(5_000);      // bumped
    expect(meta2.lastVerifiedAt).toBe(0);     // reset — must re-earn trust
  });

  test('listMeta returns all metas, no bodies deserialized', async () => {
    const store = makeStore(now);
    await store.put({ dossier: dossier({ origin: 'api.stripe.com' }), body: 'a' });
    await store.put({ dossier: dossier({ origin: 'api.github.com' }), body: 'b' });
    const metas = await store.listMeta();
    expect(metas.map((m) => m.origin).sort()).toEqual(['https://api.github.com', 'https://api.stripe.com']);
    expect(metas.every((m) => !('body' in m))).toBe(true);
  });
});

describe('recordRun — staleness bookkeeping', () => {
  test('failure increments recentFailures; success clears it + bumps lastVerifiedAt', async () => {
    const store = makeStore(now);
    await store.put({ dossier: dossier(), body: 'x' });
    await store.recordRun('https://api.stripe.com', { ok: false });
    await store.recordRun('https://api.stripe.com', { ok: false });
    expect((await store.getMeta('https://api.stripe.com'))?.recentFailures).toBe(2);
    clock = 9_000;
    await store.recordRun('https://api.stripe.com', { ok: true });
    const m = await store.getMeta('https://api.stripe.com');
    expect(m?.recentFailures).toBe(0);
    expect(m?.lastVerifiedAt).toBe(9_000);
  });

  test('recordRun on an unknown origin is a harmless no-op', async () => {
    const store = makeStore(now);
    await store.recordRun('https://api.nope.com', { ok: true });
    expect(await store.getMeta('https://api.nope.com')).toBeNull();
  });
});

describe('remove + persistence across a fresh instance (SW death)', () => {
  test('remove drops both records', async () => {
    const store = makeStore(now);
    await store.put({ dossier: dossier(), body: 'x' });
    await store.remove('https://api.stripe.com');
    expect(await store.get('https://api.stripe.com')).toBeNull();
  });

  test('a fresh store over the SAME db reads persisted rows', async () => {
    const shared = `site-clients-persist-${++dbSeq}`;
    const a = createSiteClientStore({ now, dbName: shared });
    await a.put({ dossier: dossier(), body: 'persisted' });
    const b = createSiteClientStore({ now, dbName: shared });
    expect((await b.get('https://api.stripe.com'))?.body).toBe('persisted');
  });
});
