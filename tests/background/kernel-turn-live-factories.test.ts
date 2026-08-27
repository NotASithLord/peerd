import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { createKernelTurnLiveFactories } from '../../extension/background/kernel-turn-live-factories.js';
import { createSessionStore, makeTurnSlots } from '../../extension/peerd-runtime/background.js';
import { buildAppManifest } from '../../extension/peerd-engine/app-manifest.js';
import { createContextSnapshots } from '../../extension/background/context-snapshots.js';
import { createScriptRunRegistry } from '../../extension/background/script-runs.js';
import { projectControllerToolSurface } from '../../extension/peerd-runtime/controller-tool-projection.js';

const event = () => {
  const listeners = new Set<(...args: any[]) => void>();
  return {
    addListener: (listener: (...args: any[]) => void) => listeners.add(listener),
    removeListener: (listener: (...args: any[]) => void) => listeners.delete(listener),
    emit: (...args: any[]) => listeners.forEach((listener) => listener(...args)),
  };
};

const memoryStore = () => {
  const stores = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  return {
    get: async (store: string, key: string) => table(store).get(key),
    getMany: async (store: string, keys: string[]) => keys.map((key) => table(store).get(key)),
    getAll: async (store: string) => [...table(store).values()],
    put: async (store: string, value: any) => {
      const key = value.id ?? value.sessionId ?? value.key ?? value.origin;
      table(store).set(key, structuredClone(value));
    },
    del: async (store: string, key: string) => table(store).delete(key),
  };
};

const registry = (records: any[]) => {
  const byId = new Map(records.map((record) => [record.id, record]));
  const actorSessions = new Map<string, string>();
  const defaults = new Map<string, string>();
  return {
    get: async (id: string) => byId.get(id) ?? null,
    list: async () => [...byId.values()],
    create: async (record: any) => { byId.set(record.id, record); return record; },
    remove: async (id: string) => byId.delete(id),
    getActorSession: async (id: string) => actorSessions.get(id) ?? null,
    setActorSession: async (id: string, sessionId: string) => { actorSessions.set(id, sessionId); },
    getDefaultForSession: async (sessionId: string) => defaults.get(sessionId) ?? null,
    setDefaultForSession: async (sessionId: string, id: string) => { defaults.set(sessionId, id); },
  };
};

const tracker = (kind: 'vm'|'notebook'|'pod'|'app') => {
  const tabs = new Map<string, number>();
  const owners = new Map<string, string>();
  const prefix = `${kind}://`;
  const parse = (url: string) => typeof url === 'string' && url.startsWith(prefix)
    ? url.slice(prefix.length).split('?', 1)[0] : null;
  return {
    parseVmIdFromUrl: parse,
    parseIdFromUrl: parse,
    parseOwnerFromUrl: (url: string) => {
      try { return new URL(url.replace(prefix, 'https://host/')).searchParams.get('owner'); }
      catch { return null; }
    },
    onTabPending: (id: string, tabId: number, owner?: string) => {
      tabs.set(id, tabId);
      if (owner) owners.set(id, owner);
    },
    onTabReady: (id: string, tabId: number, owner?: string, ownerRoot?: string) => {
      tabs.set(id, tabId);
      if (ownerRoot || owner) owners.set(id, ownerRoot ?? owner!);
    },
    onTabFailed: (id: string) => tabs.delete(id),
    onTabRemoved: (tabId: number) => {
      const found = [...tabs].find(([, value]) => value === tabId);
      if (!found) return null;
      tabs.delete(found[0]); owners.delete(found[0]); return found[0];
    },
    markReloading: () => {},
    getTabId: (id: string) => tabs.get(id) ?? null,
    reconcileTabClaim: async (id: string, _claimantTabId?: number) => tabs.get(id) ?? null,
    getOwnedTabId: (id: string, owner: string) => owners.get(id) === owner
      ? tabs.get(id) ?? null : null,
    listLive: () => [...tabs.keys()],
  };
};

