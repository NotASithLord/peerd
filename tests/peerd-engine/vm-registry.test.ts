import { describe, test, expect } from 'bun:test';
import { createVmRegistry } from '../../extension/peerd-engine/vm-registry.js';
import { createStorageStub } from '../setup.ts';

describe('createVmRegistry', () => {
  test('create() assigns id, name, disk key, timestamps', async () => {
    const reg = createVmRegistry({ storage: createStorageStub() });
    const rec = await reg.create({ name: 'demo' });
    expect(rec.id).toMatch(/^vm-/);
    expect(rec.name).toBe('demo');
    expect(rec.diskOverlayKey).toBe(`peerd-vm-${rec.id}`);
    expect(rec.createdAt).toBeNumber();
    expect(rec.lastUsedAt).toBeNumber();
    expect(rec.pinned).toBe(false);
  });

  test('list() returns all created records', async () => {
    const reg = createVmRegistry({ storage: createStorageStub() });
    await reg.create({ name: 'a' });
    await reg.create({ name: 'b' });
    const items = await reg.list();
    expect(items).toHaveLength(2);
    expect(items.map((x) => x.name).sort()).toEqual(['a', 'b']);
  });

  test('get() returns null for unknown id', async () => {
    const reg = createVmRegistry({ storage: createStorageStub() });
    expect(await reg.get('vm-nonexistent')).toBeNull();
  });

  test('update() patches only allowlisted fields', async () => {
    const reg = createVmRegistry({ storage: createStorageStub() });
    const rec = await reg.create({ name: 'orig' });
    const updated = await reg.update(rec.id, {
      name: 'new',
      pinned: true,
      // in Partial<VmRecord> so it type-checks, but not in the runtime
      // patch allowlist -- should be ignored
      diskOverlayKey: 'TRY-OVERRIDE',
    });
    expect(updated?.name).toBe('new');
    expect(updated?.pinned).toBe(true);
    expect(updated?.diskOverlayKey).toBe(rec.diskOverlayKey);
  });

  test('delete() removes record + clears any session pointing to it', async () => {
    const reg = createVmRegistry({ storage: createStorageStub() });
    const rec = await reg.create({ name: 'x' });
    await reg.setDefaultForSession('chat-1', rec.id);
    expect(await reg.getDefaultForSession('chat-1')).toBe(rec.id);
    const ok = await reg.delete(rec.id);
    expect(ok).toBe(true);
    expect(await reg.get(rec.id)).toBeNull();
    expect(await reg.getDefaultForSession('chat-1')).toBeNull();
  });

  test('session defaults: getDefault auto-clears stale pointer', async () => {
    const storage = createStorageStub();
    const reg = createVmRegistry({ storage });
    const rec = await reg.create({ name: 'x' });
    await reg.setDefaultForSession('chat-1', rec.id);
    // Simulate the record vanishing out from under us.
    const raw = storage.snapshot()['webvms.v1'] as any;
    delete raw.vms[rec.id];
    await storage.set('webvms.v1', raw);
    // Force reload by constructing a fresh registry over the same storage.
    const reg2 = createVmRegistry({ storage });
    expect(await reg2.getDefaultForSession('chat-1')).toBeNull();
  });

  test('setDefaultForSession bumps lastUsedAt', async () => {
    const reg = createVmRegistry({ storage: createStorageStub() });
    const rec = await reg.create({ name: 'x' });
    const t0 = rec.lastUsedAt;
    await new Promise((r) => setTimeout(r, 5));
    await reg.setDefaultForSession('chat-1', rec.id);
    const after = await reg.get(rec.id);
    expect(after!.lastUsedAt).toBeGreaterThan(t0);
  });

  test('snapshot() returns {sandboxes-equivalent} + currentVmId per session', async () => {
    const reg = createVmRegistry({ storage: createStorageStub() });
    const a = await reg.create({ name: 'a' });
    await reg.create({ name: 'b' });
    await reg.setDefaultForSession('chat-1', a.id);
    const snap = await reg.snapshot({ sessionId: 'chat-1' });
    expect(snap.vms).toHaveLength(2);
    expect(snap.currentVmId).toBe(a.id);
    const snap2 = await reg.snapshot({ sessionId: 'chat-2' });
    expect(snap2.currentVmId).toBeNull();
  });

  test('persists across reload', async () => {
    const storage = createStorageStub();
    const reg = createVmRegistry({ storage });
    const rec = await reg.create({ name: 'persisted' });
    await reg.setDefaultForSession('chat-1', rec.id);
    const reg2 = createVmRegistry({ storage });
    const items = await reg2.list();
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('persisted');
    expect(await reg2.getDefaultForSession('chat-1')).toBe(rec.id);
  });

  // Cold-registry re-entrancy: load() yields at storage.get before setting the
  // `loaded` flag, so two concurrent first-ops must share ONE load — otherwise
  // each reassigns `state` from a pre-write snapshot and the later one clobbers
  // the earlier op's record (it vanishes, its OPFS subtree orphaned).
  test('concurrent first ops on a cold registry share one load (no clobber)', async () => {
    const store = new Map<string, unknown>();
    let getCount = 0;
    const storage = {
      // slow get widens the race window; counted to prove load() reads once
      get: async (k: string) => { getCount += 1; await new Promise((r) => setTimeout(r, 15)); return store.get(k); },
      set: async (k: string, v: unknown) => { store.set(k, v); },
      delete: async (k: string) => { store.delete(k); },
    };
    const reg = createVmRegistry({ storage });
    await Promise.all([reg.create({ name: 'a' }), reg.create({ name: 'b' })]);
    const items = await reg.list();
    expect(items.map((x) => x.name).sort()).toEqual(['a', 'b']); // neither create clobbered
    expect(getCount).toBe(1);                                    // load() read storage exactly once (memoized)
  });
});
