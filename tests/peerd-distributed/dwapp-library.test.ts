import { describe, test, expect } from 'bun:test';
import { createLibrary, CONTRIBUTION_TTL_MS, MAX_RECENT_CONTRIBUTORS } from '../../extension/peerd-distributed/apps/library.js';

// A minimal verified-card stand-in (the Library never re-verifies; discovery.js
// does, then hands it the derived id). Shape matches a signItem result.
const card = (publisher: string, slug: string, seq: number, name = slug) =>
  ({ publisher, salt: slug, seq, sig: 'x', value: { name, description: '', head: { version_id: 'a'.repeat(64), content_addr: `peerd://${publisher}/${'a'.repeat(64)}`, size: 1 } } });

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
    t = 1; lib.put('seeded', card('did:key:p', 'seeded', 1));
    t = 2; lib.put('old', card('did:key:other', 'old', 1));
    lib.observeContributors('did:key:p', 'a'.repeat(64), ['peer']);          // seeded has providers; protected
    t = 3;
    expect(lib.put('new', card('did:key:p', 'new', 1))).toBe(true); // evicts unobserved 'old' despite seeded being older
    expect(lib.has('old')).toBe(false);
    expect(lib.has('seeded')).toBe(true);
    expect(lib.has('new')).toBe(true);
  });

  test('an installed app is never evicted, even when full of cold cache', () => {
    let t = 0;
    const lib = createLibrary({ cap: 1, now: () => { t += 1; return t; } });
    lib.put('mine', card('did:key:p', 'mine', 1));
    lib.markInstalled('mine');
    // cache is full (cap 1) and the only entry is installed → a new cold card can't displace it
    expect(lib.put('other', card('did:key:p', 'other', 1))).toBe(false);
    expect(lib.has('mine')).toBe(true);
    expect(lib.has('other')).toBe(false);
  });

  test('list is newest-announced-first; rows expose the discovery view', () => {
    let t = 0;
    const lib = createLibrary({ now: () => { t += 1; return t; } });
    lib.put('a', card('did:key:p', 'a', 1));
    lib.put('b', card('did:key:p', 'b', 1));
    expect(lib.list()[0].salt).toBe('b'); // b announced after a
    const rows = lib.rows();
    expect(rows.find((r) => r.dwapp_id === 'a')?.name).toBe('a');
  });
});


describe('local verified contribution evidence', () => {
  test('exact version and authored URI binding; newer versions reset history', () => {
    const lib = createLibrary();
    lib.put('app', card('did:key:p', 'app', 1));
    lib.observeContributors('did:key:other', 'a'.repeat(64), ['peer']);
    lib.observeContributors('did:key:p', 'b'.repeat(64), ['peer']);
    expect(lib.rows()[0].providers).toBe(0);
    lib.observeContributors('did:key:p', 'a'.repeat(64), ['peer', 'peer']);
    expect(lib.rows()[0].providers).toBe(1);
    lib.put('app', card('did:key:p', 'app', 2));
    expect(lib.rows()[0].providers).toBe(1);
    const next = card('did:key:p', 'app', 3);
    next.value.head.version_id = 'b'.repeat(64);
    next.value.head.content_addr = `peerd://did:key:p/${'b'.repeat(64)}`;
    lib.put('app', next);
    expect(lib.rows()[0].providers).toBe(0);
    lib.observeContributors('did:key:p', 'a'.repeat(64), ['peer']);
    expect(lib.rows()[0].providers).toBe(0);
  });

  test('rejects mismatched or path-bearing metadata without creating catalog entries', () => {
    const lib = createLibrary();
    lib.observeContributors('did:key:p', 'a'.repeat(64), ['peer']);
    expect(lib.size()).toBe(0);
    for (const address of ['garbage', `peerd://did:key:other/${'a'.repeat(64)}`, `peerd://did:key:p/${'a'.repeat(64)}/`]) {
      const row = card('did:key:p', address, 1);
      row.value.head.content_addr = address;
      lib.put(address, row);
    }
    lib.observeContributors('did:key:p', 'a'.repeat(64), ['peer']);
    expect(lib.rows().every((row) => row.providers === 0)).toBe(true);
  });

  test('expires on reads and eviction; handles clock rollback and caps unique peers', () => {
    let clock = 100;
    const lib = createLibrary({ cap: 2, now: () => clock });
    lib.put('old', card('did:key:p', 'old', 1));
    lib.observeContributors('did:key:p', 'a'.repeat(64), Array.from({ length: 50 }, (_, i) => `peer${i}`));
    expect(lib.rows()[0].providers).toBe(MAX_RECENT_CONTRIBUTORS);
    clock += 1;
    lib.put('new', card('did:key:p', 'new', 1));
    clock += CONTRIBUTION_TTL_MS;
    lib.put('replacement', card('did:key:p', 'replacement', 1));
    expect(lib.has('old')).toBe(false);
    lib.observeContributors('did:key:p', 'a'.repeat(64), ['peer']);
    clock -= 1;
    expect(lib.rows().every((row) => row.providers === 0)).toBe(true);
    lib.observeContributors('did:key:p', 'a'.repeat(64), ['peer']);
    clock += CONTRIBUTION_TTL_MS;
    expect(lib.rows().every((row) => row.providers === 0)).toBe(true);
  });

  test('bans purge contributor evidence on other publishers; policy and close clear it', () => {
    const blocked = new Set<string>();
    const lib = createLibrary({ isBlocked: (did) => blocked.has(did) });
    lib.put('app', card('did:key:p', 'app', 1));
    lib.observeContributors('did:key:p', 'a'.repeat(64), ['peer', 'other']);
    lib.purgePublisher('peer');
    expect(lib.rows()[0].providers).toBe(1);
    blocked.add('other');
    expect(lib.rows()[0].providers).toBe(0);
    lib.observeContributors('did:key:p', 'a'.repeat(64), ['other']);
    expect(lib.rows()[0].providers).toBe(0);
    lib.observeContributors('did:key:p', 'a'.repeat(64), ['peer']);
    lib.clearContributors();
    expect(lib.rows()[0].providers).toBe(0);
  });
});
