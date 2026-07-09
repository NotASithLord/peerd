import { describe, test, expect } from 'bun:test';
import { createAppRegistry, APP_TAB_PATH } from '../../extension/peerd-engine/app-registry.js';
import { createStorageStub } from '../setup.ts';

describe('createAppRegistry', () => {
  test('exports APP_TAB_PATH', () => {
    expect(APP_TAB_PATH).toBe('/app-tab/index.html');
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

  // The dwapp ACTOR MANIFEST slot — stored at create, replaced/cleared on patch.
  const manifest = { name: 'Parser', lore: 'parse things', skills: [], tools: ['fetch_url'] };

  test('actor manifest is stored at create and absent by default', async () => {
    const reg = createAppRegistry({ storage: createStorageStub() });
    const plain = await reg.create({ name: 'plain' });
    expect(plain.actor).toBeUndefined();
    const dwapp = await reg.create({ name: 'dwapp', actor: manifest });
    expect(dwapp.actor).toEqual(manifest);
  });

  test('a metadata-only patch must NOT clear a valid manifest', async () => {
    const reg = createAppRegistry({ storage: createStorageStub() });
    const rec = await reg.create({ name: 'dwapp', actor: manifest });
    const renamed = await reg.update(rec.id, { name: 'renamed' });
    expect(renamed?.name).toBe('renamed');
    expect(renamed?.actor).toEqual(manifest);        // preserved
  });

  test('patching actor replaces it; null clears it', async () => {
    const reg = createAppRegistry({ storage: createStorageStub() });
    const rec = await reg.create({ name: 'dwapp', actor: manifest });
    const next = { name: 'Parser2', lore: 'v2', skills: [], tools: [] };
    const updated = await reg.update(rec.id, { actor: next });
    expect(updated?.actor).toEqual(next);            // replaced wholesale
    const cleared = await reg.update(rec.id, { actor: null } as any);   // null = manifest file removed
    expect(cleared?.actor).toBeUndefined();          // manifest file removed → plain app
  });

  test('clearActorSession unbinds a live actor (re-mint on manifest change) and archives it', async () => {
    const archived: string[] = [];
    const reg = createAppRegistry({ storage: createStorageStub(), onActorArchive: (s: string) => archived.push(s) });
    const rec = await reg.create({ name: 'dwapp', actor: manifest });
    expect(await reg.clearActorSession(rec.id)).toBe(false);   // nothing bound yet → no-op
    await reg.setActorSession(rec.id, 'actor-sess-1');
    expect(await reg.getActorSession(rec.id)).toBe('actor-sess-1');
    expect(await reg.clearActorSession(rec.id)).toBe(true);    // cleared
    expect(await reg.getActorSession(rec.id)).toBeNull();      // next message_actor re-mints
    expect(archived).toEqual(['actor-sess-1']);                // orphan archived, not leaked
  });
});
