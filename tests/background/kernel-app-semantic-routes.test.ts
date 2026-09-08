import { describe, expect, test } from 'bun:test';
import { createKernelSemanticAuthority } from '../../extension/background/kernel-semantic-authority.js';
import { dispatchAppSemanticRoute } from '../../extension/offscreen/semantic-routes/apps.js';

const makeState = () => {
  const apps: Record<string, any> = {
    a: {
      id: 'a', name: 'Alpha', entryFile: 'old.html', ownerSessionId: 'owner',
      favorite: false, fileKinds: { 'old.html': 'text' }, dweb: null,
    },
  };
  const tabs: any[] = [];
  const reloads: string[] = [];
  const catalog = {
    get: async (id: string) => apps[id] ?? null,
    setFavorite: async (id: string, favorite: boolean) => apps[id]
      ? (apps[id] = { ...apps[id], favorite }) : null,
    setName: async (id: string, name: string) => apps[id]
      ? (apps[id] = { ...apps[id], name }) : null,
    setEntryFile: async (id: string, entryFile: string) => apps[id]
      ? (apps[id] = { ...apps[id], entryFile }) : null,
    setDefaultForSession: async (sessionId: string, appId: string) => {
      apps[appId].defaultSessionId = sessionId;
      return true;
    },
  };
  const authority = createKernelSemanticAuthority({
    idb: {}, kv: {}, auditLog: {}, ready: Promise.resolve(), appCatalog: catalog,
    vault: { isLocked: () => false, getSecret: async () => null },
    reloadApp: async (appId: string) => { reloads.push(appId); },
    browser: { tabs: {
      query: async () => [], create: async (value: any) => { tabs.push(value); },
    } },
    appTabUrl: 'chrome-extension://id/engine-tabs/app-tab/index.html',
    sessionCache: { sessionGet: async () => 'chat' },
  });
  const run = (route: string, message: any) => dispatchAppSemanticRoute(route, message, {
    kernelCall: (operation, payload) => authority.handle(operation, payload, {
      authority: { target: `semantic:${route}:first-party` },
    }),
  });
  return { apps, tabs, reloads, authority, run };
};

describe('sealed App semantic routes', () => {
  test('preserves favorite, rename, reload, and browser-open behavior', async () => {
    const state = makeState();
    await expect(state.run('apps/favorite', { appId: 'a', favorite: true }))
      .resolves.toMatchObject({ ok: true, app: { favorite: true } });
    await expect(state.run('apps/rename', { appId: 'a', name: '  Next  ' }))
      .resolves.toMatchObject({ ok: true, app: { name: 'Next' } });
    expect(state.reloads).toEqual(['a']);
    await expect(state.run('apps/open', { appId: 'a' })).resolves.toEqual({ ok: true });
    expect(state.tabs).toEqual([{
      url: 'chrome-extension://id/engine-tabs/app-tab/index.html#a?owner=chat', active: true,
    }]);
    expect(state.apps.a.defaultSessionId).toBe('chat');
  });

  test('revalidates the manifest in the sealed host and commits only the exact entry effect', async () => {
    const state = makeState();
    const manifestText = JSON.stringify({
      schema: 1, kind: 'dwapp', entry: 'src/index.html', capabilities: ['dweb'],
      agent: { kind: 'bound-app', profile: 'developer', surface: 'code', name: 'Builder' },
    });
    await expect(state.run('app/get-meta', {
      app: state.apps.a, manifestText, paths: ['/peerd.json', '/src/index.html'],
      dwebEnabled: true,
    })).resolves.toMatchObject({
      ok: true, entryFile: 'src/index.html',
      dweb: { uri: null, publisher: null, hash: null, local: true },
      agent: { kind: 'bound-app', name: 'Builder' },
    });
    expect(state.apps.a.entryFile).toBe('src/index.html');
    await expect(state.run('app/get-meta', {
      app: state.apps.a, manifestText, paths: ['/peerd.json'], dwebEnabled: true,
    })).resolves.toEqual({
      ok: false, error: 'peerd.json entry is missing: src/index.html',
    });
  });

  test('refuses malformed input before effects and binds every reverse operation to one route', async () => {
    const state = makeState();
    await expect(state.run('apps/favorite', { appId: 'a', favorite: 'yes' }))
      .resolves.toEqual({ ok: false, error: 'favorite-boolean-required' });
    await expect(state.run('apps/rename', { appId: 'a', name: '  ' }))
      .resolves.toEqual({ ok: false, error: 'name-required' });
    await expect(state.authority.handle('semantic.apps.open', { appId: 'a' }, {
      authority: { target: 'semantic:apps/rename:first-party' },
    })).resolves.toEqual({
      ok: false, code: 'semantic-kernel-operation-denied', outcomeKnown: true,
    });
    expect(state.tabs).toEqual([]);
    expect(state.reloads).toEqual([]);
  });

  test('does not report success while the post-rename reload effect is pending', async () => {
    let finish = () => {};
    const state = makeState();
    const authority = createKernelSemanticAuthority({
      idb: {}, kv: {}, auditLog: {}, ready: Promise.resolve(),
      appCatalog: {
        setName: async () => ({ id: 'a', name: 'Next' }),
      },
      vault: { isLocked: () => false, getSecret: async () => null },
      reloadApp: () => new Promise<void>((resolve) => { finish = resolve; }),
    });
    let settled = false;
    const pending = dispatchAppSemanticRoute('apps/rename', { appId: 'a', name: 'Next' }, {
      kernelCall: (operation, payload) => authority.handle(operation, payload, {
        authority: { target: 'semantic:apps/rename:first-party' },
      }),
    }).then((value) => { settled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    finish();
    await expect(pending).resolves.toMatchObject({ ok: true, app: { name: 'Next' } });
    expect(state.tabs).toEqual([]);
  });
});
