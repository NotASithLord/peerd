import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { useFakeIndexedDB } from '../setup.ts';

// The engine catalogs moved off chrome.storage.local onto IndexedDB via
// the `idbKV` single-blob adapter (peerd-egress/storage/idb.js). These
// tests exercise the real adapter against fake-indexeddb and prove a
// registry survives a "fresh process" (a new registry instance over the
// same store reads the persisted blob — i.e. SW restart).

let idb: typeof import('../../extension/peerd-egress/storage/idb.js');
let appRegistry: typeof import('../../extension/peerd-engine/app-registry.js');
let notebookRegistry: typeof import('../../extension/peerd-engine/notebook-registry.js');
let vmRegistry: typeof import('../../extension/peerd-engine/vm-registry.js');

beforeAll(async () => {
  await useFakeIndexedDB();
  idb = await import('../../extension/peerd-egress/storage/idb.js');
  appRegistry = await import('../../extension/peerd-engine/app-registry.js');
  notebookRegistry = await import('../../extension/peerd-engine/notebook-registry.js');
  vmRegistry = await import('../../extension/peerd-engine/vm-registry.js');
});

// Clear the stores between cases (not deleteDatabase — that would orphan
// idb.js's cached connection). The DB stays; the stores empty.
beforeEach(async () => {
  await idb.clear('apps');
  await idb.clear('notebooks');
  await idb.clear('vms');
});

describe('idbKV — single-blob IDB adapter', () => {
  test('set then get round-trips the value (unwrapped)', async () => {
    const kv = idb.idbKV('apps');
    await kv.set('apps.v1', { schemaVersion: 1, apps: { 'app-1': { id: 'app-1' } } });
    expect(await kv.get('apps.v1')).toEqual({
      schemaVersion: 1,
      apps: { 'app-1': { id: 'app-1' } },
    });
  });

  test('get returns undefined for a missing key', async () => {
    const kv = idb.idbKV('apps');
    expect(await kv.get('nope.v1')).toBeUndefined();
  });

  test('writes the { key, value } envelope the store keyPath depends on', async () => {
    // Pin the on-disk shape: a bare value (no envelope) would silently
    // break the keyPath:'key' store. Read the raw record, not via get().
    await idb.idbKV('apps').set('apps.v1', { schemaVersion: 1, apps: {} });
    const raw = await idb.get('apps', 'apps.v1');
    expect(raw.key).toBe('apps.v1');
    expect(raw.value).toEqual({ schemaVersion: 1, apps: {} });
  });
});

describe('Notebook + VM registries persist through IndexedDB too', () => {
  test('a Notebook survives a fresh registry (SW restart)', async () => {
    const r1 = notebookRegistry.createNotebookRegistry({ storage: idb.idbKV('notebooks') });
    const rec = await r1.create({ name: 'parser' });
    expect(rec.id).toMatch(/^notebook-/);
    const r2 = notebookRegistry.createNotebookRegistry({ storage: idb.idbKV('notebooks') });
    expect((await r2.get(rec.id))?.name).toBe('parser');
  });

  test('a VM survives a fresh registry, disk overlay key intact', async () => {
    const r1 = vmRegistry.createVmRegistry({ storage: idb.idbKV('vms') });
    const rec = await r1.create({ name: 'debian' });
    expect(rec.id).toMatch(/^vm-/);
    const r2 = vmRegistry.createVmRegistry({ storage: idb.idbKV('vms') });
    const got = await r2.get(rec.id);
    expect(got?.name).toBe('debian');
    expect(got?.diskOverlayKey).toBe(rec.diskOverlayKey);
  });

  // DESIGN-17 Move 1: the instance→actor forward pointer. The routing
  // foundation resolveActor depends on — bind it, prove it survives a fresh
  // registry (SW restart), and prove delete archives the orphaned actor.
  test('the actor-session forward pointer binds, survives SW restart, and fires onActorArchive on delete', async () => {
    const archived: string[] = [];
    const r1 = notebookRegistry.createNotebookRegistry({
      storage: idb.idbKV('notebooks'),
      onActorArchive: (sid: string) => { archived.push(sid); },
    });
    const rec = await r1.create({ name: 'driven' });
    // Unbound until the first message_actor binds it (lazy mint).
    expect(await r1.getActorSession(rec.id)).toBeNull();
    await r1.setActorSession(rec.id, 'actor-session-7');
    expect(await r1.getActorSession(rec.id)).toBe('actor-session-7');

    // A fresh registry over the same store reads the persisted pointer.
    const r2 = notebookRegistry.createNotebookRegistry({
      storage: idb.idbKV('notebooks'),
      onActorArchive: (sid: string) => { archived.push(sid); },
    });
    expect(await r2.getActorSession(rec.id)).toBe('actor-session-7');

    // Removing the instance archives its now-orphaned actor (every delete path
    // funnels through remove(), exposed as delete(), so the Library UI route is
    // covered too).
    await r2.delete(rec.id);
    expect(archived).toEqual(['actor-session-7']);
    expect(await r2.getActorSession(rec.id)).toBeNull();   // instance gone
  });
});

