import { describe, expect, test } from 'bun:test';
import { createKernelSemanticAuthority } from '../../extension/background/kernel-semantic-authority.js';
import { createKernelSemanticControl } from '../../extension/background/kernel-semantic-control.js';
import { dispatchAppSemanticRoute } from '../../extension/offscreen/semantic-routes/apps.js';

const semanticCaller = (authority: ReturnType<typeof createKernelSemanticAuthority>) => {
  const control = createKernelSemanticControl({
    authority, isHomeSender: () => true, vault: { isLocked: () => false },
    callSemantic: (outerPayload: any) => {
      const grant = control.authorize(outerPayload);
      return dispatchAppSemanticRoute(outerPayload.route, outerPayload.message, {
        kernelCall: (operation, payload) => control.handleKernelCall(operation, payload, {
          authority: grant, outerPayload,
        }),
      });
    },
  });
  return (route: string, message: any) => control.dispatchProjected(route, message, 'first-party');
};

const makeState = (fresh = false, failCreate = false) => {
  const cache = new Map<string, any>(fresh ? [] : [['currentSessionId', 'chat']]);
  const sessions = new Map<string, any>(fresh ? [] : [['chat', { sessionId: 'chat' }]]);
  let creates = 0;
  const apps: Record<string, any> = {
    a: {
      id: 'a', name: 'Alpha', entryFile: 'old.html', ownerSessionId: fresh ? null : 'owner',
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
    sessionCache: {
      sessionGet: async (key: string) => cache.get(key),
      sessionSet: async (key: string, value: any) => { cache.set(key, value); },
      sessionDelete: async (key: string) => { cache.delete(key); },
    },
    appLaunchSessions: {
      get: async (id: string) => sessions.get(id),
      create: async (options: any) => {
        creates++;
        if (failCreate) throw new Error('storage-unavailable');
        const session = { ...options, sessionId: 'first-local-owner' };
        sessions.set(session.sessionId, session);
        return session;
      },
    },
  });
  const run = semanticCaller(authority);
  return { apps, tabs, reloads, authority, run, sessions, cache, creates: () => creates,
    current: (): string|null => cache.get('currentSessionId') ?? null };
};

describe('sealed App semantic routes', () => {
  test('first keyless semantic opens share a durable owner before opening tabs', async () => {
    const state = makeState(true);
    await Promise.all([state.run('apps/open', { appId: 'a' }), state.run('apps/open', { appId: 'a' })]);
    expect(state.creates()).toBe(1);
    expect(state.current()).toBe('first-local-owner');
    expect(state.sessions.get(state.current()!)).toMatchObject({ permissionMode: 'act', confirmActions: false });
    expect(Object.fromEntries(state.cache)).toEqual({
      currentSessionId: 'first-local-owner', currentPermissionMode: 'act', currentConfirmActions: false,
    });
    expect(state.tabs).toHaveLength(2);
    for (const tab of state.tabs) expect(tab.url).toEndWith('?owner=first-local-owner');
  });

  test('storage failure cannot launch an ownerless semantic app', async () => {
    const state = makeState(true, true);
    const reply = await state.run('apps/open', { appId: 'a' });
    expect(reply.ok).toBe(false);
    expect(state.tabs).toEqual([]);
    expect(state.current()).toBeNull();
  });

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
    const pending = semanticCaller(authority)('apps/rename', { appId: 'a', name: 'Next' })
      .then((value: any) => { settled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    finish();
    await expect(pending).resolves.toMatchObject({ ok: true, app: { name: 'Next' } });
    expect(state.tabs).toEqual([]);
  });
});
