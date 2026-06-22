// Snapshot store + capture/diff coverage — the persistence half of
// feature 02. Uses an in-memory StoreIO and an in-memory workspace so the
// manager logic is exercised without a browser, plus one case over the
// real IDB path via fake-indexeddb to prove the browser store wires up.

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createSnapshotStore,
} from '../../../extension/peerd-runtime/edit/snapshot-store.js';
import {
  createCheckpointManager,
} from '../../../extension/peerd-runtime/edit/checkpoint.js';

// --- in-memory StoreIO (keyed by store name → Map) ----------------------
const memIO = () => {
  const stores: Record<string, Map<string, any>> = { blobs: new Map(), checkpoints: new Map() };
  const keyOf = (store: string, value: any) => (store === 'blobs' ? value.hash : value.id);
  return {
    get: async (store: string, key: any) => stores[store].get(key) ?? undefined,
    getAll: async (store: string) => [...stores[store].values()],
    put: async (store: string, value: any) => { stores[store].set(keyOf(store, value), value); },
    del: async (store: string, key: any) => { stores[store].delete(key); },
    _stores: stores,
  };
};

// --- in-memory workspace mirroring the OPFS adapter shape ---------------
const memWorkspace = (initial: Record<string, string> = {}) => {
  const files = new Map(Object.entries(initial));
  return {
    files,
    adapter: {
      readAll: async () => Object.fromEntries(files),
      writeFile: async (path: string, content: string) => { files.set(path, content); },
      deleteFile: async (path: string) => { files.delete(path); },
    },
  };
};

describe('snapshot store — content addressing', () => {
  test('identical content dedups to one blob across two captures', async () => {
    const io = memIO();
    const store = createSnapshotStore(io);
    await store.capture({ scope: 's', files: { 'a.txt': 'same', 'b.txt': 'same' } });
    await store.capture({ scope: 's', files: { 'c.txt': 'same' } });
    // Three file references, all the same content → exactly one blob.
    expect(io._stores.blobs.size).toBe(1);
  });

  test('materialize reconstructs the exact file map', async () => {
    const store = createSnapshotStore(memIO());
    const cp = await store.capture({ scope: 's', files: { 'x': '1', 'y': '2' } });
    expect(await store.materialize(cp.id)).toEqual({ x: '1', y: '2' });
  });
});

describe('checkpoint manager — capture chain', () => {
  let now: number;
  const clock = () => now++;

  beforeEach(() => { now = 1_000; });

  const build = (initial: Record<string, string>) => {
    const ws = memWorkspace(initial);
    const store = createSnapshotStore(memIO(), clock);
    const mgr = createCheckpointManager({
      store,
      workspaceFor: (scope) => (scope === 'app:1' ? ws.adapter : null),
      now: clock,
    });
    return { ws, store, mgr };
  };

  test('auto-capture dedups an unchanged turn (no new checkpoint)', async () => {
    const { mgr, store } = build({ 'f': 'a' });
    await mgr.capture({ scope: 'app:1' });
    await mgr.capture({ scope: 'app:1' });           // nothing changed
    expect((await store.list('app:1')).length).toBe(1);
  });

});

describe('browser snapshot store over fake-indexeddb', () => {
  test('capture + materialize through the real IDB path', async () => {
    const { useFakeIndexedDB } = await import('../../setup.ts');
    await useFakeIndexedDB();
    // Import AFTER IDB is on globalThis so openDb sees it.
    const { createBrowserSnapshotStore } = await import(
      '../../../extension/peerd-runtime/edit/snapshot-store.js'
    );
    const store = createBrowserSnapshotStore();
    const cp = await store.capture({ scope: 'app:idb', files: { 'a': 'hello' } });
    expect(await store.materialize(cp.id)).toEqual({ a: 'hello' });
    const list = await store.list('app:idb');
    expect(list.length).toBe(1);
  });
});

describe('checkpoint manager — diffSince (feature-08 review adapter)', () => {
  const setup = async (initial: Record<string, string>) => {
    const io = memIO();
    const store = createSnapshotStore(io);
    const ws = memWorkspace(initial);
    const mgr = createCheckpointManager({
      store,
      workspaceFor: (scope: string) => (scope === 'app:a' ? ws.adapter : null),
      now: () => 1,
    });
    const cp = await mgr.capture({ scope: 'app:a' });
    return { mgr, ws, cp };
  };

  test('added / modified / deleted vs the latest checkpoint', async () => {
    const { mgr, ws, cp } = await setup({ 'index.html': '<a>', 'app.js': 'x()' });
    ws.files.set('app.js', 'y()');          // modified
    ws.files.set('new.css', 'b{}');         // added
    ws.files.delete('index.html');          // deleted
    const diff = await mgr.diffSince({ scope: 'app:a' });
    expect(diff.ref).toBe(cp!.id);
    const byPath = Object.fromEntries(diff.files.map((f: any) => [f.path, f]));
    expect(byPath['app.js']).toEqual({ path: 'app.js', status: 'modified', before: 'x()', after: 'y()' });
    expect(byPath['new.css']).toEqual({ path: 'new.css', status: 'added', after: 'b{}' });
    expect(byPath['index.html']).toEqual({ path: 'index.html', status: 'deleted', before: '<a>' });
  });

  test('explicit ref diffs from that checkpoint, not the latest', async () => {
    const { mgr, ws, cp } = await setup({ 'a.txt': 'v1' });
    ws.files.set('a.txt', 'v2');
    await mgr.capture({ scope: 'app:a', label: 'second' });
    ws.files.set('a.txt', 'v3');
    const diff = await mgr.diffSince({ ref: cp!.id });
    expect(diff.ref).toBe(cp!.id);
    expect(diff.files).toEqual([{ path: 'a.txt', status: 'modified', before: 'v1', after: 'v3' }]);
  });

  test('no checkpoint / unknown scope → empty changeset, not an error', async () => {
    const io = memIO();
    const store = createSnapshotStore(io);
    const mgr = createCheckpointManager({ store, workspaceFor: () => null, now: () => 1 });
    expect(await mgr.diffSince({ scope: 'app:none' })).toEqual({ files: [] });
    expect(await mgr.diffSince({})).toEqual({ files: [] });
  });

  test('unchanged workspace → ref present, zero files (review short-circuits)', async () => {
    const { mgr, cp } = await setup({ 'a.txt': 'same' });
    const diff = await mgr.diffSince({ scope: 'app:a' });
    expect(diff.ref).toBe(cp!.id);
    expect(diff.files).toEqual([]);
  });
});
