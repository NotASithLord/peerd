// DESIGN-19 — the site-client STORE over fake-indexeddb. Proves the two-tier
// meta/body split, the confirm-committed put (staleness stamping), the
// run-outcome bookkeeping (verify bumps, failures accrue), removal, and SW-death
// survival (a fresh store instance reads persisted rows). A distinct DB from
// skills — a client can never be loaded as a skill.

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { useFakeIndexedDB } from '../setup.ts';
import { siteClientValidatedOperations } from '../../extension/peerd-runtime/site-clients/core.js';
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
const readContract = { name: 'lookup', readOnly: true, inputSchema: { type: 'string' }, outputSchema: { type: 'integer' } };
const validatedDossier = (over: Record<string, unknown> = {}) => dossier({ operations: [readContract],
  validationCases: [{ operation: 'lookup', input: 'a', expected: 1 }, { operation: 'lookup', input: 'b', expected: 2 }], ...over });
const promote = async (store: ReturnType<typeof makeStore>) => {
  const meta = await store.getMeta('https://api.stripe.com');
  const revision = meta!.revision!;
  const attempt = (await store.beginValidation('https://api.stripe.com', revision))!;
  return store.recordValidation('https://api.stripe.com', { revision, attempt,
    cases: [{ index: 0, operation: 'lookup', ok: true }, { index: 1, operation: 'lookup', ok: true }] });
};


