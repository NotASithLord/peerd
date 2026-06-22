// Audit-log capped retention — the pure policy plus the append-path
// amortization, driven through a recording fake idb (values in, calls
// out; the REAL IndexedDB path is covered by the in-browser suite at
// extension/tests/unit/peerd-egress/audit-retention.test.js).

import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_AUDIT_MAX_ENTRIES,
  DEFAULT_PRUNE_CHECK_EVERY,
  normalizeMaxEntries,
  excessEntries,
} from '../../extension/peerd-egress/audit/retention.js';
import { createAuditLog } from '../../extension/peerd-egress/audit/log.js';

describe('retention policy (pure)', () => {
  test('default cap sits in the few-tens-of-thousands range', () => {
    expect(DEFAULT_AUDIT_MAX_ENTRIES).toBe(20_000);
    expect(DEFAULT_PRUNE_CHECK_EVERY).toBe(256);
  });

  test('normalizeMaxEntries accepts positive finite counts', () => {
    expect(normalizeMaxEntries(5_000)).toBe(5_000);
    expect(normalizeMaxEntries(1)).toBe(1);
    expect(normalizeMaxEntries(123.9)).toBe(123); // floored, not rounded up
  });

  test('normalizeMaxEntries falls back to the default for nonsense', () => {
    for (const bad of [undefined, null, 0, -1, NaN, Infinity, '5000', {}]) {
      expect(normalizeMaxEntries(bad)).toBe(DEFAULT_AUDIT_MAX_ENTRIES);
    }
  });

  test('excessEntries is the over-cap amount, clamped at zero', () => {
    expect(excessEntries(0, 100)).toBe(0);
    expect(excessEntries(100, 100)).toBe(0);
    expect(excessEntries(101, 100)).toBe(1);
    expect(excessEntries(350, 100)).toBe(250);
  });
});

// Fake idb that records calls and emulates IDB's key-ordered store. Keys
// are zero-padded so lexicographic order == append order, mirroring how
// UUIDv7 ids sort in the real store.
const makeFakeIdb = () => {
  const rows = new Map<string, any>();
  const calls: string[] = [];
  const sorted = () => [...rows.keys()].sort();
  return {
    calls,
    rows,
    put: async (_s: string, v: any) => { calls.push('put'); rows.set(v.id, v); },
    getAll: async () => sorted().map((k) => rows.get(k)),
    count: async () => { calls.push('count'); return rows.size; },
    getAllKeys: async (_s: string, limit?: number) => {
      calls.push('getAllKeys');
      const keys = sorted();
      return limit === undefined ? keys : keys.slice(0, limit);
    },
    delUpTo: async (_s: string, key: string) => {
      calls.push(`delUpTo:${key}`);
      for (const k of sorted()) if (k <= key) rows.delete(k);
    },
  };
};

const makeLog = (idb: ReturnType<typeof makeFakeIdb>, opts: Record<string, unknown> = {}) => {
  let seq = 0;
  return createAuditLog({
    idb,
    now: () => 1_000 + seq,
    makeId: () => `id-${String(seq++).padStart(6, '0')}`,
    ...opts,
  });
};

describe('createAuditLog — amortized prune-on-append', () => {
  test('appends below the cap never delete', async () => {
    const idb = makeFakeIdb();
    const log = makeLog(idb, { maxEntries: 10, pruneCheckEvery: 1 });
    for (let i = 0; i < 10; i++) await log.append({ type: 'tool_executed' });
    expect(idb.rows.size).toBe(10);
    expect(idb.calls.some((c) => c.startsWith('delUpTo'))).toBe(false);
  });

  test('crossing the cap prunes oldest-first back down to it', async () => {
    const idb = makeFakeIdb();
    const log = makeLog(idb, { maxEntries: 5, pruneCheckEvery: 1 });
    for (let i = 0; i < 8; i++) await log.append({ type: 'tool_executed' });
    const ids = [...idb.rows.keys()].sort();
    expect(idb.rows.size).toBe(5);
    // ids id-000000..000002 (the three oldest) are gone; newest survive.
    expect(ids[0]).toBe('id-000003');
    expect(ids[ids.length - 1]).toBe('id-000007');
  });

  test('count is checked once per batch, not per append (amortized)', async () => {
    const idb = makeFakeIdb();
    const log = makeLog(idb, { maxEntries: 1_000, pruneCheckEvery: 4 });
    // First append always checks (boot catch-up), then every 4th.
    for (let i = 0; i < 9; i++) await log.append({ type: 'tool_executed' });
    const counts = idb.calls.filter((c) => c === 'count').length;
    expect(counts).toBe(3); // appends #1, #5, #9
  });

  test('the store may briefly exceed the cap between checks', async () => {
    const idb = makeFakeIdb();
    const log = makeLog(idb, { maxEntries: 3, pruneCheckEvery: 4 });
    // Append #1 checks (1 ≤ 3, nothing pruned); #2-#4 don't check.
    for (let i = 0; i < 4; i++) await log.append({ type: 'tool_executed' });
    expect(idb.rows.size).toBe(4); // overshoot bounded by the batch size
    await log.append({ type: 'tool_executed' }); // #5 checks → prunes
    expect(idb.rows.size).toBe(3);
  });

  test('pre-existing overgrowth is trimmed by the first append', async () => {
    const idb = makeFakeIdb();
    // Simulate an install that grew unbounded before retention shipped.
    // 'ia-' sorts before the log's 'id-' ids, so these are the oldest.
    for (let i = 0; i < 20; i++) {
      const id = `ia-${String(i).padStart(6, '0')}`;
      idb.rows.set(id, { id, type: 'old' });
    }
    const log = makeLog(idb, { maxEntries: 5, pruneCheckEvery: 256 });
    await log.append({ type: 'tool_executed' }); // first post-boot append checks immediately
    expect(idb.rows.size).toBe(5);
    // The survivors are the NEWEST five — 16 old entries went, the fresh
    // append stayed.
    expect([...idb.rows.keys()].sort()[4]).toBe('id-000000');
  });

  test('append still rejects malformed input before touching storage', async () => {
    const idb = makeFakeIdb();
    const log = makeLog(idb, { maxEntries: 5, pruneCheckEvery: 1 });
    await expect(log.append({} as any)).rejects.toThrow(TypeError);
    expect(idb.rows.size).toBe(0);
  });
});
