import { describe, test, expect } from 'bun:test';
import { makeSettingsStore } from '../../extension/background/settings-store.js';

// Pins the Option A migration semantics that used to live inline as let
// settings/storedSettings: stored holds only user-set keys, merged overlays
// defaults, reset FORGETS (so the key tracks the channel default again).

const makeKv = (initial: any = undefined) => {
  let v: any = initial;
  return { get: async () => v, set: async (_k: string, val: any) => { v = val; }, _peek: () => v };
};

const defaults = { a: 1, b: 2, c: 3 };
const store = (kv: any = makeKv()) => makeSettingsStore({ kv, key: 'settings.v1', defaults });

describe('settings-store', () => {
  test('get() is defaults before load', () => {
    expect(store().get()).toEqual(defaults);
  });
  test('load merges stored over defaults; stored() is user-set only', async () => {
    const s = store(makeKv({ b: 20 }));
    await s.load();
    expect(s.get()).toEqual({ a: 1, b: 20, c: 3 });
    expect(s.stored()).toEqual({ b: 20 });
  });
  test('load ignores a non-object stored blob', async () => {
    const s = store(makeKv('garbage'));
    await s.load();
    expect(s.get()).toEqual(defaults);
  });
  test('update merges, persists only user-set keys, returns merged', async () => {
    const kv = makeKv();
    const s = store(kv);
    await s.load();
    const merged = await s.update({ a: 10 });
    expect(merged).toEqual({ a: 10, b: 2, c: 3 });
    expect(s.stored()).toEqual({ a: 10 });
    expect(kv._peek()).toEqual({ a: 10 }); // defaults never persisted
  });
  test('update is cumulative across calls', async () => {
    const s = store();
    await s.update({ a: 10 });
    await s.update({ b: 20 });
    expect(s.stored()).toEqual({ a: 10, b: 20 });
  });
  test('reset FORGETS keys so they track the default again', async () => {
    const kv = makeKv({ a: 10, b: 20 });
    const s = store(kv);
    await s.load();
    await s.reset(['a']);
    expect(s.get()).toEqual({ a: 1, b: 20, c: 3 }); // a back to default
    expect(s.stored()).toEqual({ b: 20 });
    expect(kv._peek()).toEqual({ b: 20 });
  });
  test('a stored key equal to its default still persists verbatim (Option A)', async () => {
    const s = store(makeKv({ a: 1 })); // equals default
    await s.load();
    expect(s.stored()).toEqual({ a: 1 }); // honored verbatim, not dropped
  });
});
