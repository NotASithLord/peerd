import { describe, test, expect } from 'bun:test';
import { createNotebookRegistry, NOTEBOOK_TAB_PATH, NOTEBOOK_OPFS_ROOT } from '../../extension/peerd-engine/notebook-registry.js';
import { createStorageStub } from '../setup.ts';

describe('createNotebookRegistry', () => {
  test('exports NOTEBOOK_TAB_PATH + NOTEBOOK_OPFS_ROOT constants', () => {
    expect(NOTEBOOK_TAB_PATH).toBe('/notebook-tab/index.html');
    expect(NOTEBOOK_OPFS_ROOT).toBe('peerd-notebooks');
  });

  test('create() assigns id prefix notebook-, name defaults to notebook-N', async () => {
    const reg = createNotebookRegistry({ storage: createStorageStub() });
    const a = await reg.create({});
    const b = await reg.create({});
    expect(a.id).toMatch(/^notebook-/);
    expect(a.name).toBe('notebook-1');
    expect(b.name).toBe('notebook-2');
  });

  test('create() honors custom name', async () => {
    const reg = createNotebookRegistry({ storage: createStorageStub() });
    const rec = await reg.create({ name: 'my-thing' });
    expect(rec.name).toBe('my-thing');
  });

  test('session defaults + delete cascade', async () => {
    const reg = createNotebookRegistry({ storage: createStorageStub() });
    const rec = await reg.create({ name: 'x' });
    await reg.setDefaultForSession('chat-1', rec.id);
    expect(await reg.getDefaultForSession('chat-1')).toBe(rec.id);
    await reg.delete(rec.id);
    expect(await reg.getDefaultForSession('chat-1')).toBeNull();
  });

  test('setDefaultForSession throws for unknown id', async () => {
    const reg = createNotebookRegistry({ storage: createStorageStub() });
    expect(reg.setDefaultForSession('chat-1', 'notebook-missing'))
      .rejects.toThrow('notebook not found');
  });
});
