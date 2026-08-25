import { describe, expect, test } from 'bun:test';
import {
  createKernelAppCatalog,
  kernelAppCatalogRows,
  kernelSessionAppId,
  parseKernelAppCatalogRow,
} from '../../extension/background/kernel-app-catalog.js';
import { createAppRegistry } from '../../extension/peerd-engine/background.js';

const initialRow = () => ({
  key: 'apps.v1',
  value: {
    schemaVersion: 1 as const,
    apps: {
      a: { id: 'a', name: 'Alpha', favorite: false, updatedAt: 10 },
      b: { id: 'b', name: 'Beta', favorite: true, updatedAt: 20 },
    },
    sessionDefaults: { chat: 'a' },
  },
});

const makeIdb = () => {
  let row: any = initialRow();
  const calls: any[] = [];
  return {
    calls,
    get row() { return row; },
    get: async (store: string, key: string) => {
      calls.push(['get', store, key]);
      return structuredClone(row);
    },
    put: async (store: string, value: any) => {
      calls.push(['put', store, structuredClone(value)]);
      row = structuredClone(value);
    },
  };
};

describe('native kernel App catalog', () => {
  test('parses only the exact single-row schema and exact live session defaults', () => {
    const row = initialRow();
    expect(parseKernelAppCatalogRow(row)).toEqual(row.value);
    expect(kernelAppCatalogRows(row).map((app: any) => app.id)).toEqual(['a', 'b']);
    expect(kernelSessionAppId(row, 'chat')).toBe('a');
    expect(kernelSessionAppId({ ...row, key: 'vms.v1' }, 'chat')).toBeNull();
    expect(kernelSessionAppId({
      ...row, value: { ...row.value, sessionDefaults: { chat: 'missing' } },
    }, 'chat')).toBeNull();
    for (const invalid of [null, [], row.value, { key: 'apps.v1', value: {} }, {
      key: 'apps.v1', value: { schemaVersion: 2, apps: {}, sessionDefaults: {} },
    }]) expect(parseKernelAppCatalogRow(invalid)).toBeNull();
  });

  test('creates, finalizes, selects, and removes one imported App atomically per catalog write', async () => {
    const idb = makeIdb();
    await idb.put('apps', { key: 'apps.v1', value: {
      schemaVersion: 1, apps: {}, sessionDefaults: {},
    } });
    const catalog = createKernelAppCatalog({
      idb, now: () => 99, newId: () => 'app-import',
    });
    await expect(catalog.createImported({ name: '  Git App  ', ownerSessionId: 'chat' }))
      .resolves.toMatchObject({
        id: 'app-import', name: 'Git App', ownerSessionId: 'chat', source: 'imported',
      });
    await expect(catalog.patch('app-import', {
      entryFile: 'main.html', fileKinds: { 'main.html': 'text' },
    })).resolves.toMatchObject({
      id: 'app-import', entryFile: 'main.html', fileKinds: { 'main.html': 'text' },
    });
    await expect(catalog.setDefaultForSession('chat', 'app-import')).resolves.toBe(true);
    expect(idb.row.value.sessionDefaults).toEqual({ chat: 'app-import' });
    await expect(catalog.remove('app-import')).resolves.toBe(true);
    expect(idb.row.value).toEqual({ schemaVersion: 1, apps: {}, sessionDefaults: {} });
  });

  test('bind drains cold mutations before loading the one live registry cache', async () => {
    const idb = makeIdb();
    const catalog = createKernelAppCatalog({ idb, now: () => 99 });
    const cold = catalog.setName('a', 'Cold rename');
    const live = await catalog.bindLiveRegistry(async () => createAppRegistry({
      storage: {
        get: async () => (await idb.get('apps', 'apps.v1'))?.value,
        set: async (_key: string, value: any) => idb.put('apps', { key: 'apps.v1', value }),
      },
    }));
    await cold;
    expect(await live.get('a')).toMatchObject({ name: 'Cold rename' });
  });

  test('cold and rich callers share one serialized cache after binding', async () => {
    const idb = makeIdb();
    const catalog = createKernelAppCatalog({ idb, now: () => 99 });
    const live = await catalog.bindLiveRegistry(async () => createAppRegistry({
      storage: {
        get: async () => (await idb.get('apps', 'apps.v1'))?.value,
        set: async (_key: string, value: any) => idb.put('apps', { key: 'apps.v1', value }),
      },
    }));
    await Promise.all([
      catalog.setFavorite('a', true),
      live.update('a', { name: 'Rich rename' }),
      catalog.setDefaultForSession('other-chat', 'b'),
    ]);
    expect(await catalog.get('a')).toMatchObject({ name: 'Rich rename', favorite: true });
    expect(await live.getDefaultForSession('other-chat')).toBe('b');
    expect(idb.row.value.apps.a).toMatchObject({ name: 'Rich rename', favorite: true });
    expect(idb.row.value.sessionDefaults['other-chat']).toBe('b');
  });
});
