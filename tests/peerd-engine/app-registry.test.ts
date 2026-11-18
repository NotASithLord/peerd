import { describe, test, expect } from 'bun:test';
import { createAppRegistry, APP_TAB_PATH } from '../../extension/peerd-engine/app-registry.js';
import { createStorageStub } from '../setup.ts';

describe('createAppRegistry', () => {
  test('exports APP_TAB_PATH', () => {
    expect(APP_TAB_PATH).toBe('/engine-tabs/app-tab/index.html');
  });

  test('create() requires name + records tags + entryFile', async () => {
    const reg = createAppRegistry({ storage: createStorageStub() });
    const rec = await reg.create({
      name: 'calc',
      tags: ['math', 'tool'],
      entryFile: 'main.html',
    });
    expect(rec.id).toMatch(/^app-/);
    expect(rec.name).toBe('calc');
    expect(rec.tags).toEqual(['math', 'tool']);
    expect(rec.entryFile).toBe('main.html');
  });

  test('entryFile defaults to index.html', async () => {
    const reg = createAppRegistry({ storage: createStorageStub() });
    const rec = await reg.create({ name: 'a' });
    expect(rec.entryFile).toBe('index.html');
  });

  test('sync content identity is persisted only when it is a SHA-256 hex digest', async () => {
    const reg = createAppRegistry({ storage: createStorageStub() });
    const hash = 'a'.repeat(64);
    expect((await reg.create({ name: 'portable', syncContentHash: hash } as any)).syncContentHash)
      .toBe(hash);
    expect(await reg.create({ name: 'bad', syncContentHash: 'not-a-hash' } as any))
      .not.toHaveProperty('syncContentHash');
  });

  test('a trusted install can reserve its final App id without overwriting another record', async () => {
    const reg = createAppRegistry({ storage: createStorageStub() });
    const id = 'app-12345678-abcd';
    expect((await reg.create({ id, name: 'installed' })).id).toBe(id);
    await expect(reg.create({ id, name: 'duplicate' })).rejects.toThrow('app already exists');
    await expect(reg.create({ id: 'app-../../escape', name: 'bad' })).rejects.toThrow('invalid app id');
  });

  test('file kinds are bounded, normalized metadata', async () => {
    const reg = createAppRegistry({ storage: createStorageStub() });
    const rec = await reg.create({
      name: 'a',
      fileKinds: { 'index.html': 'text', 'data.custom': 'binary', bad: 'other' },
    });
    expect(rec.fileKinds).toEqual({ 'index.html': 'text', 'data.custom': 'binary' });
    const updated = await reg.update(rec.id, { fileKinds: { 'main.html': 'text' } });
    expect(updated?.fileKinds).toEqual({ 'main.html': 'text' });
  });

  test('update() bumps updatedAt', async () => {
    const reg = createAppRegistry({ storage: createStorageStub() });
    const rec = await reg.create({ name: 'a' });
    const t0 = rec.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    const updated = await reg.update(rec.id, { name: 'a2' });
    expect(updated?.updatedAt).toBeGreaterThan(t0);
    expect(updated?.name).toBe('a2');
  });

  test('searchMetadata matches name + tags case-insensitively', async () => {
    const reg = createAppRegistry({ storage: createStorageStub() });
    await reg.create({ name: 'Calculator', tags: ['math'] });
    await reg.create({ name: 'Stopwatch', tags: ['Time'] });
    await reg.create({ name: 'NoteList', tags: [] });

    expect((await reg.searchMetadata('calc')).map((x) => x.name)).toEqual(['Calculator']);
    expect((await reg.searchMetadata('TIME')).map((x) => x.name)).toEqual(['Stopwatch']);
    expect((await reg.searchMetadata('zzz'))).toEqual([]);
  });

  test('tags are truncated to 16 entries', async () => {
    const reg = createAppRegistry({ storage: createStorageStub() });
    const many = Array.from({ length: 30 }, (_, i) => `t${i}`);
    const rec = await reg.create({ name: 'x', tags: many });
    expect(rec.tags).toHaveLength(16);
  });

  test('snapshot returns current app per session', async () => {
    const reg = createAppRegistry({ storage: createStorageStub() });
    const a = await reg.create({ name: 'a' });
    await reg.create({ name: 'b' });
    await reg.setDefaultForSession('chat-1', a.id);
    const snap = await reg.snapshot({ sessionId: 'chat-1' });
    expect(snap.currentId).toBe(a.id);
    expect(snap.apps).toHaveLength(2);
  });

  test('internet access is off at create and only an update with a boolean sets it', async () => {
    const reg = createAppRegistry({ storage: createStorageStub() });
    const tree = { hash: 'a'.repeat(64), storageKey: '00000000-0000-0000-0000-000000000001', totalBytes: 10, fileCount: 1 };
    const created = await reg.create({ name: 'game', fileTree: tree, networkAllowed: true } as Parameters<typeof reg.create>[0]);
    expect(created).not.toHaveProperty('networkAllowed');
    expect(await reg.update(created.id, { networkAllowed: 'yes' } as unknown as { networkAllowed: boolean }))
      .not.toHaveProperty('networkAllowed');
    expect((await reg.update(created.id, { networkAllowed: true }))?.networkAllowed).toBe(true);
    expect((await reg.update(created.id, { name: 'renamed' }))?.networkAllowed).toBe(true);
    expect((await reg.update(created.id, { networkAllowed: false }))?.networkAllowed).toBe(false);
  });

  test('an app that the user adds again starts with internet access off', async () => {
    const reg = createAppRegistry({ storage: createStorageStub() });
    const tree = { hash: 'a'.repeat(64), storageKey: '00000000-0000-0000-0000-000000000001', totalBytes: 10, fileCount: 1 };
    const first = await reg.create({ name: 'game', fileTree: tree });
    await reg.update(first.id, { networkAllowed: true });
    await reg.delete(first.id);
    const second = await reg.create({ name: 'game', fileTree: tree });
    expect(second.id).not.toBe(first.id);
    expect(second).not.toHaveProperty('networkAllowed');
  });
});
