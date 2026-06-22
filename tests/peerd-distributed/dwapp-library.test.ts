import { describe, test, expect } from 'bun:test';
import { createLibrary } from '../../extension/peerd-distributed/apps/library.js';

// A minimal verified-card stand-in (the Library never re-verifies; discovery.js
// does, then hands it the derived id). Shape matches a signItem result.
const card = (publisher: string, slug: string, seq: number, name = slug) =>
  ({ publisher, salt: slug, seq, sig: 'x', value: { name, description: '', head: { version_id: 'h', content_addr: 'peerd://p/h', size: 1 } } });

describe('dwapp library — the bounded discovery cache', () => {
  test('stores, and refuses a seq downgrade or duplicate', async () => {
    const lib = createLibrary();
    expect(lib.put('id1', card('pubA', 'chess', 2))).toBe(true);
    expect(lib.put('id1', card('pubA', 'chess', 2))).toBe(false); // duplicate seq
    expect(lib.put('id1', card('pubA', 'chess', 1))).toBe(false); // downgrade
    expect(lib.put('id1', card('pubA', 'chess', 3, 'Chess v2'))).toBe(true); // upgrade
    expect(lib.get('id1')!.value.name).toBe('Chess v2'); // just put id1 @ seq 3 → present
  });

  test('blocklist gates ingest and a purge clears a banned publisher', () => {
    const blocked = new Set<string>();
    const lib = createLibrary({ isBlocked: (d) => blocked.has(d) });
    lib.put('id1', card('evil', 'spam', 1));
    expect(lib.size()).toBe(1);
    blocked.add('evil');
    expect(lib.put('id2', card('evil', 'spam2', 1))).toBe(false); // blocked at ingest
    lib.purgePublisher('evil');
    expect(lib.size()).toBe(0);
  });

  test('eviction prefers zero-provider, oldest, never-installed entries', () => {
    let t = 1000;
    const lib = createLibrary({ cap: 2, now: () => t });
    t = 1; lib.put('old', card('p', 'old', 1));
    t = 2; lib.put('seeded', card('p', 'seeded', 1));
    lib.setProviders('seeded', 3);          // seeded has providers — protected
    t = 3;
    expect(lib.put('new', card('p', 'new', 1))).toBe(true); // evicts 'old' (zero-provider, oldest)
    expect(lib.has('old')).toBe(false);
    expect(lib.has('seeded')).toBe(true);
    expect(lib.has('new')).toBe(true);
  });

  test('an installed app is never evicted, even when full of cold cache', () => {
    let t = 0;
    const lib = createLibrary({ cap: 1, now: () => { t += 1; return t; } });
    lib.put('mine', card('p', 'mine', 1));
    lib.markInstalled('mine');
    // cache is full (cap 1) and the only entry is installed → a new cold card can't displace it
    expect(lib.put('other', card('p', 'other', 1))).toBe(false);
    expect(lib.has('mine')).toBe(true);
    expect(lib.has('other')).toBe(false);
  });

  test('list is newest-announced-first; rows expose the discovery view', () => {
    let t = 0;
    const lib = createLibrary({ now: () => { t += 1; return t; } });
    lib.put('a', card('p', 'a', 1));
    lib.put('b', card('p', 'b', 1));
    expect(lib.list()[0].salt).toBe('b'); // b announced after a
    const rows = lib.rows();
    expect(rows.find((r) => r.dwapp_id === 'a')?.name).toBe('a');
  });
});
