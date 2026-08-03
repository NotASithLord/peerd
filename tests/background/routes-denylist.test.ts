import { describe, test, expect } from 'bun:test';
import { makeDenylistRoutes } from '../../extension/background/routes/denylist.js';

// The denylist routes are thin over the store now — pin that they audit with the
// right type + seed flag and return the { patterns, added, disabled } snapshot,
// and that an error from the store passes through without an audit.

const makeDeps = (over: any = {}) => {
  const audits: any[] = [];
  const syncs: boolean[] = [];
  const deps = {
    denylistStore: {
      patterns: () => ['a.com'],
      overlay: () => ({ added: ['x.com'], disabled: ['b.com'] }),
      add: async () => ({ ok: true, pattern: 'x.com', seed: false }),
      remove: async () => ({ ok: true, pattern: 'b.com', seed: true }),
      ...over.denylistStore,
    },
    auditLog: { append: async (e: any) => { audits.push(e); } },
    // The seed's curated taxonomy, carried read-only so the settings list can group.
    getSeedCategories: () => ({ banks_us: ['a.com'], health_us: ['b.com'] }),
    // The DNR backstop's resync — an edit changes what the rule blocks.
    denylistNetGuard: { sync: () => { syncs.push(true); } },
  };
  return { deps, audits, syncs };
};

describe('denylist routes', () => {
  test('list returns the snapshot', async () => {
    const { deps } = makeDeps();
    expect(await makeDenylistRoutes(deps)['denylist/list']())
      .toEqual({
        ok: true,
        patterns: ['a.com'],
        added: ['x.com'],
        disabled: ['b.com'],
        categories: { banks_us: ['a.com'], health_us: ['b.com'] },
      });
  });

  test('add audits denylist_added with the seed flag + returns snapshot', async () => {
    const { deps, audits } = makeDeps();
    const res = await makeDenylistRoutes(deps)['denylist/add']({ pattern: 'x.com' });
    expect(res.ok).toBe(true);
    expect(audits).toEqual([{ type: 'denylist_added', details: { pattern: 'x.com', seed: false } }]);
  });

  test('add passes a store error through without auditing', async () => {
    const { deps, audits } = makeDeps({ denylistStore: { add: async () => ({ ok: false, error: 'invalid-pattern' }) } });
    expect(await makeDenylistRoutes(deps)['denylist/add']({ pattern: '' })).toEqual({ ok: false, error: 'invalid-pattern' });
    expect(audits).toEqual([]);
  });

  test('remove audits denylist_removed with seed=true for a seed pattern', async () => {
    const { deps, audits } = makeDeps();
    await makeDenylistRoutes(deps)['denylist/remove']({ pattern: 'b.com' });
    expect(audits).toEqual([{ type: 'denylist_removed', details: { pattern: 'b.com', seed: true } }]);
  });

  test('remove not-found passes through without auditing', async () => {
    const { deps, audits } = makeDeps({ denylistStore: { remove: async () => ({ ok: false, error: 'not-found' }) } });
    expect(await makeDenylistRoutes(deps)['denylist/remove']({ pattern: 'ghost' })).toEqual({ ok: false, error: 'not-found' });
    expect(audits).toEqual([]);
  });

  // The DNR backstop's rule is derived from the list, so an accepted edit has to
  // resync it — the remove path especially, where a stale rule would keep
  // blocking a site the user just unblocked.
  test('an accepted add or remove resyncs the network backstop', async () => {
    const { deps, syncs } = makeDeps();
    await makeDenylistRoutes(deps)['denylist/add']({ pattern: 'x.com' });
    await makeDenylistRoutes(deps)['denylist/remove']({ pattern: 'b.com' });
    expect(syncs).toHaveLength(2);
  });

  test('a rejected edit does not resync', async () => {
    const { deps, syncs } = makeDeps({ denylistStore: { add: async () => ({ ok: false, error: 'invalid-pattern' }) } });
    await makeDenylistRoutes(deps)['denylist/add']({ pattern: '' });
    expect(syncs).toEqual([]);
  });
});

describe('denylist routes carry the seed taxonomy', () => {
  test('categories ride every snapshot, not just list', async () => {
    // The settings list groups by these; a mutation reply is what the view
    // re-renders from, so a reply without them would collapse the groups.
    const { deps } = makeDeps();
    const routes = makeDenylistRoutes(deps);
    for (const call of [routes['denylist/list'](), routes['denylist/add']({ pattern: 'x.com' })]) {
      expect((await call).categories).toEqual({ banks_us: ['a.com'], health_us: ['b.com'] });
    }
  });

  test('an unwired category source degrades to no grouping, never a crash', async () => {
    // Pre-hydration (or a seed fetch that failed) must render the flat list, not throw.
    const { deps } = makeDeps();
    const r = await makeDenylistRoutes({ ...deps, getSeedCategories: undefined })['denylist/list']();
    expect(r.ok).toBe(true);
    expect(r.categories).toEqual({});
  });
});
