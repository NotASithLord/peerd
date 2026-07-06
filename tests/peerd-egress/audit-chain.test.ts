// R4 tamper evidence — the audit log's hash chain. Every naive tampering
// must be DETECTED (rewrite, mid-log deletion, tail truncation, an
// inserted chainless entry), legal operations must verify (pruning the
// oldest, legacy pre-chain prefixes), and interleaved async appends must
// serialize into one linear chain.

import { describe, test, expect } from 'bun:test';
import { computeChainHash, verifyChain, canonicalCore, CHAIN_HEAD_KEY } from '../../extension/peerd-egress/audit/chain.js';
import { createAuditLog } from '../../extension/peerd-egress/audit/log.js';

// A recording fake idb with both stores (audit_log rows + the audit_meta head).
const makeFakeIdb = () => {
  const rows: any[] = [];
  const meta = new Map<string, any>();
  return {
    rows, meta,
    put: async (store: string, value: any) => {
      if (store === 'audit_meta') { meta.set(value.key, value); return; }
      rows.push(value);
    },
    get: async (store: string, key: string) => (store === 'audit_meta' ? meta.get(key) : undefined),
    getAll: async () => [...rows],
    count: async () => rows.length,
    getAllKeys: async (_s: string, limit?: number) => rows.slice(0, limit).map((r) => r.id),
    delUpTo: async (_s: string, key: string) => {
      const idx = rows.findIndex((r) => r.id === key);
      rows.splice(0, idx + 1);
    },
  };
};

let tick = 0;
const makeLog = (idb: any) => createAuditLog({
  idb, now: () => ++tick, makeId: () => `id-${String(++tick).padStart(6, '0')}`,
});

describe('the chain hash', () => {
  test('is deterministic and covers every core field', async () => {
    const entry = { id: 'a', when: 1, type: 'x', sessionId: 's', details: { n: 1 } };
    expect(await computeChainHash('', entry)).toBe(await computeChainHash('', entry));
    expect(await computeChainHash('', entry)).not.toBe(await computeChainHash('', { ...entry, when: 2 }));
    expect(await computeChainHash('', entry)).not.toBe(await computeChainHash('other', entry));
    expect(canonicalCore(entry)).toContain('\x1f');
  });
});

describe('append builds a verifiable chain', () => {
  test('sequential appends verify; the head pins the newest entry', async () => {
    const idb = makeFakeIdb();
    const log = makeLog(idb);
    await log.append({ type: 'a' });
    await log.append({ type: 'b', sessionId: 's1' });
    await log.append({ type: 'c', details: { k: 'v' } });
    const result = await log.verify();
    expect(result).toEqual({ ok: true, checked: 3, unchained: 0 });
    expect(idb.meta.get(CHAIN_HEAD_KEY).id).toBe(idb.rows[2].id);
  });

  test('interleaved un-awaited appends serialize into ONE linear chain', async () => {
    const idb = makeFakeIdb();
    const log = makeLog(idb);
    await Promise.all(Array.from({ length: 12 }, (_, i) => log.append({ type: `t${i}` })));
    const result = await log.verify();
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(12);
  });
});

describe('tampering is detected', () => {
  const seeded = async () => {
    const idb = makeFakeIdb();
    const log = makeLog(idb);
    for (let i = 0; i < 6; i++) await log.append({ type: `t${i}`, details: { i } });
    return { idb, log };
  };

  test('a rewritten entry breaks verification at the right link', async () => {
    const { idb, log } = await seeded();
    idb.rows[2].details = { i: 999 };                       // in-place rewrite
    const result = await log.verify();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('chain mismatch');
    expect(result.brokenAtId).toBe(idb.rows[2].id);         // the rewritten entry's own hash no longer matches
  });

  test('deleting a middle entry breaks the chain', async () => {
    const { idb, log } = await seeded();
    idb.rows.splice(3, 1);
    expect((await log.verify()).ok).toBe(false);
  });

  test('truncating the tail is caught by the head record', async () => {
    const { idb, log } = await seeded();
    idb.rows.pop();
    const result = await log.verify();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('head mismatch');
  });

  test('an inserted chainless entry after chained ones is caught', async () => {
    const { idb, log } = await seeded();
    idb.rows.splice(4, 0, { id: 'id-zzzzzz', when: 999, type: 'forged' });
    expect((await log.verify()).ok).toBe(false);
  });
});

describe('legal operations still verify', () => {
  test('pruning the OLDEST entries keeps the chain valid (anchor semantics)', async () => {
    const idb = makeFakeIdb();
    const log = makeLog(idb);
    for (let i = 0; i < 8; i++) await log.append({ type: `t${i}` });
    idb.rows.splice(0, 3);                                  // what retention pruning does
    const result = await log.verify();
    expect(result).toEqual({ ok: true, checked: 5, unchained: 0 });
  });

  test('a legacy pre-chain PREFIX reports unchained, not failed', async () => {
    const idb = makeFakeIdb();
    idb.rows.push({ id: 'id-000001', when: 1, type: 'legacy-a' }, { id: 'id-000002', when: 2, type: 'legacy-b' });
    const log = makeLog(idb);
    await log.append({ type: 'new' });
    const result = await log.verify();
    expect(result.ok).toBe(true);
    expect(result.unchained).toBe(2);
    expect(result.checked).toBe(1);
  });

  test('a chain resumes correctly across a "SW restart" (fresh factory, same idb)', async () => {
    const idb = makeFakeIdb();
    await makeLog(idb).append({ type: 'before' });
    const log2 = makeLog(idb);                              // new closure, tail must reload from meta
    await log2.append({ type: 'after' });
    expect((await log2.verify()).ok).toBe(true);
    expect((await log2.verify()).checked).toBe(2);
  });

  test('verifyChain with no head and no entries is ok (fresh install)', async () => {
    expect((await verifyChain([], null)).ok).toBe(true);
  });
});
