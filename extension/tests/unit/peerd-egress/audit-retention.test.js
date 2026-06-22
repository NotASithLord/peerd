// @ts-check
// Audit-log retention against the REAL IndexedDB wrapper — exercises
// count/getAllKeys/delUpTo as actual IDB transactions on the audit_log
// store (the pure policy and amortization cadence live in the Bun suite
// at tests/peerd-egress/audit-retention.test.ts).
//
// Each test clears the store first: the runner's origin-scoped DB
// persists across reruns in a dev profile, and leftovers would make the
// cap assertions flaky.

import { describe, it, expect } from '../../framework.js';
import { createAuditLog, idb } from '/peerd-egress/index.js';

const STORE = 'audit_log';

// Zero-padded injected ids sort exactly like the UUIDv7 ids the real
// log generates — chronologically — without depending on clock order.
const makeLog = (opts = {}) => {
  let seq = 0;
  return createAuditLog({
    idb,
    now: () => 1_700_000_000_000 + seq,
    makeId: () => `id-${String(seq++).padStart(6, '0')}`,
    ...opts,
  });
};

describe('audit log retention (real IDB)', () => {
  it('append + list round-trip through the real store', async () => {
    await idb.clear(STORE);
    const log = makeLog({ maxEntries: 100, pruneCheckEvery: 1 });
    await log.append({ type: 'vault_unlocked' });
    await log.append({ type: 'tool_executed', sessionId: 's1' });
    const all = await log.list();
    expect(all.length).toBe(2);
    expect(all[0].type).toBe('vault_unlocked');
    expect(all[1].sessionId).toBe('s1');
    expect(typeof all[0].when).toBe('number');
  });

  it('prunes oldest-first once the cap is crossed; newest survive', async () => {
    await idb.clear(STORE);
    const log = makeLog({ maxEntries: 5, pruneCheckEvery: 1 });
    for (let i = 0; i < 9; i++) await log.append({ type: 'tool_executed', details: { i } });
    const all = await log.list();
    expect(all.length).toBe(5);
    // Entries 0-3 pruned; 4-8 retained, still in chronological order.
    expect(all[0].details.i).toBe(4);
    expect(all[4].details.i).toBe(8);
  });

  it('amortization: overshoot between checks, trimmed at the next one', async () => {
    await idb.clear(STORE);
    const log = makeLog({ maxEntries: 3, pruneCheckEvery: 4 });
    // Append #1 runs the boot check (under cap → no-op); #2-#4 skip.
    for (let i = 0; i < 4; i++) await log.append({ type: 'tool_executed' });
    expect((await log.list()).length).toBe(4); // briefly over the cap
    await log.append({ type: 'tool_executed' }); // #5 checks → prunes
    expect((await log.list()).length).toBe(3);
  });

  it('an install that overgrew before retention shipped is trimmed on first append', async () => {
    await idb.clear(STORE);
    // Seed the store directly, bypassing the log — these sort oldest.
    for (let i = 0; i < 12; i++) {
      await idb.put(STORE, { id: `ia-${String(i).padStart(6, '0')}`, when: i, type: 'tool_executed' });
    }
    const log = makeLog({ maxEntries: 6, pruneCheckEvery: 256 });
    await log.append({ type: 'vault_unlocked' });
    const all = await log.list();
    expect(all.length).toBe(6);
    // The fresh entry is the newest of the survivors.
    expect(all[5].type).toBe('vault_unlocked');
  });

  it('list() and a raw getAll (the inspect_audit_log path) agree', async () => {
    await idb.clear(STORE);
    const log = makeLog({ maxEntries: 4, pruneCheckEvery: 1 });
    for (let i = 0; i < 7; i++) await log.append({ type: 'tool_executed', details: { i } });
    // inspect_audit_log reads ctx.idb.getAll('audit_log') directly; the
    // Logs view reads auditLog.list(). Both must see the pruned store.
    const viaList = await log.list();
    const viaGetAll = await idb.getAll(STORE);
    expect(viaList).toEqual(viaGetAll);
    expect(viaGetAll.length).toBe(4);
    await idb.clear(STORE); // leave the shared store clean for other suites
  });
});
