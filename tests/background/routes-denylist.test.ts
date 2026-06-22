import { describe, test, expect } from 'bun:test';
import { makeDenylistRoutes } from '../../extension/background/routes/denylist.js';

// The denylist routes are thin over the store now — pin that they audit with the
// right type + seed flag and return the { patterns, added, disabled } snapshot,
// and that an error from the store passes through without an audit.

const makeDeps = (over: any = {}) => {
  const audits: any[] = [];
  const deps = {
    denylistStore: {
      patterns: () => ['a.com'],
      overlay: () => ({ added: ['x.com'], disabled: ['b.com'] }),
      add: async () => ({ ok: true, pattern: 'x.com', seed: false }),
      remove: async () => ({ ok: true, pattern: 'b.com', seed: true }),
      ...over.denylistStore,
    },
    auditLog: { append: async (e: any) => { audits.push(e); } },
  };
  return { deps, audits };
};

describe('denylist routes', () => {
  test('list returns the snapshot', async () => {
    const { deps } = makeDeps();
    expect(await makeDenylistRoutes(deps)['denylist/list']())
      .toEqual({ ok: true, patterns: ['a.com'], added: ['x.com'], disabled: ['b.com'] });
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
});
