import { describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { createSessionTurnStore } from '../../../extension/shared/session-turn-store.js';
import { emptySummaryState } from '../../../extension/peerd-runtime/loop/rolling-summary.js';

type SessionIdb = {
  get: (store: string, key: string) => Promise<any>;
  getMany: (store: string, keys: string[]) => Promise<any[]>;
  mutate: (store: string, key: string, transform: (current: any) => any) => Promise<any>;
  put: (store: string, value: any) => Promise<void>;
};

type Backend = { idb: SessionIdb; close: () => void };

const makeMapBackend = async (): Promise<Backend> => {
  const stores = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    let value = stores.get(name);
    if (!value) { value = new Map(); stores.set(name, value); }
    return value;
  };
  return {
    idb: {
      get: async (store, key) => {
        const value = table(store).get(key);
        return value === undefined ? undefined : structuredClone(value);
      },
      getMany: async (store, keys) => keys.map((key) => {
        const value = table(store).get(key);
        return value === undefined ? undefined : structuredClone(value);
      }),
      put: async (store, value) => {
        table(store).set(value.id ?? value.sessionId, structuredClone(value));
      },
      mutate: async (store, key, transform) => {
        const current = table(store).get(key);
        if (current === undefined) return undefined;
        const updated = transform(structuredClone(current));
        table(store).set(key, structuredClone(updated));
        return structuredClone(updated);
      },
    },
    close: () => {},
  };
};

const makeIndexedDbBackend = async (): Promise<Backend> => {
  const indexedDB = new IDBFactory();
  const request = indexedDB.open('session-turn-store', 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('sessions', { keyPath: 'sessionId' });
    request.result.createObjectStore('session_messages', { keyPath: 'id' });
  };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as unknown as IDBDatabase);
    request.onerror = () => reject(request.error);
  });

  const get = <T>(store: string, key: string) => new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const read = tx.objectStore(store).get(key);
    let value: T | undefined;
    read.onsuccess = () => { value = read.result; };
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const put = (store: string, value: any) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  return {
    idb: {
      get,
      getMany: (store, keys) => Promise.all(keys.map((key) => get(store, key))),
      put,
      mutate: (store, key, transform) => new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const objectStore = tx.objectStore(store);
        const read = objectStore.get(key);
        let updated: any;
        read.onsuccess = () => {
          try {
            if (read.result === undefined) return;
            updated = transform(read.result);
            objectStore.put(updated);
          } catch (cause) { tx.abort(); reject(cause); }
        };
        tx.oncomplete = () => resolve(updated);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
    },
    close: () => db.close(),
  };
};

test('an external metadata patch between append read and commit is preserved', async () => {
  const backend = await makeMapBackend();
  const base = backend.idb;
  await base.put('sessions', {
    sessionId: 'race', createdAt: 1, messagesV2: true, msgIndex: [],
    messageCount: 0, lastMessageAt: 1, model: 'old', permissionMode: 'act',
  });
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const messageWrite = new Promise<void>((resolve) => { entered = resolve; });
  const idb = {
    ...base,
    put: async (store: string, value: any) => {
      await base.put(store, value);
      if (store === 'session_messages') { entered(); await blocked; }
    },
  };
  const turns = createSessionTurnStore({
    idb,
    notFound: (sessionId) => new Error(`missing:${sessionId}`),
  });
  const append = turns.appendMessage('race', {
    id: 'message-1', role: 'user', content: 'hello', when: 2,
  });
  await messageWrite;
  await base.mutate('sessions', 'race', (row) => ({
    ...row, model: 'new', permissionMode: 'plan', confirmActions: true,
  }));
  release();
  await append;
  expect(await base.get('sessions', 'race')).toMatchObject({
    model: 'new', permissionMode: 'plan', confirmActions: true,
    msgIndex: ['message-1'], messageCount: 1, lastMessageAt: 2,
  });
  backend.close();
});

const exerciseTurnStore = async (backend: Backend) => {
  const { idb } = backend;
  const turns = createSessionTurnStore({
    idb,
    notFound: (sessionId) => new Error(`missing:${sessionId}`),
  });
  await idb.put('sessions', {
    sessionId: 'legacy', createdAt: 1, provider: 'anthropic', model: 'm',
    messages: [{ id: 'legacy-user', role: 'user', content: 'before', when: 1 }],
  });

  await Promise.all([
    turns.appendMessage('legacy', {
      id: 'concurrent-user', role: 'user', content: 'first', when: 2,
    }),
    turns.appendMessage('legacy', {
      id: 'concurrent-assistant', role: 'assistant', content: 'second', when: 3,
    }),
  ]);

  const migrated = await idb.get('sessions', 'legacy');
  expect(migrated).toMatchObject({
    messagesV2: true,
    msgIndex: ['legacy-user', 'concurrent-user', 'concurrent-assistant'],
  });
  expect(migrated.messages).toBeUndefined();
  expect((await turns.get('legacy'))!.messages.map((message: any) => message.id)).toEqual([
    'legacy-user', 'concurrent-user', 'concurrent-assistant',
  ]);

  await turns.appendMessage('legacy', {
    id: 'concurrent-user', role: 'user', content: 'must not replace', when: 99,
  });
  expect((await idb.get('session_messages', 'concurrent-user')).message).toMatchObject({
    content: 'first', when: 2,
  });
  expect((await idb.get('sessions', 'legacy')).msgIndex).toEqual([
    'legacy-user', 'concurrent-user', 'concurrent-assistant',
  ]);

  await turns.appendMessage('legacy', {
    id: 'streaming', role: 'assistant', content: '', streaming: true, when: 4,
  });
  const sessionBeforePatch = await idb.get('sessions', 'legacy');
  await turns.updateAssistantMessage('legacy', 'streaming', {
    content: 'complete', streaming: false, stopReason: 'end_turn',
  });
  expect(await idb.get('sessions', 'legacy')).toEqual(sessionBeforePatch);
  expect((await idb.get('session_messages', 'streaming')).message).toMatchObject({
    content: 'complete', streaming: false, stopReason: 'end_turn',
  });

  const trimSummary = {
    ...emptySummaryState(), task: 'older context', coveredLastId: 'concurrent-user',
  };
  await Promise.all([
    turns.setTrimSummary('legacy', trimSummary),
    turns.appendMessage('legacy', {
      id: 'after-trim', role: 'assistant', content: 'kept', when: 5,
    }),
  ]);
  const settled = await turns.get('legacy');
  expect(settled!.trimSummary).toEqual(trimSummary);
  expect(settled!.messages.map((message: any) => message.id)).toEqual([
    'legacy-user', 'concurrent-user', 'concurrent-assistant', 'streaming', 'after-trim',
  ]);
};

describe('shared turn-session store parity', () => {
  for (const [name, makeBackend] of [
    ['map fake', makeMapBackend],
    ['IndexedDB transactions', makeIndexedDbBackend],
  ] as const) {
    test(`${name}: migration and concurrent turn writes settle identically`, async () => {
      const backend = await makeBackend();
      try { await exerciseTurnStore(backend); }
      finally { backend.close(); }
    });
  }
});