const harness = async (
  actorRun?: (job: any, options: any, config: any) => Promise<any>,
  options: {
    restoredApp?: boolean,
    networkSync?: () => Promise<void>,
    networkAdmission?: (tabId: number, url: string) => Promise<{ ok: boolean }>,
    firefox?: boolean,
    firefoxActorLifetime?: any,
    loadDirectActorHost?: () => Promise<any>,
    contributor?: any,
  } = {},
) => {
  const idb = memoryStore();
  let sessionSequence = 0;
  const sessions = createSessionStore({
    idb, now: () => 1_000, makeId: () => `session-${++sessionSequence}`,
  });
  const root = await sessions.create({
    provider: 'anthropic', model: 'claude-sonnet-4-6',
    permissionMode: 'act', confirmActions: false,
    toolManifest: {
      allow: [
        'message_actor', 'actor_list', 'actor_create',
        'app_observe', 'app_act', 'app_code',
      ],
    },
  });
  const appManifest = JSON.stringify({
    ...buildAppManifest({ entry: 'index.html', dwapp: true }),
    agent: {
      kind: 'bound-app', profile: 'developer', surface: 'code',
      name: 'Todo builder', instructions: 'Maintain the todo app.',
      runtime: ['observe', 'act'],
    },
  });
  const appNetworkAdmissions: [number, string][] = [];
  const appNetworkTabs = new Set<number>();
  const vmRegistry = registry([{ id: 'vm-1', name: 'VM' }]);
  const jsRegistry = registry([{ id: 'notebook-1', name: 'Notebook' }]);
  const podRegistry = registry([{ id: 'pod-1', name: 'Pod' }]);
  const appRegistry = registry([{
    id: 'app-1', name: 'Todo', ownerSessionId: root.sessionId,
    source: 'dweb', dweb: { publisher: 'did:key:alice' },
  }]);
  const vmTabTracker = tracker('vm');
  const jsTabTracker = tracker('notebook');
  const podTabTracker = tracker('pod');
  const appTabTracker = tracker('app');
  const tabs = new Map<number, any>([
    [9, { id: 9, windowId: 1, url: 'https://example.com/work', title: 'Example', active: true }],
    [17, { id: 17, windowId: 1, url: `app://app-1?owner=${root.sessionId}`, active: false }],
  ]);
  appTabTracker.reconcileTabClaim = async (id: string, claimantTabId?: number) => {
    const liveTabId = appTabTracker.getTabId(id);
    if (liveTabId == null || liveTabId === claimantTabId) return liveTabId;
    const live = tabs.get(liveTabId);
    if (live && appTabTracker.parseIdFromUrl(live.url) === id) return liveTabId;
    appTabTracker.onTabRemoved(liveTabId);
    return null;
  };
  const notifications: any[] = [];
  const panelBehavior: any[] = [];
  const siteCaptureEvents: any[] = [];
  let providerRevision = 0;
  const tabEvents = { onCreated: event(), onUpdated: event(), onRemoved: event(), onActivated: event() };
  const browser: any = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      getManifest: () => ({ manifest_version: 3 }),
      sendMessage: async () => ({ ok: true }),
    },
    tabs: {
      ...tabEvents,
      get: async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error('tab-not-found');
        return tab;
      },
      query: async (query: any = {}) => {
        const all = [...tabs.values()];
        if (typeof query.url === 'string') {
          const prefix = query.url.replace(/\*$/, '');
          return all.filter((tab) => tab.url.startsWith(prefix));
        }
        if (query.active) return all.filter((tab) => tab.active);
        return all;
      },
      create: async ({ url, active }: any) => {
        const id = 100 + tabs.size;
        const tab = { id, windowId: 1, url, active };
        tabs.set(id, tab);
        return tab;
      },
      remove: async (tabId: number) => { tabs.delete(tabId); },
      update: async (tabId: number, patch: any) => Object.assign(tabs.get(tabId), patch),
      reload: async () => {},
      sendMessage: async () => ({ ok: true, value: { text: 'app response' } }),
    },
    scripting: { executeScript: async () => [] },
    windows: {
      WINDOW_ID_NONE: -1, onFocusChanged: event(),
      getLastFocused: async () => ({ id: 1, focused: true }), update: async () => {},
    },
    action: { onClicked: event() },
    commands: { onCommand: event(), getAll: async () => [] },
    sidePanel: {
      setOptions: async () => {},
      setPanelBehavior: async (value: any) => { panelBehavior.push(value); },
    },
    alarms: { create: () => {}, clear: async () => {} },
    notifications: { create: (value: any) => { notifications.push(value); } },
  };
  const storageState: Record<string, any> = {};
  browser.storage = { local: {
    get: async (key: string) => ({ [key]: storageState[key] }),
    set: async (items: Record<string, any>) => Object.assign(storageState, items),
    remove: async (key: string) => { delete storageState[key]; },
  } };
  const cache = new Map<string, any>([['currentSessionId', root.sessionId]]);
  const kvState = new Map<string, any>();
  const broadcasts: any[] = [];
  const sourceProjections: any[] = [];
  let actorConfig: any;
  const engine: any = {
    vmRegistry, jsRegistry, podRegistry, appRegistry,
    vmTabTracker, jsTabTracker, podTabTracker, appTabTracker,
    vmClient: { onTabClosed: () => {} }, jsClient: {}, podClient: {},
    appClient: {
      readFile: async ({ path }: any) => path === 'peerd.json' ? appManifest : '',
      withWriteLock: async (_id: string, operation: () => any) => operation(),
    },
    appQuiescence: {
      run: async (_id: string, operation: () => any) => operation(),
      runUnlocked: async (_id: string, operation: () => any) => operation(),
    },
    appCandidates: options.restoredApp ? [{
      appId: 'app-1', tabId: 17, ownerSessionId: root.sessionId,
      url: `app://app-1?owner=${root.sessionId}`,
    }] : [],
    repositories: {
      coordinate: async (_scope: any, operation: () => any) => operation(),
      statusApp: async () => ({ oid: null, changed: [] }),
      commitApp: async () => ({ oid: 'commit-1' }),
      diffApp: async () => ({ files: [] }),
    },
    opfsHelpers: () => ({ nuke: async () => {} }),
    withDwebPublication: async (operation: (current: () => boolean) => any) => operation(() => true),
    dwebPublicationGeneration: () => 1,
  };
  const settings: any = {
    providerName: 'anthropic', providerModel: 'claude-sonnet-4-6',
    permissionMode: 'act', confirmActions: false, reasoningEnabled: false,
    reasoningEffort: 'low', schemaValidatedReplies: false,
    spendLimitUsd: 20, dwebEnabled: false, dwebAgentEnabled: false,
    webActorActionSurface: 'tools', watchAgentTab: false, frontDoorView: 'panel',
  };
  const dependencies: any = {
    engine, browser, idb,
    vault: {
      isLocked: () => false, getSecret: async () => 'secret',
      listSecretNames: async () => [],
      subscribe: () => () => {},
    },
    settingsStore: {
      get: () => settings,
      update: async (patch: any) => Object.assign(settings, patch),
    },
    seams: {
      renderSystemPrompt: async () => 'system',
      projectTurnTools: async (input: unknown) => {
        const result = projectControllerToolSurface(input);
        if (result.ok !== true) throw new Error(result.code);
        return result.tools;
      },
    },
    confirmation: { confirm: async () => 'yes_once' },
    denylist: { ready: async () => ({ ok: true }), patterns: () => [] },
    featureHost: {
      ensureOffscreen: async () => {},
      runtime: {
        ready: Promise.resolve(),
        runWithLease: async (_scope: string, operation: (lease?: any) => any) => operation({}),
      },
    },
    auditLog: { append: async () => {} },
    kv: {
      get: async (key: string) => kvState.get(key) ?? null,
      set: async (key: string, value: any) => { kvState.set(key, structuredClone(value)); },
    },
    sessionCache: {
      sessionGet: async (key: string) => cache.get(key) ?? null,
      sessionSet: async (key: string, value: any) => { cache.set(key, structuredClone(value)); },
    },
    canWrite: () => {}, ready: Promise.resolve(),
    contextSnapshots: createContextSnapshots(),
    scriptRuns: createScriptRunRegistry(),
    postChatNote: () => {}, pushState: async () => {},
    dwebEnabled: false, firefox: options.firefox === true,
    firefoxActorLifetime: options.firefoxActorLifetime,
    loadDirectActorHost: options.loadDirectActorHost,
    channel: 'dev', offscreenUrl: 'offscreen.html',
    contributor: options.contributor ?? null,
    dispatchEffectsRequired: true,
    isOffscreenSender: () => true,
    isTrustedSender: (sender: any) => typeof sender?.tab?.id === 'number',
    networkCustody: {
      sync: options.networkSync ?? (async () => {}),
      admitAppTab: async (tabId: number, url: string) => {
        appNetworkAdmissions.push([tabId, url]);
        const result = await (options.networkAdmission?.(tabId, url)
          ?? Promise.resolve({ ok: true }));
        if (result.ok) appNetworkTabs.add(tabId);
        return result;
      },
      state: () => ({
        supported: true, lastError: null, tabs: [...appNetworkTabs],
      }),
    },
    updateBrowserSourceProjection: async (bindings: any, projection: any) => {
      sourceProjections.push(structuredClone({ bindings, projection }));
    },
    providerProjection: { bumpRevision: () => { providerRevision += 1; } },
    providerEgress: {},
    resolveProviderSelection: async () => ({
      ok: true, selected: 'anthropic::claude-sonnet-4-6',
    }),
    siteCapture: {
      has: (tabId: number) => tabId === 9,
      cancel: async (value: any) => { siteCaptureEvents.push(['cancel', value]); },
      release: (tabId: number) => { siteCaptureEvents.push(['release', tabId]); },
    },
    makeActorClient: (config: any) => {
      actorConfig = config;
      return {
        routes: {},
        run: (job: any, options: any) => actorRun
          ? actorRun(job, options, config)
          : Promise.resolve({
            ok: true, started: true,
            newMessages: [{ role: 'assistant', content: 'done', id: `a-${Date.now()}`, when: Date.now() }],
            usage: { inputTokens: 3, outputTokens: 2 },
          }),
      };
    },
  };
  const factories = createKernelTurnLiveFactories(dependencies);
  const shared: any = {
    sessions,
    memory: { list: async () => [], get: async () => null, search: async () => [] },
    turnSlots: makeTurnSlots(),
    pageActivity: {
      begin: async () => {}, end: async () => {}, idle: async () => {},
      release: async () => {}, markedTabs: () => [],
    },
    uiPorts: {
      size: 1, broadcast: (message: any) => broadcasts.push(message), hasNamed: () => false,
    },
  };
  const runtime = await factories.makeActorRuntime(shared);
  return {
    factories, runtime, shared, root, sessions, engine, browser, tabs,
    broadcasts, storageState, kvState, cache, settings, notifications, panelBehavior,
    siteCaptureEvents, providerRevision: () => providerRevision,
    sourceProjections,
    appNetworkAdmissions,
    actorConfig: () => actorConfig,
  };
};

