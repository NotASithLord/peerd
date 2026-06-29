// @ts-check
// Personal-data index — durable OPFS round-trip (live, real-browser). The STORE
// half of the local-first personal-data agent: the agent appends harvested
// records as JSONL to a STABLE Notebook's OPFS subtree ['peerd-notebooks', <id>],
// and a LATER worker run reads + queries them — the index lives on device and
// never touches the network. The durability claim (the subtree survives across
// worker runs) is the real OPFS lifecycle that bun cannot reach, so it runs here
// in a real browser. A fresh opfsHelpers instance stands in for a fresh worker
// run: the worker reaches OPFS through exactly these helpers over its bridge.

import { describe, it, expect } from '../../framework.js';
import { opfsHelpers } from '/peerd-engine/index.js';
import { parseJsonl, toJsonl, dedupeBy } from '/notebook-tab/notebook-std.js';

const ROOT = ['peerd-notebooks', 'e2e-pda-durability'];
const FILE = 'records/orders.jsonl';

const SAMPLE = [
  { id: 'amazon:o1', date: '2025-02-03', merchant: 'Amazon', amount: 12.5 },
  { id: 'amazon:o2', date: '2025-06-20', merchant: 'Amazon', amount: 7.5 },
  { id: 'amazon:o3', date: '2025-11-03', merchant: 'Amazon', amount: 30 },
];

describe('personal-data index — durable OPFS round-trip', () => {
  it('a record file written by one worker run is read back + summed by a fresh run', async () => {
    await opfsHelpers(ROOT).nuke(); // clean slate (no-op if absent)

    // run 1: a worker appends the harvested records.
    await opfsHelpers(ROOT).write(FILE, toJsonl(SAMPLE));

    // run 2: a FRESH helper (a fresh worker run / fresh realm) reads the SAME
    // subtree — proving the index persisted on device across runs.
    const reader = opfsHelpers(ROOT);
    const rows = parseJsonl(await reader.read(FILE));
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.id)).toEqual(['amazon:o1', 'amazon:o2', 'amazon:o3']);

    // the query the agent runs in the sealed worker: total spend.
    expect(rows.reduce((acc, r) => acc + r.amount, 0)).toBe(50);

    // the file is genuinely on disk under the stable Notebook subtree.
    const files = await reader.list();
    expect(files.some((f) => f.path.endsWith('orders.jsonl') && f.size > 0)).toBe(true);

    await opfsHelpers(ROOT).nuke();
  });

  it('append-merge across sweeps is idempotent (dedupeBy keeps the existing row)', async () => {
    await opfsHelpers(ROOT).nuke();

    // sweep 1: harvest the initial orders.
    await opfsHelpers(ROOT).write(FILE, toJsonl(dedupeBy(SAMPLE, 'id')));

    // sweep 2: re-harvest o2 (a dup) + a genuinely new o4 → read-modify-write.
    const existing = parseJsonl(await opfsHelpers(ROOT).read(FILE));
    const fresh = [
      { id: 'amazon:o2', date: '2025-06-20', merchant: 'Amazon', amount: 7.5 }, // dup
      { id: 'amazon:o4', date: '2025-12-01', merchant: 'Amazon', amount: 5 },   // new
    ];
    await opfsHelpers(ROOT).write(FILE, toJsonl(dedupeBy([...existing, ...fresh], 'id')));

    const merged = parseJsonl(await opfsHelpers(ROOT).read(FILE));
    expect(merged.length).toBe(4); // o1..o4, the re-harvested o2 added nothing
    expect(merged.map((r) => r.id)).toEqual(['amazon:o1', 'amazon:o2', 'amazon:o3', 'amazon:o4']);

    // re-running the SAME sweep converges — the on-disk index is stable.
    const again = dedupeBy([...merged, ...fresh], 'id');
    expect(again.length).toBe(4);
    expect(toJsonl(again)).toBe(toJsonl(merged));

    await opfsHelpers(ROOT).nuke();
  });
});
