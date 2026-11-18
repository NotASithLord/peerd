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

const makeState = (fresh = false, failCreate = false, openTabs: any[] = []) => {
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
  const queries: string[] = [];
  const activations: any[] = [];
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
      // Chrome matches the document URL without its fragment.
      query: async ({ url }: { url: string }) => {
        queries.push(url);
        return openTabs.filter((tab) => tab.url.split('#')[0].startsWith(url.replace(/\*$/, '')));
      },
      create: async (value: any) => { tabs.push(value); },
      update: async (id: number, value: any) => { activations.push({ id, ...value }); },
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
  return { apps, tabs, queries, activations, reloads, authority, run, sessions, cache, creates: () => creates,
    current: (): string|null => cache.get('currentSessionId') ?? null };
};

describe('sealed App semantic routes', () => {
  const appPage = 'chrome-extension://id/engine-tabs/app-tab/index.html';

  test('reuses the exact owner URL with fragment-free lookup and activation only', async () => {
    const state = makeState(false, false, [
      { id: 11, url: `${appPage}#other?owner=chat` },
      { id: 12, url: `${appPage}#a?owner=other` },
      { id: 13, url: `${appPage}.other#a?owner=chat` },
      { id: 14, url: `${appPage}#a?owner=chat` },
    ]);
    await expect(state.run('apps/open', { appId: 'a' })).resolves.toEqual({ ok: true });
    await expect(state.run('apps/open', { appId: 'a' })).resolves.toEqual({ ok: true });
    expect(state.tabs).toEqual([]);
    expect(state.activations).toEqual([{ id: 14, active: true }, { id: 14, active: true }]);
    expect(state.queries).toEqual([`${appPage}*`, `${appPage}*`]);
    expect(state.apps.a.defaultSessionId).toBe('chat');
  });

  test.each([
    ['another App', `${appPage}#other?owner=chat`],
    ['another owner', `${appPage}#a?owner=other`],
    ['another resource', `${appPage}.other#a?owner=chat`],
    ['an extra query', `${appPage}?extra=1#a?owner=chat`],
    ['no owner', `${appPage}#a`],
  ])('does not reuse %s as the requested App owner', async (_name, url) => {
    const state = makeState(false, false, [{ id: 11, url }]);
    await expect(state.run('apps/open', { appId: 'a' })).resolves.toEqual({ ok: true });
    expect(state.activations).toEqual([]);
    expect(state.tabs).toEqual([{ url: `${appPage}#a?owner=chat`, active: true }]);
  });

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

  const makeNetworkState = () => {
    const host = 'chrome-extension://id/engine-tabs/game-tab/index.html';
    const apps: Record<string, { id: string, name: string, fileTree?: object, networkAllowed?: boolean }> = {
      'app-game': { id: 'app-game', name: 'Racer', fileTree: { hash: 'f'.repeat(64) } },
      'app-small': { id: 'app-small', name: 'Small' },
    };
    const openTabs = [
      { id: 1, url: `${host}#app-game/${'f'.repeat(64)}` },
      { id: 2, url: 'https://app-game.localhost/index.html' },
      { id: 3, url: `${host}#app-other/${'e'.repeat(64)}` },
      { id: 4, url: 'https://app-other.localhost/index.html' },
    ];
    const audit: unknown[] = [];
    const removed: number[][] = [];
    const authority = createKernelSemanticAuthority({
      idb: {}, kv: {}, ready: Promise.resolve(),
      auditLog: { append: async (event: unknown) => { audit.push(event); } },
      vault: { isLocked: () => false, getSecret: async () => null },
      appCatalog: {
        get: async (id: string) => apps[id] ?? null,
        setNetworkAllowed: async (id: string, allowed: boolean) => apps[id]
          ? (apps[id] = { ...apps[id], networkAllowed: allowed }) : null,
      },
      browser: { tabs: {
        query: async () => openTabs,
        remove: async (ids: number[]) => { removed.push(ids); },
      } },
      appTabUrl: 'chrome-extension://id/engine-tabs/app-tab/index.html',
    });
    return { apps, audit, removed, authority, run: semanticCaller(authority) };
  };

  test('game internet access writes the flag, audits it, and closes only that game', async () => {
    const state = makeNetworkState();
    await expect(state.run('apps/network', { appId: 'app-game', allowed: true })).resolves.toEqual({
      ok: true, closed: true, app: { id: 'app-game', name: 'Racer', fileTree: { hash: 'f'.repeat(64) }, networkAllowed: true },
    });
    await expect(state.run('apps/network', { appId: 'app-game', allowed: false }))
      .resolves.toMatchObject({ ok: true, closed: true, app: { networkAllowed: false } });
    expect(state.removed).toEqual([[1, 2], [1, 2]]);
    expect(state.audit).toEqual([
      { type: 'permission_granted', details: { kind: 'app-network', id: 'app-game', name: 'Racer' } },
      { type: 'permission_revoked', details: { kind: 'app-network', id: 'app-game', name: 'Racer' } },
    ]);
  });

  test('game internet access refuses bad input, a small app, and an unknown app with no effect', async () => {
    const state = makeNetworkState();
    await expect(state.run('apps/network', { appId: 'app-game', allowed: 'yes' }))
      .resolves.toEqual({ ok: false, error: 'allowed-boolean-required' });
    await expect(state.run('apps/network', { allowed: true }))
      .resolves.toEqual({ ok: false, error: 'appId-required' });
    await expect(state.run('apps/network', { appId: 'app-small', allowed: true }))
      .resolves.toEqual({ ok: false, error: 'network-unsupported' });
    await expect(state.run('apps/network', { appId: 'app-missing', allowed: true }))
      .resolves.toEqual({ ok: false, error: 'app-not-found' });
    expect(state.apps['app-small']).not.toHaveProperty('networkAllowed');
    expect(state.audit).toEqual([]);
    expect(state.removed).toEqual([]);
  });

  test('game internet access is bound to the app that the request names', async () => {
    const state = makeNetworkState();
    const context = {
      authority: { target: 'semantic:apps/network:first-party', instanceId: 'app-game' },
      outerPayload: { message: { appId: 'app-game' } },
    };
    await expect(state.authority.handle('semantic.apps.network', { appId: 'app-small', allowed: true }, context))
      .resolves.toEqual({ ok: false, code: 'semantic-app-target-denied', outcomeKnown: true });
    await expect(state.authority.handle('semantic.apps.network', { appId: 'app-game', allowed: true }, {
      ...context, authority: { target: 'semantic:apps/favorite:first-party', instanceId: 'app-game' },
    })).resolves.toEqual({ ok: false, code: 'semantic-kernel-operation-denied', outcomeKnown: true });
    expect(state.apps['app-game']).not.toHaveProperty('networkAllowed');
    expect(state.audit).toEqual([]);
  });

  test('a failed tab close keeps the change and reports closed: false', async () => {
    const state = makeNetworkState();
    const authority = createKernelSemanticAuthority({
      idb: {}, kv: {}, ready: Promise.resolve(), auditLog: { append: async () => {} },
      vault: { isLocked: () => false, getSecret: async () => null },
      appCatalog: {
        get: async (id: string) => state.apps[id] ?? null,
        setNetworkAllowed: async (id: string, allowed: boolean) => (state.apps[id] = { ...state.apps[id], networkAllowed: allowed }),
      },
      browser: { tabs: { query: async () => { throw new Error('tabs unavailable'); } } },
      appTabUrl: 'chrome-extension://id/engine-tabs/app-tab/index.html',
    });
    await expect(semanticCaller(authority)('apps/network', { appId: 'app-game', allowed: true }))
      .resolves.toMatchObject({ ok: true, closed: false, app: { networkAllowed: true } });
  });
});
