// Contacts store — CRUD over an in-memory idb fake (keyPath: 'did').

import { describe, test, expect } from 'bun:test';

import { createContactsStore, InvalidDidError }
  from '../../../extension/peerd-runtime/contacts/store.js';

const DID = 'did:key:z6MkAAAAAAAAAAAAAAAAAAAA';

/** In-memory stand-in for the egress idb adapter, keyed by did (the store's keyPath). */
const fakeIdb = () => {
  const stores = new Map<string, Map<string, any>>();
  const s = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  return {
    get: async (store: string, key: string) => s(store).get(key),
    put: async (store: string, value: any) => { s(store).set(value.did, value); },
    getAll: async (store: string) => [...s(store).values()],
    del: async (store: string, key: string) => { s(store).delete(key); },
  };
};

describe('createContactsStore', () => {
  test('requires an idb adapter', () => {
    expect(() => createContactsStore({} as any)).toThrow(TypeError);
  });

  test('upsert creates on first touch, then patches without clobbering', async () => {
    let t = 100;
    const store = createContactsStore({ idb: fakeIdb(), now: () => t });

    const created = await store.upsert(DID, { name: 'Alice', notes: 'pal' });
    expect(created.did).toBe(DID);
    expect(created.name).toBe('Alice');
    expect(created.createdAt).toBe(100);

    t = 200;
    const renamed = await store.upsert(DID, { name: 'Alicia' });
    expect(renamed.name).toBe('Alicia');
    expect(renamed.notes).toBe('pal');        // untouched
    expect(renamed.createdAt).toBe(100);       // identity preserved
    expect(renamed.updatedAt).toBe(200);
  });

  test('upsert rejects a non-did key', async () => {
    const store = createContactsStore({ idb: fakeIdb() });
    await expect(store.upsert('not-a-did', { name: 'x' })).rejects.toBeInstanceOf(InvalidDidError);
  });

  test('list returns saved overlays; remove forgets one', async () => {
    const store = createContactsStore({ idb: fakeIdb(), now: () => 1 });
    await store.upsert(DID, { name: 'Alice' });
    expect((await store.list()).length).toBe(1);

    expect(await store.remove(DID)).toBe(true);
    expect(await store.remove(DID)).toBe(false); // already gone
    expect((await store.list()).length).toBe(0);
  });
});
