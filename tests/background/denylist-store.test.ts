import { describe, test, expect } from 'bun:test';
import {
  DenylistPolicyUnavailableError,
  makeDenylistStore,
  requireDenylistPolicy,
} from '../../extension/background/denylist-store.js';
import { matchesDenylist } from '../../extension/peerd-egress/denylist/denylist.js';

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
  test('tool contexts require a successfully loaded policy', () => {
    expect(requireDenylistPolicy({ ok: true })).toBeUndefined();
    expect(() => requireDenylistPolicy({ ok: false }))
      .toThrow(DenylistPolicyUnavailableError);
    expect(() => requireDenylistPolicy(undefined))
      .toThrow(DenylistPolicyUnavailableError);
  });

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
    expect(s.patterns()).toEqual(['a.com', 'x.com', '*.x.com']);
  });
  test('overlay read failures propagate instead of dropping stored user policy', async () => {
    const kv = { get: async () => { throw new Error('idb'); }, set: async () => {} };
    const s = freshStore(kv);
    await expect(s.load(['a.com'])).rejects.toThrow('idb');
    expect(s.patterns()).toEqual([]);
  });
  test('partial or non-string overlay schemas reject instead of being narrowed', async () => {
    for (const value of [
      { added: ['ok.com'] },
      { added: ['ok.com', 5], disabled: ['b.com'] },
    ]) {
      const s = freshStore(makeKv(value));
      await expect(s.load(['a.com', 'b.com']))
        .rejects.toThrow('denylist user overlay is malformed');
      expect(s.patterns()).toEqual([]);
    }
  });
});

describe('denylist-store — add', () => {
  test('adds a new user pattern (normalized), persists, marks non-seed', async () => {
    const kv = makeKv();
    const s = freshStore(kv);
    await s.load(['seed.com']);
    const r = await s.add('  Evil.COM ');
    expect(r).toEqual({ ok: true, pattern: 'evil.com', seed: false, patterns: ['evil.com', '*.evil.com'] });
    expect(s.patterns()).toEqual(['seed.com', 'evil.com', '*.evil.com']);
    expect(kv._peek()).toEqual({ added: ['evil.com'], disabled: [] });
  });
  test('re-enabling a disabled seed pattern removes it from disabled', async () => {
    const kv = makeKv({ added: [], disabled: ['seed.com'] });
    const s = freshStore(kv);
    await s.load(['seed.com']);
    expect(s.patterns()).toEqual([]); // disabled
    const r = await s.add('seed.com');
    expect(r).toEqual({ ok: true, pattern: 'seed.com', seed: true, patterns: ['seed.com'] });
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
  test('an unknown add write outcome keeps the stronger in-memory policy', async () => {
    const kv = { get: async () => undefined, set: async () => { throw new Error('unknown'); } };
    const s = freshStore(kv);
    await s.load(['seed.com']);
    await expect(s.add('blocked.com')).rejects.toThrow('unknown');
    expect(s.patterns()).toEqual(['seed.com', 'blocked.com', '*.blocked.com']);
  });

  test.each(['mybank.example', '*.mybank.example'])(
    'removing %s removes its derived pair after a reload', async (removed) => {
      const kv = makeKv({ added: ['mybank.example'], disabled: [] });
      const s = freshStore(kv);
      await s.load(['appleid.apple.com']);
      for (const host of ['mybank.example', 'www.mybank.example', 'secure.mybank.example']) {
        expect(matchesDenylist(host, s.patterns())).toBe(true);
      }
      for (const host of ['evilmybank.example', 'mybank.example.evil.test', 'x.appleid.apple.com']) {
        expect(matchesDenylist(host, s.patterns())).toBe(false);
      }
      expect(s.overlay().added).toEqual(['mybank.example', '*.mybank.example']);
      await s.remove(removed);
      await s.load(['appleid.apple.com']);
      expect(s.patterns()).toEqual(['appleid.apple.com']);
    },
  );

  test('an explicit wildcard remains independent of a user host', async () => {
    const s = freshStore();
    await s.load([]);
    await s.add('mybank.example');
    await s.add('*.mybank.example');
    await s.remove('mybank.example');
    expect(s.patterns()).toEqual(['*.mybank.example']);
    expect(matchesDenylist('mybank.example', s.patterns())).toBe(false);
    expect(matchesDenylist('secure.mybank.example', s.patterns())).toBe(true);
    await s.remove('*.mybank.example');
    expect(s.patterns()).toEqual([]);
  });

  test('a user host protects subdomains without erasing a disabled seed rule', async () => {
    const kv = makeKv({ added: [], disabled: ['*.mybank.example'] });
    const s = freshStore(kv);
    await s.load(['*.mybank.example']);
    await s.add('mybank.example');
    expect(matchesDenylist('secure.mybank.example', s.patterns())).toBe(true);
    expect(s.overlay().disabled).toEqual(['*.mybank.example']);
    await s.remove('*.mybank.example');
    expect(s.patterns()).toEqual([]);
    expect(s.overlay().disabled).toEqual(['*.mybank.example']);
  });
});

describe('denylist-store — remove', () => {
  test('removes a user-added pattern', async () => {
    const kv = makeKv({ added: ['x.com'], disabled: [] });
    const s = freshStore(kv);
    await s.load(['a.com']);
    const r = await s.remove('x.com');
    expect(r).toEqual({ ok: true, pattern: 'x.com', seed: false, patterns: ['x.com', '*.x.com'] });
    expect(s.patterns()).toEqual(['a.com']);
  });
  test('disables a seed pattern (masked, not deleted)', async () => {
    const s = freshStore();
    await s.load(['seed.com']);
    const r = await s.remove('seed.com');
    expect(r).toEqual({ ok: true, pattern: 'seed.com', seed: true, patterns: ['seed.com'] });
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
  test('a failed remove cannot roll back a later queued add', async () => {
    let refuse: (error: Error) => void = () => {};
    let writes = 0;
    const s = freshStore({
      get: async () => undefined,
      set: async () => {
        if (++writes === 1) await new Promise<void>((_resolve, reject) => { refuse = reject; });
      },
    });
    await s.load(['seed.com']);
    const removal = s.remove('seed.com');
    const added = s.add('private.example');
    void removal.catch(() => {});
    await Bun.sleep(0);
    expect(writes).toBe(1);
    refuse(new Error('unknown'));
    await expect(removal).rejects.toThrow('unknown');
    await added;
    expect(s.patterns()).toEqual(['seed.com', 'private.example', '*.private.example']);
  });

  test('an unknown remove write outcome keeps the stronger prior policy', async () => {
    const kv = { get: async () => undefined, set: async () => { throw new Error('unknown'); } };
    const s = freshStore(kv);
    await s.load(['seed.com']);
    await expect(s.remove('seed.com')).rejects.toThrow('unknown');
    expect(s.patterns()).toEqual(['seed.com']);
    expect(s.overlay()).toEqual({ added: [], disabled: [] });
  });
});