describe('createSiteClientStore — put / get / listMeta', () => {
  test('put stamps a full meta and stores the body separately', async () => {
    const store = makeStore(now);
    const meta = await store.put({ dossier: dossier(), body: 'return { ops: 1 }' });
    expect(meta.origin).toBe('https://api.stripe.com');
    expect(meta.auth).toBe('bearer');
    expect(meta.deriver).toBe('capture-cdp');
    expect(meta.sizeBytes).toBe('return { ops: 1 }'.length);
    expect(meta.derivedAt).toBe(1_000);
    expect(meta.lastVerifiedAt).toBe(0);
    expect(meta.recentFailures).toBe(0);

    const full = await store.get('https://api.stripe.com');
    expect(full?.body).toBe('return { ops: 1 }');
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
    await store.put({ dossier: validatedDossier(), body: 'v1' });
    await promote(store);
    expect((await store.getMeta('https://api.stripe.com'))?.lastVerifiedAt).toBe(1_000);

    clock = 5_000;
    const meta2 = await store.put({ dossier: dossier({ summary: 'v2' }), body: 'v2' });
    expect(meta2.createdAt).toBe(1_000);      // preserved
    expect(meta2.derivedAt).toBe(5_000);      // bumped
    expect(meta2.lastVerifiedAt).toBe(0);     // reset — must re-earn trust
  });

  test('a dossier-only patch (body unchanged) PRESERVES verification', async () => {
    const store = makeStore(now);
    await store.put({ dossier: validatedDossier(), body: 'v1' });
    await promote(store);
    clock = 5_000;
    // Same body, new summary → verification (and derivedAt) must survive.
    const meta = await store.put({ dossier: validatedDossier({ summary: 'edited prose' }), body: 'v1' });
    expect(meta.summary).toBe('edited prose');
    expect(meta.lastVerifiedAt).toBe(1_000);   // preserved, not reset
    expect(meta.derivedAt).toBe(1_000);        // module unchanged → derivedAt kept
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
  test('failure increments recentFailures; execution success never establishes verification', async () => {
    const store = makeStore(now);
    await store.put({ dossier: dossier(), body: 'x' });
    await store.recordRun('https://api.stripe.com', { ok: false });
    await store.recordRun('https://api.stripe.com', { ok: false });
    expect((await store.getMeta('https://api.stripe.com'))?.recentFailures).toBe(2);
    clock = 9_000;
    await store.recordRun('https://api.stripe.com', { ok: true });
    const m = await store.getMeta('https://api.stripe.com');
    expect(m?.recentFailures).toBe(0);
    expect(m?.lastVerifiedAt).toBe(0);
    expect(m?.lastRunAt).toBe(9_000);
    expect(m?.lastRunOk).toBe(true);
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


describe('revision-bound validation', () => {
  test.each(['body', 'contracts', 'cases'])('%s changes invalidate proof and mint a different revision', async (change) => {
    const store = makeStore(now);
    await store.put({ dossier: validatedDossier(), body: 'v1' });
    const before = (await promote(store))!;
    expect(siteClientValidatedOperations(before)).toEqual(['lookup']);
    const after = await store.put({ body: change === 'body' ? 'v2' : 'v1', dossier: validatedDossier({
      ...(change === 'contracts' ? { operations: [{ ...readContract, description: 'new contract' }] } : {}),
      ...(change === 'cases' ? { validationCases: [
        { operation: 'lookup', input: 'c', expected: 3 }, { operation: 'lookup', input: 'd', expected: 4 },
      ] } : {}),
    }) });
    expect(after.revision).not.toBe(before.revision);
    expect(siteClientValidatedOperations(after)).toEqual([]);
    expect(after.lastVerifiedAt).toBe(0);
    await store.recordRun(after.origin, { ok: false, revision: before.revision });
    expect((await store.getMeta(after.origin))?.recentFailures).toBe(0);
  });
  test('old attempts cannot promote after a newer attempt, failure, or replacement', async () => {
    const store = makeStore(now);
    const meta = await store.put({ dossier: validatedDossier(), body: 'v1' });
    const revision = meta.revision!;
    const first = (await store.beginValidation(meta.origin, revision))!;
    const second = (await store.beginValidation(meta.origin, revision))!;
    const cases = [{ index: 0, operation: 'lookup', ok: true }, { index: 1, operation: 'lookup', ok: true }];
    expect(await store.recordValidation(meta.origin, { revision, attempt: first, cases })).toBeNull();
    await store.recordRun(meta.origin, { ok: false, revision });
    expect(await store.recordValidation(meta.origin, { revision, attempt: second, cases })).toBeNull();
    const third = (await store.beginValidation(meta.origin, revision))!;
    await store.put({ dossier: validatedDossier(), body: 'v2' });
    expect(await store.recordValidation(meta.origin, { revision, attempt: third, cases })).toBeNull();
    expect(siteClientValidatedOperations(await store.getMeta(meta.origin))).toEqual([]);
  });
  test('late ownership rollback only revokes its exact committed proof', async () => {
    const store = makeStore(now);
    await store.put({ dossier: validatedDossier(), body: 'v1' });
    const first = (await promote(store))!;
    const second = (await promote(store))!;
    await store.revokeValidation(first.origin, { revision: first.revision!, attempt: first.validation.attempt });
    expect(siteClientValidatedOperations(await store.getMeta(first.origin))).toEqual(['lookup']);
    await store.revokeValidation(second.origin, { revision: second.revision!, attempt: second.validation.attempt });
    expect(siteClientValidatedOperations(await store.getMeta(second.origin))).toEqual([]);
  });

  test('legacy records remain runnable without inheriting typed trust or touching replacement revisions', async () => {
    const dbName = `site-clients-legacy-${++dbSeq}`;
    const store = createSiteClientStore({ now, dbName });
    const meta = await store.put({ dossier: dossier(), body: 'v1' });
    delete meta.revision;
    delete meta.operations;
    delete meta.validationCases;
    meta.lastVerifiedAt = 999;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('meta', 'readwrite');
      transaction.objectStore('meta').put(meta);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    await store.recordRun(meta.origin, { ok: true, revision: '' });
    expect((await store.getMeta(meta.origin))?.lastVerifiedAt).toBe(0);
    expect(siteClientValidatedOperations(await store.getMeta(meta.origin))).toEqual([]);
    const replacement = await store.put({ dossier: validatedDossier(), body: 'v2' });
    await store.recordRun(meta.origin, { ok: false, revision: '' });
    expect((await store.getMeta(meta.origin))?.recentFailures).toBe(0);
    expect(replacement.revision).toBeTruthy();
  });

  test('Stop aborts a pending promotion transaction after its write was queued', async () => {
    const controller = new AbortController();
    let stopDuringCommit = false;
    const store = makeStore(() => {
      if (stopDuringCommit) queueMicrotask(() => controller.abort());
      return clock;
    });
    const meta = await store.put({ dossier: validatedDossier(), body: 'v1' });
    const revision = meta.revision!;
    const attempt = (await store.beginValidation(meta.origin, revision))!;
    stopDuringCommit = true;
    await expect(store.recordValidation(meta.origin, { revision, attempt, signal: controller.signal,
      cases: [{ index: 0, operation: 'lookup', ok: true }, { index: 1, operation: 'lookup', ok: true }] })).rejects.toThrow();
    const current = await store.getMeta(meta.origin);
    expect(current?.validation.status).toBe('pending');
    expect(current?.lastVerifiedAt).toBe(0);
    expect(siteClientValidatedOperations(current)).toEqual([]);
  });

  test('all declared receipts are required; failed typed execution revokes promotion', async () => {
    const store = makeStore(now);
    const meta = await store.put({ dossier: validatedDossier(), body: 'v1' });
    const revision = meta.revision!;
    const attempt = (await store.beginValidation(meta.origin, revision))!;
    const failed = await store.recordValidation(meta.origin, { revision, attempt,
      cases: [{ index: 0, operation: 'lookup', ok: true }] });
    expect(failed?.validation.status).toBe('failed');
    expect(failed?.lastVerifiedAt).toBe(0);
    await promote(store);
    await store.recordRun(meta.origin, { ok: false, revision });
    expect(siteClientValidatedOperations(await store.getMeta(meta.origin))).toEqual([]);
  });
});
