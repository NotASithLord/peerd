import { describe, test, expect } from 'bun:test';
import { createCommandStore, isValidCommandName } from '../../../extension/peerd-runtime/composer/command-store.js';

// In-memory KV matching the project's KV shape (get/set/delete/list).
const makeKV = () => {
  const m = new Map<string, any>();
  return {
    get: async (k: string) => m.get(k),
    set: async (k: string, v: any) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
    list: async (prefix?: string) => {
      const out: Record<string, any> = {};
      for (const [k, v] of m) if (!prefix || k.startsWith(prefix)) out[k] = v;
      return out;
    },
    clear: async () => { m.clear(); },
  };
};

describe('isValidCommandName', () => {
  test('accepts kebab/word names, rejects junk', () => {
    expect(isValidCommandName('review')).toBe(true);
    expect(isValidCommandName('run-tests')).toBe(true);
    expect(isValidCommandName('/review')).toBe(false);
    expect(isValidCommandName('has space')).toBe(false);
    expect(isValidCommandName('')).toBe(false);
  });
});

describe('createCommandStore', () => {
  test('put then get round-trips the body', async () => {
    const store = createCommandStore({ kv: makeKV(), now: () => 123 });
    await store.put({ name: 'review', body: 'Review the code.', description: 'code review' });
    const got = await store.get('review');
    expect(got).toMatchObject({ name: 'review', body: 'Review the code.', updatedAt: 123 });
  });
  test('list returns name-sorted records', async () => {
    const store = createCommandStore({ kv: makeKV() });
    await store.put({ name: 'zeta', body: 'z' });
    await store.put({ name: 'alpha', body: 'a' });
    const names = (await store.list()).map((r) => r.name);
    expect(names).toEqual(['alpha', 'zeta']);
  });
  test('remove is idempotent', async () => {
    const store = createCommandStore({ kv: makeKV() });
    await store.put({ name: 'x', body: 'x' });
    await store.remove('x');
    await store.remove('x');
    expect(await store.get('x')).toBeNull();
  });
  test('rejects an invalid name on put', async () => {
    const store = createCommandStore({ kv: makeKV() });
    await expect(store.put({ name: 'bad name', body: 'b' })).rejects.toThrow();
  });
});
