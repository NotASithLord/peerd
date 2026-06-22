import { describe, test, expect } from 'bun:test';
import { makeDenylistStore } from '../../extension/background/denylist-store.js';

// The effective-list math (seed − disabled ∪ added) + the add/remove/re-enable
// transitions used to live inline in the SW with no coverage. These pin them.

const normalize = (raw: unknown) => (typeof raw === 'string' ? raw.trim().toLowerCase() : '');

const makeKv = (initial: any = undefined) => {
  let store: any = initial;
  return { get: async () => store, set: async (_k: string, v: any) => { store = v; }, _peek: () => store };
};

const freshStore = (kv: any = makeKv()) =>
  makeDenylistStore({ kv, key: 'denylist.user.v1', normalizePattern: normalize });

describe('denylist-store — load + recompute', () => {
  test('effective = seed when no overlay', async () => {
    const s = freshStore();
    await s.load(['a.com', 'b.com']);
    expect(s.patterns()).toEqual(['a.com', 'b.com']);
    expect(s.overlay()).toEqual({ added: [], disabled: [] });
  });
  test('disabled seed entries are subtracted; added are appended', async () => {
    const kv = makeKv({ added: ['x.com'], disabled: ['b.com'] });
    const s = freshStore(kv);
    await s.load(['a.com', 'b.com']);
    expect(s.patterns()).toEqual(['a.com', 'x.com']);
  });
  test('load fails open to empty overlay when kv throws', async () => {
    const kv = { get: async () => { throw new Error('idb'); }, set: async () => {} };
    const s = freshStore(kv);
    await s.load(['a.com']); // must not reject
    expect(s.patterns()).toEqual(['a.com']);
  });
  test('non-string overlay entries are filtered out', async () => {
    const kv = makeKv({ added: ['ok.com', 5, null], disabled: [{}, 'b.com'] });
    const s = freshStore(kv);
    await s.load(['a.com', 'b.com']);
    expect(s.overlay()).toEqual({ added: ['ok.com'], disabled: ['b.com'] });
  });
});

describe('denylist-store — add', () => {
  test('adds a new user pattern (normalized), persists, marks non-seed', async () => {
    const kv = makeKv();
    const s = freshStore(kv);
    await s.load(['seed.com']);
    const r = await s.add('  Evil.COM ');
    expect(r).toEqual({ ok: true, pattern: 'evil.com', seed: false });
    expect(s.patterns()).toEqual(['seed.com', 'evil.com']);
    expect(kv._peek()).toEqual({ added: ['evil.com'], disabled: [] });
  });
  test('re-enabling a disabled seed pattern removes it from disabled', async () => {
    const kv = makeKv({ added: [], disabled: ['seed.com'] });
    const s = freshStore(kv);
    await s.load(['seed.com']);
    expect(s.patterns()).toEqual([]); // disabled
    const r = await s.add('seed.com');
    expect(r).toEqual({ ok: true, pattern: 'seed.com', seed: true });
    expect(s.patterns()).toEqual(['seed.com']);
  });
  test('invalid pattern rejected, no persist', async () => {
    const kv = makeKv();
    const s = freshStore(kv);
    await s.load(['a.com']);
    expect(await s.add(123)).toEqual({ ok: false, error: 'invalid-pattern' });
    expect(kv._peek()).toBeUndefined();
  });
  test('adding an existing seed pattern is a no-op add (not duplicated)', async () => {
    const s = freshStore();
    await s.load(['seed.com']);
    await s.add('seed.com');
    expect(s.overlay().added).toEqual([]);
    expect(s.patterns()).toEqual(['seed.com']);
  });
});

describe('denylist-store — remove', () => {
  test('removes a user-added pattern', async () => {
    const kv = makeKv({ added: ['x.com'], disabled: [] });
    const s = freshStore(kv);
    await s.load(['a.com']);
    const r = await s.remove('x.com');
    expect(r).toEqual({ ok: true, pattern: 'x.com', seed: false });
    expect(s.patterns()).toEqual(['a.com']);
  });
  test('disables a seed pattern (masked, not deleted)', async () => {
    const s = freshStore();
    await s.load(['seed.com']);
    const r = await s.remove('seed.com');
    expect(r).toEqual({ ok: true, pattern: 'seed.com', seed: true });
    expect(s.patterns()).toEqual([]);
    expect(s.overlay().disabled).toEqual(['seed.com']);
  });
  test('removing an unknown pattern → not-found', async () => {
    const s = freshStore();
    await s.load(['a.com']);
    expect(await s.remove('ghost.com')).toEqual({ ok: false, error: 'not-found' });
  });
  test('removing an already-disabled seed → not-found (no double disable)', async () => {
    const kv = makeKv({ added: [], disabled: ['seed.com'] });
    const s = freshStore(kv);
    await s.load(['seed.com']);
    expect(await s.remove('seed.com')).toEqual({ ok: false, error: 'not-found' });
  });
});