describe('createAppRegistry backed by IndexedDB', () => {
  test('a created app persists and is readable by a fresh registry (SW restart)', async () => {
    const reg1 = appRegistry.createAppRegistry({ storage: idb.idbKV('apps') });
    const rec = await reg1.create({ name: 'calc', tags: ['math'] });
    expect(rec.id).toMatch(/^app-/);

    // A brand-new registry instance over the same store = a fresh SW.
    const reg2 = appRegistry.createAppRegistry({ storage: idb.idbKV('apps') });
    const got = await reg2.get(rec.id);
    expect(got?.name).toBe('calc');
    expect(got?.tags).toEqual(['math']);
  });

  test('session defaults persist across instances too', async () => {
    const reg1 = appRegistry.createAppRegistry({ storage: idb.idbKV('apps') });
    const a = await reg1.create({ name: 'a' });
    await reg1.setDefaultForSession('chat-1', a.id);

    const reg2 = appRegistry.createAppRegistry({ storage: idb.idbKV('apps') });
    const snap = await reg2.snapshot({ sessionId: 'chat-1' });
    expect(snap.currentId).toBe(a.id);
    expect(snap.apps).toHaveLength(1);
  });
});

describe('AppRecord Library fields (favorite / source / thumbnail)', () => {
  test('defaults: not a favorite, local source, no thumbnail', async () => {
    const reg = appRegistry.createAppRegistry({ storage: idb.idbKV('apps') });
    const rec = await reg.create({ name: 'calc' });
    expect(rec.favorite).toBe(false);
    expect(rec.source).toBe('local');
    expect(rec.thumbnail).toBe(null);
  });

  test('create honors explicit favorite/source/thumbnail', async () => {
    const reg = appRegistry.createAppRegistry({ storage: idb.idbKV('apps') });
    const rec = await reg.create({ name: 'fromPeer', favorite: true, source: 'dweb', thumbnail: 'data:x' });
    expect(rec.favorite).toBe(true);
    expect(rec.source).toBe('dweb');
    expect(rec.thumbnail).toBe('data:x');
  });

  test('favorite is patchable; source is immutable (provenance)', async () => {
    const reg = appRegistry.createAppRegistry({ storage: idb.idbKV('apps') });
    const rec = await reg.create({ name: 'calc' });
    const faved = await reg.update(rec.id, { favorite: true, source: 'dweb' });
    expect(faved?.favorite).toBe(true);
    expect(faved?.source).toBe('local');     // source is NOT in the patch allowlist
    const unfaved = await reg.update(rec.id, { favorite: false });
    expect(unfaved?.favorite).toBe(false);
  });

  test('favorite persists across a fresh registry (SW restart)', async () => {
    const reg1 = appRegistry.createAppRegistry({ storage: idb.idbKV('apps') });
    const rec = await reg1.create({ name: 'calc' });
    await reg1.update(rec.id, { favorite: true });
    const reg2 = appRegistry.createAppRegistry({ storage: idb.idbKV('apps') });
    expect((await reg2.get(rec.id))?.favorite).toBe(true);
  });

  test('thumbnail patch is bounded (oversized → null)', async () => {
    const reg = appRegistry.createAppRegistry({ storage: idb.idbKV('apps') });
    const rec = await reg.create({ name: 'calc' });
    const big = 'x'.repeat(300_000);
    expect((await reg.update(rec.id, { thumbnail: big }))?.thumbnail).toBe(null);
    expect((await reg.update(rec.id, { thumbnail: 'data:small' }))?.thumbnail).toBe('data:small');
  });
});
