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

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

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
  test('a cold-worker write waits for hydration and preserves existing settings', async () => {
    const read = deferred<any>();
    const writes: any[] = [];
    const kv = {
      get: () => read.promise,
      set: async (_key: string, value: any) => { writes.push({ ...value }); },
    };
    const s = store(kv);
    const loading = s.load();
    const updating = s.update({ a: 10 });
    await Promise.resolve();
    expect(writes).toEqual([]);

    read.resolve({ b: 20 });
    await Promise.all([loading, updating]);
    expect(s.stored()).toEqual({ a: 10, b: 20 });
    expect(writes).toEqual([{ a: 10, b: 20 }]);
  });
  test('concurrent mutations persist in call order even when storage is slow', async () => {
    const firstWrite = deferred<void>();
    const writes: any[] = [];
    const kv = {
      get: async () => ({ c: 30 }),
      set: async (_key: string, value: any) => {
        writes.push({ ...value });
        if (writes.length === 1) await firstWrite.promise;
      },
    };
    const s = store(kv);
    await s.load();
    const first = s.update({ a: 10 });
    const second = s.update({ b: 20 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toEqual([{ a: 10, c: 30 }]);

    firstWrite.resolve();
    await Promise.all([first, second]);
    expect(writes).toEqual([
      { a: 10, c: 30 },
      { a: 10, b: 20, c: 30 },
    ]);
    expect(s.stored()).toEqual({ a: 10, b: 20, c: 30 });
  });
  test('a failed hydration is retried before the next mutation', async () => {
    let reads = 0;
    const writes: any[] = [];
    const kv = {
      get: async () => {
        reads += 1;
        if (reads === 1) throw new Error('temporary storage failure');
        return { b: 20 };
      },
      set: async (_key: string, value: any) => { writes.push({ ...value }); },
    };
    const s = store(kv);
    await expect(s.load()).rejects.toThrow('temporary storage failure');
    await s.update({ a: 10 });
    expect(reads).toBe(2);
    expect(writes).toEqual([{ a: 10, b: 20 }]);
  });
  test('a rejected persistence write does not leak into memory or a later write', async () => {
    let writes = 0;
    const saved: any[] = [];
    const kv = {
      get: async () => ({ b: 20 }),
      set: async (_key: string, value: any) => {
        writes += 1;
        if (writes === 1) throw new Error('disk full');
        saved.push({ ...value });
      },
    };
    const s = store(kv);
    await s.load();
    await expect(s.update({ a: 10 })).rejects.toThrow('disk full');
    expect(s.get()).toEqual({ a: 1, b: 20, c: 3 });
    expect(s.stored()).toEqual({ b: 20 });

    await s.update({ c: 30 });
    expect(saved).toEqual([{ b: 20, c: 30 }]);
    expect(s.stored()).toEqual({ b: 20, c: 30 });
  });
});
