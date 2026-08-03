// The script value-spill store (run cache) over fake-indexeddb. Proves the
// record round-trip with its security stamps intact (ownerSessionId + fenced +
// originLabel — read_run_cache's refusal and re-fencing depend on them),
// createdAt stamping, LRU eviction by age (keys are NOT chronological here,
// unlike the web cache), and SW-death survival (a fresh instance reads
// persisted rows).

import { describe, test, expect, beforeAll } from 'bun:test';
import { useFakeIndexedDB } from '../../setup.ts';
import { createRunCacheStore, MAX_SPILL_TEXT_CHARS } from '../../../extension/peerd-runtime/tools/run-cache.js';

beforeAll(async () => { await useFakeIndexedDB(); });

// Each store gets a UNIQUE db name (over the shared global fake IDB) so cases
// don't cross-talk — the store's dbName seam exists for exactly this.
let dbSeq = 0;
const makeStore = (now?: () => number, dbName?: string) =>
  createRunCacheStore({ now, dbName: dbName ?? `run-cache-test-${++dbSeq}` });

const record = (over: Record<string, unknown> = {}) => ({
  key: 'run:tu-1',
  ownerSessionId: 'chat-1',
  fenced: true,
  originLabel: 'script (fetched web content)',
  text: 'x'.repeat(100),
  ...over,
});

describe('createRunCacheStore', () => {
  test('put/get round-trips the record with its security stamps + a createdAt', async () => {
    const store = makeStore(() => 1_000);
    await store.put(record());
    const rec = await store.get('run:tu-1');
    expect(rec).toMatchObject({
      key: 'run:tu-1', ownerSessionId: 'chat-1', fenced: true,
      originLabel: 'script (fetched web content)',
    });
    expect(rec?.text.length).toBe(100);
    expect(rec?.createdAt).toBe(1_000);
  });

  test('unknown key → undefined', async () => {
    const store = makeStore();
    expect(await store.get('run:ghost')).toBeUndefined();
  });

  test('evicts the OLDEST entries beyond the cap, by createdAt not key order', async () => {
    let clock = 0;
    const store = makeStore(() => ++clock);
    // 41 entries with keys that do NOT sort chronologically ('run:zz…' first).
    await store.put(record({ key: 'run:zz-oldest' }));            // createdAt 1 — the eviction target
    for (let i = 0; i < 40; i++) {
      await store.put(record({ key: `run:aa-${String(i).padStart(2, '0')}` }));
    }
    expect(await store.get('run:zz-oldest')).toBeUndefined();     // oldest gone
    expect(await store.get('run:aa-00')).toBeDefined();           // newest 40 kept
    expect(await store.get('run:aa-39')).toBeDefined();
  });

  test('caps a pathological text at the per-record ceiling (one value cannot dominate the store)', async () => {
    const store = makeStore();
    await store.put(record({ key: 'run:huge', text: 'h'.repeat(MAX_SPILL_TEXT_CHARS + 5) }));
    const rec = await store.get('run:huge');
    expect(rec?.text.length).toBe(MAX_SPILL_TEXT_CHARS);
    expect(rec?.text.startsWith('hhh')).toBe(true);
  });

  test('a fresh store instance reads persisted rows (SW-death survival)', async () => {
    const dbName = `run-cache-test-shared-${++dbSeq}`;
    await makeStore(() => 5, dbName).put(record({ key: 'run:persist' }));
    const rec = await makeStore(() => 6, dbName).get('run:persist');
    expect(rec?.ownerSessionId).toBe('chat-1');
  });
});
