import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { createSessionStore } from '../../extension/peerd-runtime/sessions/store.js';

let idb: typeof import('../../extension/peerd-egress/storage/idb.js');
let database: IDBDatabase | undefined;
let originalFactory: IDBFactory;
const request = <T>(operation: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  operation.onsuccess = () => resolve(operation.result);
  operation.onerror = () => reject(operation.error);
});
const seed = async (name: string, version: number, store = 'marker') => {
  const opening = indexedDB.open(name, version);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore(store, { keyPath: 'key' }).put({ key: 'saved', value: name });
    if (name === 'peerd') {
      opening.result.createObjectStore('sessions', { keyPath: 'sessionId' });
      opening.result.createObjectStore('session_messages', { keyPath: 'id' });
    }
  };
  (await request(opening)).close();
};

beforeEach(async () => {
  originalFactory = globalThis.indexedDB;
  globalThis.indexedDB = new IDBFactory();
  idb = await import(`../../extension/peerd-egress/storage/idb.js?case=${crypto.randomUUID()}`);
});
afterEach(() => {
  database?.close();
  database = undefined;
  globalThis.indexedDB = originalFactory;
});

describe('IndexedDB version compatibility', () => {
  test('creates version 13 and preserves standalone saved data', async () => {
    const names = ['peerd-toolbox', 'peerd-run-cache', 'peerd-checkpoints', 'peerd-skills'];
    await Promise.all(names.map((name) => seed(name, 1)));
    database = await idb.openDB();
    expect(database.version).toBe(13);
    expect(database.objectStoreNames.contains('web_extract_cache')).toBe(true);
    for (const name of names) {
      const saved = await request(indexedDB.open(name));
      expect(await request(saved.transaction('marker').objectStore('marker').get('saved')))
        .toEqual({ key: 'saved', value: name });
      saved.close();
    }
  });

  test('keeps version 13 readable by old code after a new chat write', async () => {
    await seed('peerd', 13, 'web_extract_cache');
    database = await idb.openDB();
    const sessions = createSessionStore({ idb });
    const session = await sessions.create();
    await sessions.appendMessage(session.sessionId, { id: 'message', when: 1, role: 'user', content: 'Keep this chat.' });
    database.close();
    database = await request(indexedDB.open('peerd', 13));
    expect(database.version).toBe(13);
    expect(await request(database.transaction('sessions').objectStore('sessions').get(session.sessionId)))
      .toMatchObject({ sessionId: session.sessionId, msgIndex: ['message'], messageCount: 1 });
    expect(await request(database.transaction('session_messages').objectStore('session_messages').get('message')))
      .toMatchObject({ message: { role: 'user', content: 'Keep this chat.' } });
    expect(await request(database.transaction('web_extract_cache').objectStore('web_extract_cache').get('saved')))
      .toEqual({ key: 'saved', value: 'peerd' });
  });

  test('opens existing version 14 without changing saved data or stores', async () => {
    await seed('peerd', 14);
    database = await idb.openDB();
    expect(database.version).toBe(14);
    expect([...database.objectStoreNames]).toEqual(['marker', 'session_messages', 'sessions']);
    expect(await idb.get('marker', 'saved')).toEqual({ key: 'saved', value: 'peerd' });
    await idb.put('sessions', { sessionId: 'chat' });
    expect(await idb.get('sessions', 'chat')).toEqual({ sessionId: 'chat' });
  });

  test('rejects a future version and preserves its data', async () => {
    await seed('peerd', 15);
    await expect(idb.openDB()).rejects.toMatchObject({ name: 'VersionError' });
    database = await request(indexedDB.open('peerd', 15));
    expect(await request(database.transaction('marker').objectStore('marker').get('saved')))
      .toEqual({ key: 'saved', value: 'peerd' });
  });
});
