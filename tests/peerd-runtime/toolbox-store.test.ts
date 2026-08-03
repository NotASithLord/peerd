// design js-superpower/06 — the toolbox STORE over fake-indexeddb. Proves the
// two-tier meta/body split, validation at the put boundary, the module-count
// cap, run-outcome bookkeeping (runCount/failCount), removal (a deleted name
// stops resolving), and SW-death survival (a fresh store instance reads
// persisted rows). A distinct DB from skills AND site clients — a toolbox
// module can never be loaded as a skill or run against an origin pin.

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { useFakeIndexedDB } from '../setup.ts';
import { createToolboxStore } from '../../extension/peerd-runtime/toolbox/store.js';
import { MAX_TOOLBOX_MODULES } from '../../extension/peerd-runtime/toolbox/core.js';

beforeAll(async () => { await useFakeIndexedDB(); });

// Each store gets a UNIQUE db name (over the shared global fake IDB) so cases
// don't cross-talk — the store's dbName seam exists for exactly this.
let dbSeq = 0;
const makeStore = (now: () => number, dbName?: string) =>
  createToolboxStore({ now, dbName: dbName ?? `toolbox-test-${++dbSeq}` });

let clock = 1_000;
beforeEach(() => { clock = 1_000; });
const now = () => clock;

describe('createToolboxStore — put / get / listMeta / getBody', () => {
  test('put stamps a full meta (exports extracted) and stores the body in its own tier', async () => {
    const store = makeStore(now);
    const m = await store.put({ name: 'tables', description: 'row helpers', body: 'export const dedupeRows = 1;' });
    expect(m.name).toBe('tables');
    expect(m.exports).toEqual(['dedupeRows']);
    expect(m.sizeBytes).toBe('export const dedupeRows = 1;'.length);
    expect(m.runCount).toBe(0);
    expect(m.failCount).toBe(0);
    expect(m.createdAt).toBe(1_000);

    expect((await store.getMeta('tables'))?.description).toBe('row helpers');
    expect(await store.getBody('tables')).toBe('export const dedupeRows = 1;');
    expect((await store.get('tables'))?.body).toBe('export const dedupeRows = 1;');
    expect((await store.listMeta()).length).toBe(1);
  });

  test('unknown / malformed names read as null (never throw on the hot path)', async () => {
    const store = makeStore(now);
    expect(await store.getMeta('ghost')).toBeNull();
    expect(await store.getBody('ghost')).toBeNull();
    expect(await store.getBody('NOT_A_NAME!')).toBeNull();
    expect(await store.get('ghost')).toBeNull();
  });

  test('put validates at the boundary: bad name / empty body refuse loudly', async () => {
    const store = makeStore(now);
    await expect(store.put({ name: 'Bad Name', body: 'export const x = 1;' })).rejects.toThrow(TypeError);
    await expect(store.put({ name: 'ok', body: '' })).rejects.toThrow(TypeError);
  });

  test('a re-write with a changed body resets the rot counters; description-only keeps them', async () => {
    const store = makeStore(now);
    await store.put({ name: 'tables', description: 'v1', body: 'export const a = 1;' });
    await store.recordRuns(['tables'], { ok: false });
    expect((await store.getMeta('tables'))?.failCount).toBe(1);

    clock = 2_000;
    await store.put({ name: 'tables', description: 'v1 with better prose', body: 'export const a = 1;' });
    expect((await store.getMeta('tables'))?.failCount).toBe(1);   // body unchanged → counters kept

    await store.put({ name: 'tables', description: 'v2', body: 'export const a = 2;' });
    const m = await store.getMeta('tables');
    expect(m?.failCount).toBe(0);   // rewritten module re-earns its record
    expect(m?.runCount).toBe(0);
    expect(m?.createdAt).toBe(1_000);
    expect(m?.updatedAt).toBe(2_000);
  });
});

describe('createToolboxStore — the module-count cap', () => {
  test(`the ${MAX_TOOLBOX_MODULES}th+1 CREATE refuses; updates still land`, async () => {
    const store = makeStore(now);
    for (let i = 0; i < MAX_TOOLBOX_MODULES; i++) {
      await store.put({ name: `m-${i}`, body: 'export const x = 1;' });
    }
    await expect(store.put({ name: 'one-too-many', body: 'export const x = 1;' }))
      .rejects.toThrow(/toolbox is full/);
    // an UPDATE of an existing module is not a create and passes
    await store.put({ name: 'm-0', body: 'export const x = 2;' });
    expect(await store.getBody('m-0')).toBe('export const x = 2;');
  });
});

describe('createToolboxStore — run-outcome bookkeeping', () => {
  test('recordRuns bumps runCount always, failCount on failure; unknown names are skipped', async () => {
    const store = makeStore(now);
    await store.put({ name: 'a', body: 'export const a = 1;' });
    await store.put({ name: 'b', body: 'export const b = 1;' });
    await store.recordRuns(['a', 'b', 'ghost'], { ok: true });
    await store.recordRuns(['a'], { ok: false });
    expect(await store.getMeta('a')).toMatchObject({ runCount: 2, failCount: 1 });
    expect(await store.getMeta('b')).toMatchObject({ runCount: 1, failCount: 0 });
  });

  test('recordRuns never touches updatedAt — it stays the WRITE timestamp (the rot signal)', async () => {
    const store = makeStore(now);
    await store.put({ name: 'a', body: 'export const a = 1;' });
    clock = 90_000_000;   // much later — a run must not refresh the dossier age
    await store.recordRuns(['a'], { ok: false });
    expect(await store.getMeta('a')).toMatchObject({ runCount: 1, failCount: 1, updatedAt: 1_000 });
  });
});

describe('createToolboxStore — removal + persistence', () => {
  test('remove drops BOTH tiers — a deleted name stops resolving', async () => {
    const store = makeStore(now);
    await store.put({ name: 'tables', body: 'export const x = 1;' });
    await store.remove('tables');
    expect(await store.getMeta('tables')).toBeNull();
    expect(await store.getBody('tables')).toBeNull();   // the toolbox/read route now answers not-found
    expect((await store.listMeta()).length).toBe(0);
  });

  test('a fresh store instance over the same DB reads persisted rows (SW-death survival)', async () => {
    const dbName = `toolbox-test-persist-${++dbSeq}`;
    const store1 = makeStore(now, dbName);
    await store1.put({ name: 'tables', description: 'kept', body: 'export const x = 1;' });
    const store2 = makeStore(now, dbName);
    expect((await store2.getMeta('tables'))?.description).toBe('kept');
    expect(await store2.getBody('tables')).toBe('export const x = 1;');
  });
});
