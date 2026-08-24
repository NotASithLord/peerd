import { describe, expect, test } from 'bun:test';
import {
  createKernelAppCatalog,
  kernelAppCatalogRows,
  kernelSessionAppId,
  parseKernelAppCatalogRow,
} from '../../extension/background/kernel-app-catalog.js';
import { makeKernelAppCatalogRoutes } from '../../extension/background/kernel-app-catalog.js';

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

  test('list, favorite, and rename preserve legacy Library response and durable row shape', async () => {
    const idb = makeIdb();
    const catalog = createKernelAppCatalog({ idb, now: () => 99 });
    const reloads: string[] = [];
    const routes = makeKernelAppCatalogRoutes({
      vault: { isLocked: () => false }, idb, catalog,
      reloadApp: async (appId: string) => { reloads.push(appId); },
    });
    await expect(routes['apps/list']()).resolves.toEqual({
      ok: true, apps: Object.values(initialRow().value.apps),
    });
    await expect(routes['apps/favorite']({ appId: 'a', favorite: true }))
      .resolves.toEqual({
        ok: true, app: { id: 'a', name: 'Alpha', favorite: true, updatedAt: 99 },
      });
    expect(idb.row).toEqual({
      ...initialRow(),
      value: {
        ...initialRow().value,
        apps: {
          ...initialRow().value.apps,
          a: { id: 'a', name: 'Alpha', favorite: true, updatedAt: 99 },
        },
      },
    });
    await expect(routes['apps/favorite']({ appId: 'missing', favorite: true }))
      .resolves.toEqual({ ok: false, error: 'app-not-found' });
    await expect(routes['apps/rename']({ appId: 'a', name: `  ${'N'.repeat(90)}  ` }))
      .resolves.toEqual({
        ok: true,
        app: { id: 'a', name: 'N'.repeat(80), favorite: true, updatedAt: 99 },
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reloads).toEqual(['a']);
    expect(idb.row.value.apps.a).toEqual({
      id: 'a', name: 'N'.repeat(80), favorite: true, updatedAt: 99,
    });
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

  test('locked and malformed mutations refuse before any catalog IO', async () => {
    const idb = makeIdb();
    const routes = makeKernelAppCatalogRoutes({
      vault: { isLocked: () => true }, idb,
    });
    await expect(routes['apps/list']()).resolves.toEqual({
      ok: false, error: 'vault-locked',
    });
    await expect(routes['apps/favorite']({ appId: 'a', favorite: true }))
      .resolves.toEqual({ ok: false, error: 'vault-locked' });
    await expect(routes['apps/rename']({ appId: 'a', name: 'Renamed' }))
      .resolves.toEqual({ ok: false, error: 'vault-locked' });
    expect(idb.calls).toEqual([]);

    const unlocked = makeKernelAppCatalogRoutes({
      vault: { isLocked: () => false }, idb,
    });
    await expect(unlocked['apps/favorite']({ favorite: true }))
      .resolves.toEqual({ ok: false, error: 'appId-required' });
    await expect(unlocked['apps/favorite']({ appId: 'a', favorite: 'yes' } as any))
      .resolves.toEqual({ ok: false, error: 'favorite-boolean-required' });
    await expect(unlocked['apps/rename']({ name: 'Renamed' }))
      .resolves.toEqual({ ok: false, error: 'appId-required' });
    await expect(unlocked['apps/rename']({ appId: 'a', name: '  ' }))
      .resolves.toEqual({ ok: false, error: 'name-required' });
    expect(idb.calls).toEqual([]);
  });

  test('opens one exact App tab and exposes metadata only to that App surface', async () => {
    const idb = makeIdb();
    await idb.put('apps', {
      key: 'apps.v1', value: {
        schemaVersion: 1,
        apps: { a: {
          id: 'a', name: 'Alpha', entryFile: 'main.html', ownerSessionId: 'owner',
          fileKinds: { 'main.html': 'text' }, dweb: { uri: 'peerd://alpha' },
        } },
        sessionDefaults: {},
      },
    });
    idb.calls.length = 0;
    const tabs: any[] = [];
    const routes = makeKernelAppCatalogRoutes({
      vault: { isLocked: () => false }, idb,
      browser: { tabs: {
        query: async () => [],
        create: async (options: any) => { tabs.push(options); },
        update: async () => { throw new Error('unexpected existing tab'); },
      } },
      appTabUrl: 'chrome-extension://id/engine-tabs/app-tab/index.html',
      sessionCache: { sessionGet: async () => 'chat' },
      isAppSender: (sender: unknown, appId: string) => sender === 'app-surface' && appId === 'a',
      dwebEnabled: true,
    });
    await expect(routes['app/get-meta']({ appId: 'a' }, 'forged'))
      .resolves.toEqual({ ok: false, error: 'app-meta-unauthorized' });
    await expect(routes['app/get-meta']({ appId: 'a' }, 'app-surface'))
      .resolves.toMatchObject({
        ok: true, name: 'Alpha', entryFile: 'main.html',
        fileKinds: { 'main.html': 'text' }, dweb: { uri: 'peerd://alpha' },
        agent: { kind: 'bound-app' },
      });
    await expect(routes['apps/open']({ appId: 'a' })).resolves.toEqual({ ok: true });
    expect(tabs).toEqual([{
      url: 'chrome-extension://id/engine-tabs/app-tab/index.html#a?owner=chat', active: true,
    }]);
    expect(idb.row.value.sessionDefaults).toEqual({ chat: 'a' });
  });

  test('app metadata revalidates peerd.json, entry existence, agent, and build dweb policy', async () => {
    const idb = makeIdb();
    await idb.put('apps', {
      key: 'apps.v1', value: { schemaVersion: 1, sessionDefaults: {}, apps: {
        a: { id: 'a', name: 'Alpha', entryFile: 'old.html', dweb: null, fileKinds: {} },
      } },
    });
    const files = {
      readText: async () => JSON.stringify({
        schema: 1, kind: 'dwapp', entry: 'src/index.html', capabilities: ['dweb'],
        agent: { kind: 'bound-app', profile: 'developer', surface: 'code', name: 'Builder' },
      }),
      listApp: async () => ['/peerd.json', '/src/index.html'],
    };
    const routes = makeKernelAppCatalogRoutes({
      vault: { isLocked: () => false }, idb, appFiles: files,
      isAppSender: () => true, dwebEnabled: true,
    });
    await expect(routes['app/get-meta']({ appId: 'a' }, {})).resolves.toMatchObject({
      ok: true, entryFile: 'src/index.html',
      dweb: { uri: null, publisher: null, hash: null, local: true },
      agent: { kind: 'bound-app', name: 'Builder' },
    });
    expect(idb.row.value.apps.a.entryFile).toBe('src/index.html');

    const missing = makeKernelAppCatalogRoutes({
      vault: { isLocked: () => false }, idb,
      appFiles: { ...files, listApp: async () => ['/peerd.json'] },
      isAppSender: () => true, dwebEnabled: true,
    });
    await expect(missing['app/get-meta']({ appId: 'a' }, {})).resolves.toEqual({
      ok: false, error: 'peerd.json entry is missing: src/index.html',
    });

    const store = makeKernelAppCatalogRoutes({
      vault: { isLocked: () => false }, idb, appFiles: files,
      isAppSender: () => true, dwebEnabled: false,
    });
    await expect(store['app/get-meta']({ appId: 'a' }, {})).resolves.toMatchObject({
      ok: true, dweb: null,
    });
  });

  test('catalog mutations retain unknown custody and hide storage internals', async () => {
    const raw = 'private-idb-transaction-epoch';
    const catalog: any = {
      list: async () => [],
      get: async () => ({ id: 'a', name: 'Alpha', entryFile: 'index.html' }),
      setFavorite: async () => { throw new Error(raw); },
      setName: async () => { throw new Error(raw); },
      setDefaultForSession: async () => { throw new Error(raw); },
      setEntryFile: async () => { throw new Error(raw); },
    };
    const common = {
      vault: { isLocked: () => false }, idb: makeIdb(), catalog,
    };
    for (const reply of [
      await makeKernelAppCatalogRoutes(common)['apps/favorite']({ appId: 'a', favorite: true }),
      await makeKernelAppCatalogRoutes(common)['apps/rename']({ appId: 'a', name: 'Next' }),
    ]) {
      expect(reply).toMatchObject({
        ok: false, outcomeKnown: false, outcomeKind: 'unknown', retryable: false,
      });
      expect(reply.error).not.toContain(raw);
    }

    let created = 0;
    const open = makeKernelAppCatalogRoutes({
      ...common,
      browser: { tabs: {
        query: async () => [],
        create: async () => { created += 1; },
      } },
      appTabUrl: 'chrome-extension://id/engine-tabs/app-tab/index.html',
      sessionCache: { sessionGet: async () => 'chat' },
    });
    const openReply = await open['apps/open']({ appId: 'a' });
    expect(created).toBe(1);
    expect(openReply).toMatchObject({
      ok: false, code: 'app-open-outcome-unknown', outcomeKnown: false, retryable: false,
    });
    expect(openReply.error).not.toContain(raw);

    const meta = makeKernelAppCatalogRoutes({
      ...common,
      isAppSender: () => true,
      appFiles: {
        readText: async () => JSON.stringify({
          schema: 1, kind: 'dwapp', entry: 'next.html', capabilities: ['dweb'],
          agent: { kind: 'bound-app', profile: 'developer', surface: 'code' },
        }),
        listApp: async () => ['/peerd.json', '/next.html'],
      },
    });
    const metaReply = await meta['app/get-meta']({ appId: 'a' }, {});
    expect(metaReply).toMatchObject({
      ok: false, code: 'app-entry-update-outcome-unknown',
      outcomeKnown: false, retryable: false,
    });
    expect(metaReply.error).not.toContain(raw);
  });
});