const dependencies = () => ({
  engine: {},
  browser: { runtime: { sendMessage: async () => null }, tabs: {} },
  vault: { listSecretNames: async () => [] },
  settingsStore: { get: () => ({}) },
  seams: {},
  confirmation: {},
  denylist: { patterns: () => [] },
  featureHost: {
    ensureOffscreen: async () => {},
    runtime: { runWithLease: async (_scope: string, operation: () => any) => operation() },
  },
  auditLog: { append: async () => {} },
  kv: { get: async () => null, set: async () => {} },
  sessionCache: {
    sessionGet: async () => null,
    sessionSet: async () => {},
  },
  canWrite: () => {},
  contextSnapshots: createContextSnapshots(),
  scriptRuns: createScriptRunRegistry(),
  providerEgress: {},
  resolveProviderSelection: async () => ({
    ok: true, selected: 'anthropic::claude-sonnet-4-6',
  }),
});

describe('kernel live turn factories', () => {
  test('constructs the complete production factory surface without host effects', () => {
    const factories = createKernelTurnLiveFactories(dependencies());
    expect(Object.keys(factories).sort()).toEqual([
      'buildToolContext', 'goalMaxIterations', 'makeActorRuntime', 'makeDriver',
      'makeDriverDeps', 'makeGoals', 'makeRouteDeps',
    ]);
  });

  test('rejects a partial production graph before creating state', () => {
    expect(() => createKernelTurnLiveFactories({})).toThrow(
      'kernel-turn-live-config-invalid',
    );
  });

  test('routes Firefox heartbeat loss into the direct actor host', async () => {
    let onLost = (_error: Error) => {};
    const losses: string[] = [];
    await harness(undefined, {
      firefox: true,
      firefoxActorLifetime: {
        createHandle: (options: any) => {
          onLost = options.onLost;
          return { start: async () => {}, stop: async () => {} };
        },
      },
      loadDirectActorHost: async () => ({
        makeDirectActorHost: () => ({
          sendMessage: async () => ({ ok: true }),
          bindRelayRoutes: () => {},
          isRelaySender: () => false,
          failKeepAlive: (error: Error) => { losses.push(error.message); },
        }),
      }),
    });

    onLost(new Error('storage heartbeat failed'));

    expect(losses).toEqual(['storage heartbeat failed']);
  });

  test('validates every engine attach and binds App provenance to one owner generation', async () => {
    const h = await harness();
    const routes = h.runtime.relays.engineRoutes;
    expect(await routes['vm/tab-ready'](
      { vmId: 'vm-1' }, { tab: { id: 21, url: 'vm://vm-1' } },
    )).toBe(false);
    expect(await routes['js/tab-ready'](
      { notebookId: 'notebook-1' }, { tab: { id: 22, url: 'notebook://notebook-1' } },
    )).toBe(false);
    expect(await routes['pod/tab-adopt'](
      { podId: 'pod-1' }, { tab: { id: 23, url: 'pod://pod-1' } },
    )).toEqual({ ok: true });
    expect(await routes['vm/tab-ready'](
      { vmId: 'vm-1' }, { tab: { id: 24, url: 'vm://other' } },
    )).toBe(false);

    const attached: any = await routes['app/tab-ready'](
      { appId: 'app-1', ownerSessionId: h.root.sessionId },
      { tab: { id: 17, url: `app://app-1?owner=${h.root.sessionId}` } },
    );
    expect(attached.ok).toBe(true);
    expect(h.appNetworkAdmissions).toEqual([
      [17, `app://app-1?owner=${h.root.sessionId}`],
    ]);
    const actor = await h.sessions.get(attached.actorSessionId);
    expect(actor).toMatchObject({
      kind: 'actor', actorType: 'app', instanceId: 'app-1',
      parentSessionId: h.root.sessionId, actorSurface: 'code',
      appRole: { source: 'dweb', publisher: 'did:key:alice', name: 'Todo builder' },
    });
    expect(actor?.appManifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(actor?.appOwnerAuthorityDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(await routes['app/actor-retry'](
      { appId: 'app-1', ownerSessionId: 'wrong-owner' },
      { tab: { id: 17, url: `app://app-1?owner=${h.root.sessionId}` } },
    )).toEqual({ ok: false, error: 'app-tab-owner-mismatch' });
  });

  test('attaches a Firefox App only after exact network admission', async () => {
    const h = await harness(undefined, { firefox: true });
    const url = `app://app-1?owner=${h.root.sessionId}`;
    const attached: any = await h.runtime.relays.engineRoutes['app/tab-ready'](
      { appId: 'app-1', ownerSessionId: h.root.sessionId },
      { tab: { id: 17, url } },
    );
    expect(attached.ok).toBe(true);
    expect(h.appNetworkAdmissions).toEqual([[17, url]]);
    expect(h.engine.appTabTracker.getTabId('app-1')).toBe(17);
  });

  test('reconciles a navigated App claim before accepting its replacement tab', async () => {
    const h = await harness(undefined, { firefox: true });
    const owner = h.root.sessionId;
    expect((await h.runtime.relays.engineRoutes['app/tab-ready'](
      { appId: 'app-1', ownerSessionId: owner },
      { tab: { id: 17, url: `app://app-1?owner=${owner}` } },
    ) as any).ok).toBe(true);
    h.tabs.get(17).url = 'home://root';
    h.tabs.set(18, { id: 18, url: `app://app-1?owner=${owner}` });
    expect((await h.runtime.relays.engineRoutes['app/tab-ready'](
      { appId: 'app-1', ownerSessionId: owner },
      { tab: { id: 18, url: `app://app-1?owner=${owner}` } },
    ) as any).ok).toBe(true);
    expect(h.engine.appTabTracker.getTabId('app-1')).toBe(18);
  });

  test('refuses an App when exact network admission fails', async () => {
    const h = await harness(undefined, {
      firefox: true,
      networkAdmission: async () => ({ ok: false }),
    });
    const attached: any = await h.runtime.relays.engineRoutes['app/tab-ready'](
      { appId: 'app-1', ownerSessionId: h.root.sessionId },
      { tab: { id: 17, url: `app://app-1?owner=${h.root.sessionId}` } },
    );
    expect(attached).toMatchObject({ ok: false });
    expect(h.engine.appTabTracker.getTabId('app-1')).toBeNull();
  });

  test('persists a fingerprinted web source projection and refreshes it on navigation', async () => {
    const h = await harness(undefined, { firefox: true });
    const ctx: any = await h.factories.buildToolContext({
      sessionId: h.root.sessionId,
      actorType: 'web', actorBacking: 'tab', exposure: 'actor',
    });
    const adopted = await ctx.adoptWebTab();
    const first = h.cache.get('webActorSourceProjection.v1');
    expect(first).toEqual([{
      tabId: adopted.tabId, sessionId: h.root.sessionId, url: 'about:blank',
      openerTabId: null, cookieStoreId: null,
    }]);
    expect(h.sourceProjections.at(-1)?.projection).toEqual(first);
    const tab = h.tabs.get(adopted.tabId);
    tab.url = 'https://public.example/next';
    await h.runtime.relays.eventOwners.onUpdated(adopted.tabId, { url: tab.url }, tab);
    expect(h.cache.get('webActorSourceProjection.v1')?.[0]?.url).toBe(tab.url);
    expect(h.sourceProjections.at(-1)?.projection?.[0]?.url).toBe(tab.url);
  });

  test('restored App network admission waits only for hydrated trackers', async () => {
    let pending!: ReturnType<typeof harness>;
    const stages: string[] = [];
    pending = harness(undefined, {
      restoredApp: true,
      networkAdmission: async () => {
        stages.push('network-start');
        const h = await pending;
        await h.runtime.relays.eventOwners.reconcileTrackers();
        stages.push('network-ready');
        return { ok: true };
      },
    });
    const h = await pending;
    expect(h.runtime.relays.engineTrackersHydrated)
      .not.toBe(h.runtime.relays.engineReady);
    const settled = await Promise.race([
      h.runtime.relays.engineReady.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(settled).toBe(true);
    expect(stages).toEqual(['network-start', 'network-ready']);
    expect(h.engine.appTabTracker.getTabId('app-1')).toBe(17);
  });

  test('runs a bound actor with projection and spend gates, then replays live state', async () => {
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => { releaseRun = resolve; });
    const jobs: any[] = [];
    const h = await harness(async (job, options) => {
      if (job.probeOnly) return { ok: true };
      jobs.push(job);
      options.onEvent?.({ type: 'state', session: {
        sessionId: job.actorSessionId,
        messages: [{ role: 'assistant', content: 'working', id: 'state-1' }],
      } });
      await runGate;
      return {
        ok: true, started: true,
        newMessages: [{ role: 'assistant', content: 'finished', id: 'done-1', when: 2_000 }],
        usage: { inputTokens: 7, outputTokens: 5 },
        price: { cost: 0.000096, estimated: true },
      };
    });
    const ctx: any = await h.factories.buildToolContext({ sessionId: h.root.sessionId });
    const reply = ctx.messageActor({
      to: '9', message: 'inspect the page', senderSessionId: h.root.sessionId,
      toolUseId: 'tool-1', awaitReply: true,
    });
    for (let attempt = 0; jobs.length === 0 && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(h.broadcasts.some((message) => message.type === 'turn/actor-start')).toBe(true);
    expect(h.broadcasts.some((message) => message.type === 'turn/actor-state')).toBe(true);
    const replay: any[] = [];
    await h.runtime.relays.onUiConnect({ postMessage: (message: any) => replay.push(message) });
    expect(replay.some((message) => message.type === 'turn/actor-start')).toBe(true);
    const actorSessionId = jobs[0].actorSessionId;
    await h.sessions.update(actorSessionId, { cost: { cost: 25 } });
    expect(await h.actorConfig().spendRefusalFor(actorSessionId)).toContain('spend limit');
    releaseRun();
    expect(await reply).toMatchObject({ ok: true, content: expect.stringContaining('finished') });
    expect(h.broadcasts.some((message) => message.type === 'turn/actor-cost')).toBe(true);
    expect(h.broadcasts.some((message) => message.type === 'turn/actor-done')).toBe(true);
  });

  test('records an armed tab-Web actor settlement through the production owner', async () => {
    const calls: any[] = [];
    const contributor = {
      arm: async () => ({ enabled: true, generation: 'generation-1' }),
      recordWebSettlement: async (input: any) => {
        calls.push(input);
        return { ok: true, recorded: true };
      },
    };
    const h = await harness(async (job) => ({
      ok: true, started: true,
      newMessages: [{
        role: 'assistant', content: 'finished', id: 'done-contributor', when: 2_000,
        stopReason: 'end_turn', toolUses: [{ id: 'page-1', name: 'snapshot', input: {} }],
      }],
      usage: { inputTokens: 7, outputTokens: 5 },
      price: { cost: 0.000096, estimated: true },
    }), { contributor });
    const ctx: any = await h.factories.buildToolContext({ sessionId: h.root.sessionId });
    expect(await ctx.messageActor({
      to: '9', message: 'inspect the page', senderSessionId: h.root.sessionId,
      toolUseId: 'tool-contributor', awaitReply: true,
    })).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      consentGeneration: 'generation-1', feedbackContextKey: `${h.root.sessionId}:tool-contributor`,
      decision: { requested: 'tools', resolved: 'tools', fallback: 'none' },
      browser: 'chrome', channel: 'dev', provider: 'anthropic', model: 'claude-sonnet-4-6',
      toolNames: ['snapshot'], assistantMessages: [{ stopReason: 'end_turn' }],
      stopped: false,
      usage: { inputTokens: 7, outputTokens: 5 },
    });
    expect(calls[0].operationKey).toBeString();
  });

  test('pins App runtime calls to the exact owner tab', async () => {
    const h = await harness();
    const attached: any = await h.runtime.relays.engineRoutes['app/tab-ready'](
      { appId: 'app-1', ownerSessionId: h.root.sessionId },
      { tab: { id: 17, url: `app://app-1?owner=${h.root.sessionId}` } },
    );
    const ctx: any = await h.factories.buildToolContext({
      sessionId: attached.actorSessionId, exposure: 'actor',
      actorType: 'app', actorInstanceId: 'app-1', actorSurface: 'tools',
    });
    expect(await ctx.appAgentCall('observe', {}, undefined)).toEqual({
      ok: true, value: { text: 'app response' },
    });
    h.engine.appTabTracker.onTabRemoved(17);
    expect(await ctx.appAgentCall('act', {}, undefined)).toMatchObject({
      ok: false, error: 'app_runtime_tab_not_open_or_wrong_owner', outcomeKnown: true,
    });
  });

  test('injects an origin-pinned dossier and stops a bound helper on a foreign landing', async () => {
    let runNumber = 0;
    const jobs: any[] = [];
    const h = await harness(async (job, _options, config) => {
      runNumber += 1;
      jobs.push(job);
      const actorCtx = await config.buildToolContext({
        sessionId: job.actorSessionId, exposure: 'actor', actorType: 'web',
        actorBacking: 'tab', actorInstanceId: '9', activeTabId: 9,
      });
      if (runNumber === 1) {
        await actorCtx.siteClients.put({
          dossier: {
            origin: 'https://example.com', summary: 'Use the JSON task endpoint.',
            endpoints: [{ method: 'GET', path: '/api/tasks' }],
            auth: 'session', deriver: 'probe',
          },
          body: 'return { list: async () => [] };',
        });
      } else {
        await actorCtx.judgeLanding('https://elsewhere.example/');
      }
      return {
        ok: true, started: true,
        newMessages: [{ role: 'assistant', content: 'done', id: `site-${runNumber}`, when: 2_000 }],
      };
    });
    const ctx: any = await h.factories.buildToolContext({ sessionId: h.root.sessionId });
    expect(await ctx.messageActor({
      to: '9', message: 'learn the site', senderSessionId: h.root.sessionId,
      toolUseId: 'site-1', awaitReply: true,
    })).toMatchObject({ ok: true });
    const stopped = await ctx.messageActor({
      to: '9', message: 'continue', senderSessionId: h.root.sessionId,
      toolUseId: 'site-2', awaitReply: true,
    });
    expect(jobs[1].message).toContain('Use the JSON task endpoint.');
    expect(jobs[1].message).toContain('<untrusted_web_content');
    expect(stopped).toMatchObject({
      ok: false, actorOutcomeKnown: true, actorPerformed: true, actorTerminal: true,
    });
    expect(stopped.error).toContain('elsewhere.example');
  });

  test('tracks and transitively cancels an async child through the production context', async () => {
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
    const h = await harness(async (job) => {
      await childGate;
      return {
        ok: true, started: true,
        newMessages: [{ role: 'assistant', content: 'child result', id: 'child-1', when: 2_000 }],
      };
    });
    const ctx: any = await h.factories.buildToolContext({ sessionId: h.root.sessionId });
    const handle = await ctx.actorAuthority.spawnAsync({
      task: 'research safely', parentSessionId: h.root.sessionId,
      parentDepth: 0, parentToolUseId: 'spawn-1',
    });
    expect(handle).toMatchObject({ ok: true, taskId: 'as-1' });
    expect(ctx.actorAuthority.listTasks()).toEqual([
      expect.objectContaining({ taskId: 'as-1', status: 'running', childSessionId: expect.any(String) }),
    ]);
    expect(ctx.actorAuthority.cancelTask(handle.taskId)).toEqual({
      ok: true,
      content: expect.stringContaining('cancelled'),
    });
    expect(ctx.actorAuthority.listTasks()[0].status).toBe('cancelled');
    releaseChild();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.broadcasts.some((message) => message.type === 'turn/spawned-start')).toBe(true);
    expect(h.broadcasts.some((message) => message.type === 'async-tasks/update')).toBe(true);
  });

  test('persists an exhausted actor startup failure and clears it only after a healthy probe', async () => {
    let healthy = false;
    let attempts = 0;
    const h = await harness(async (job) => {
      attempts += 1;
      if (healthy || job.probeOnly) return { ok: true, started: true };
      return {
        ok: false, started: false, phase: 'startup', outcomeKnown: true,
        code: 'actor_worker_spawn_failed', error: 'worker failed to start',
      };
    });
    const ctx: any = await h.factories.buildToolContext({ sessionId: h.root.sessionId });
    const refused = await ctx.messageActor({
      to: '9', message: 'inspect', senderSessionId: h.root.sessionId,
      toolUseId: 'isolation-1', awaitReply: true,
    });
    expect(refused).toMatchObject({ ok: false, actorTerminal: true, actorPerformed: false });
    expect(refused.error).toContain('isolated worker is temporarily unavailable');
    expect(attempts).toBe(2);
    const [failureKey] = Object.keys(h.storageState);
    expect(h.storageState[failureKey]).toMatchObject({
      status: 'temporarily_unavailable', code: 'actor_worker_spawn_failed',
    });
    healthy = true;
    const routeDeps = h.factories.makeRouteDeps(h.shared);
    expect(await routeDeps.isolation.retryActorIsolation()).toMatchObject({ ok: true });
    expect(h.storageState).toEqual({});
  });

  test('rehydrates scheduler custody, repairs provider selection, and applies live settings and capture transitions', async () => {
    const h = await harness();
    h.settings.providerName = 'missing-provider';
    h.settings.providerModel = '';
    const selected = await h.factories.makeDriverDeps(h.shared).ensureActiveProvider();
    expect(selected.name).toBe('anthropic');
    expect(h.settings.providerName).toBe('anthropic');
    expect(h.providerRevision()).toBe(1);

    const goalStarts: any[] = [];
    h.runtime.relays.bindGoalRunner({
      isActive: () => false,
      isPersisted: async () => false,
      activeStates: () => [],
      resume: async () => {},
      start: async (request: any) => { goalStarts.push(request); },
    });
    const now = Date.now();
    h.kvState.set('schedule.routines.v1', {
      routine: {
        id: 'routine', prompt: 'check the build',
        schedule: { kind: 'interval', everyMs: 60_000 }, mode: 'goal', enabled: true,
        createdAt: now - 120_000, nextRunAt: now - 1,
        lastRunAt: null, lastSessionId: null, runCount: 0,
        pendingRunAt: null, lastOutcomeUnknownAt: null,
      },
    });
    await h.runtime.relays.resumeSchedules();
    expect(goalStarts).toHaveLength(1);
    expect(goalStarts[0].goal).toBe('check the build');
    const scheduled = (await h.sessions.list()).find((record: any) => record.routineId === 'routine');
    expect(scheduled).toMatchObject({ permissionMode: 'act', confirmActions: false });
    expect(h.notifications).toContainEqual(expect.objectContaining({ title: 'peerd routine running' }));

    await h.runtime.relays.onSettingsChanged({ frontDoorView: 'home' });
    expect(h.panelBehavior.length).toBeGreaterThan(0);
    h.runtime.relays.eventOwners.onUpdated(9, { status: 'loading' }, h.tabs.get(9));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.siteCaptureEvents).toContainEqual(['cancel', { tabId: 9, reason: 'page_changed' }]);
    await h.runtime.relays.eventOwners.onRemoved(9);
    expect(h.siteCaptureEvents).toContainEqual(['release', 9]);
  });
});
