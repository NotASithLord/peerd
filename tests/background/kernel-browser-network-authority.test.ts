import { describe, expect, test } from 'bun:test';
import { createKernelBrowserNetworkAuthority } from '../../extension/background/kernel-browser-network-authority.js';

const publicTarget = (url: string) => {
  try {
    const parsed = new URL(url);
    return { allowed: parsed.protocol === 'http:' || parsed.protocol === 'https:' };
  } catch {
    return { allowed: false, reason: 'invalid_url' };
  }
};

const privateRuleUpdate = (input: any) => ({
  removeRuleIds: [1, 2, 10],
  addRules: input.tabIds.length ? [{
    id: 1, priority: 1, action: { type: 'block' },
    condition: {
      tabIds: [...input.tabIds], resourceTypes: [...input.resourceTypes],
      requestDomains: ['bank.example', 'login.example'],
    },
  }, {
    id: 2, priority: 2, action: { type: 'allow' },
    condition: {
      tabIds: [...input.tabIds], resourceTypes: [...input.resourceTypes],
      requestDomains: ['login.example'],
    },
  }, {
    id: 10, priority: 4, action: { type: 'block' },
    condition: {
      tabIds: [...input.tabIds],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      regexFilter: '^https?://127\\.0\\.0\\.1', isUrlFilterCaseSensitive: false,
    },
  }] : [],
});

const setup = (overrides: Record<string, any> = {}) => {
  const stored = new Map<string, any>(Object.entries(overrides.stored ?? {}));
  const tabs = new Map<number, any>((overrides.tabs ?? [
    { id: 1, url: 'https://one.example/' },
  ]).map((tab: any) => [tab.id, { ...tab }]));
  const browserCalls: any[] = [];
  const dnrCalls: any[] = [];
  const buildInputs: any[] = [];
  let dnrFails = false;
  let originPersistenceFails = false;
  let external = [...(overrides.external ?? [])];
  let apps = [...(overrides.apps ?? [])];
  let rules = structuredClone(overrides.rules ?? []);
  let dnrLane = Promise.resolve();
  const dnr = overrides.unsupported ? {} : {
    getSessionRules: async () => overrides.getDnr
      ? overrides.getDnr(rules) : structuredClone(rules),
    updateSessionRules: (update: any) => {
      const operation = dnrLane.then(async () => {
        dnrCalls.push(structuredClone(update));
        if (dnrFails) throw new Error('dnr-down');
        if (overrides.updateDnr) return overrides.updateDnr(update, rules, (next: any[]) => {
          rules = structuredClone(next);
        });
        rules = [
          ...rules.filter((rule: any) => !update.removeRuleIds.includes(rule.id)),
          ...(update.addRules ?? []),
        ];
      });
      dnrLane = operation.then(() => {}, () => {});
      return operation;
    },
  };
  const browser = {
    tabs: {
      get: async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error('missing-tab');
        return { ...tab };
      },
      query: async () => [...tabs.values()].map((tab) => ({ ...tab })),
      update: async (tabId: number, patch: any) => {
        browserCalls.push(['update', tabId, patch]);
        if (overrides.updateTab) {
          return overrides.updateTab(tabId, patch, tabs);
        }
        const tab = tabs.get(tabId);
        if (!tab) throw new Error('missing-tab');
        Object.assign(tab, patch);
        return { ...tab };
      },
      remove: async (tabId: number) => {
        browserCalls.push(['remove', tabId]);
        if (!tabs.delete(tabId)) throw new Error('missing-tab');
      },
    },
  };
  const sessionCache = {
    sessionGet: async (key: string) => {
      if (overrides.sessionGet) return overrides.sessionGet(key);
      return structuredClone(stored.get(key));
    },
    sessionSet: async (key: string, value: any) => {
      if (overrides.sessionSet) return overrides.sessionSet(key, value, stored);
      if (originPersistenceFails && key === 'guardedBrowserOriginDomains') {
        throw new Error('origin-storage-down');
      }
      stored.set(key, structuredClone(value));
    },
  };
  const unavailable = (reason: string) => ({ ok: false, reason });
  const authority = createKernelBrowserNetworkAuthority({
    browser,
    dnr,
    sessionCache,
    denylist: {
      ready: async () => overrides.denylistReady ?? { ok: true },
      patterns: () => ['bank.example'],
      blocks: overrides.denylistBlocks
        ?? ((hostname: string) => hostname === 'bank.example'),
    },
    buildRuleUpdate: overrides.buildRuleUpdate ?? ((input: any) => {
      buildInputs.push(structuredClone(input));
      return {
        removeRuleIds: [1, 10],
        addRules: input.tabIds.length ? [{
          id: 1,
          priority: 1,
          action: { type: 'block' },
          condition: {
            tabIds: [...input.tabIds],
            requestDomains: [...input.patterns],
            initiatorDomains: [...input.initiatorDomains],
          },
        }] : [],
      };
    }),
    privateNetworkRuleIds: overrides.privateNetworkRuleIds ?? [10],
    resourceTypes: overrides.resourceTypes ?? ['main_frame', 'xmlhttprequest'],
    idpExemptDomains: overrides.idpExemptDomains ?? ['login.example'],
    getExternalTabIds: () => external,
    getAppTabIds: () => apps,
    isWebActorTab: (tabId: number) => external.includes(tabId),
    webActorReady: overrides.webActorReady ?? Promise.resolve(),
    engineReady: overrides.engineReady ?? Promise.resolve(),
    ...(overrides.ensureExternalReady
      ? { ensureExternalReady: overrides.ensureExternalReady } : {}),
    classifyTarget: overrides.classifyTarget ?? publicTarget,
    unavailableResult: unavailable,
    ...(overrides.callbacks ?? {}),
    ...(overrides.startupGuard ? { startupGuard: overrides.startupGuard } : {}),
    ...(overrides.quarantineTimeoutMs
      ? { quarantineTimeoutMs: overrides.quarantineTimeoutMs } : {}),
    ...(overrides.quarantineClassificationMs
      ? { quarantineClassificationMs: overrides.quarantineClassificationMs } : {}),
    ...(overrides.quarantineRetryMs
      ? { quarantineRetryMs: overrides.quarantineRetryMs } : {}),
  });
  return {
    authority,
    browserCalls,
    buildInputs,
    dnrCalls,
    stored,
    tabs,
    rules: () => rules,
    failDnr: (value = true) => { dnrFails = value; },
    failOriginPersistence: (value = true) => { originPersistenceFails = value; },
    setExternal: (value: number[]) => { external = [...value]; },
    setApps: (value: number[]) => { apps = [...value]; },
  };
};

describe('kernel browser network authority', () => {
  test('verifies the exact installed App egress rule', async () => {
    let drifted = false;
    const harness = setup({
      tabs: [{ id: 4, url: 'moz-extension://peerd/app#one' }],
      external: [4], apps: [4], resourceTypes: ['main_frame', 'websocket'],
      buildRuleUpdate: (input: any) => ({
        removeRuleIds: [3],
        addRules: [{
          id: 3, priority: 3, action: { type: 'block' },
          condition: {
            regexFilter: '^(?:https?|wss?)://',
            tabIds: [...input.appTabIds],
            resourceTypes: [...input.resourceTypes],
          },
        }],
      }),
      getDnr: (rules: any[]) => drifted
        ? rules.map((rule) => ({
          ...rule,
          condition: { ...rule.condition, resourceTypes: ['main_frame'] },
        }))
        : structuredClone(rules),
    });

    await harness.authority.ready();
    await expect(harness.authority.verifyAppNetwork(4)).resolves.toBe(true);
    await expect(harness.authority.verifyAppNetwork(5)).resolves.toBe(false);
    drifted = true;
    await expect(harness.authority.verifyAppNetwork(4)).resolves.toBe(false);
  });

  test('hydrates one exact driven/App/origin projection with private and IdP policy inputs', async () => {
    const harness = setup({
      stored: {
        guardedBrowserTabIds: [1],
        guardedBrowserOriginDomains: [[1, ['old.example']]],
      },
      tabs: [
        { id: 1, url: 'https://old.example/' },
        { id: 2, url: 'https://web.example/' },
        { id: 3, url: 'https://vm.example/' },
        { id: 4, url: 'https://app.example/' },
      ],
      external: [1, 2, 3, 4],
      apps: [4],
    });

    await expect(harness.authority.ready()).resolves.toEqual({ ok: true });
    expect(harness.authority.status()).toMatchObject({
      supported: true,
      lastError: null,
      ready: true,
      tabs: [1, 2, 3, 4],
      origins: ['app.example', 'old.example', 'vm.example', 'web.example'],
    });
    expect(harness.buildInputs.at(-1)).toEqual({
      patterns: ['bank.example'],
      tabIds: [1, 2, 3, 4],
      initiatorDomains: ['app.example', 'old.example', 'vm.example', 'web.example'],
      resourceTypes: ['main_frame', 'xmlhttprequest'],
      exemptDomains: ['login.example'],
      appTabIds: [4],
    });
  });

  test('durably installs, updates, leases, releases, and removes exact tab custody', async () => {
    const harness = setup();
    await harness.authority.ready();
    harness.tabs.set(9, { id: 9, url: 'https://nine.example/' });

    await expect(harness.authority.ensureBrowserNetworkGuard(
      9, 'https://nine.example/start',
    )).resolves.toEqual({ ok: true });
    expect(harness.stored.get('guardedBrowserTabIds')).toEqual([9]);
    expect(harness.authority.status().origins).toEqual(['nine.example']);
    await expect(harness.authority.updateBrowserNetworkGuardOrigin(
      9, 'https://next.example/path',
    )).resolves.toEqual({ ok: true });
    expect(harness.authority.status().origins).toEqual(['next.example', 'nine.example']);

    const leased = await harness.authority.acquireBrowserNetworkGuardLease(12);
    expect(leased.ok).toBe(true);
    expect(harness.authority.status().tabs).toContain(12);
    await harness.authority.releaseBrowserNetworkGuardLease(leased.lease);
    expect(harness.authority.status().tabs).not.toContain(12);

    await harness.authority.onRemoved(9);
    expect(harness.stored.get('guardedBrowserTabIds')).toEqual([]);
    expect(harness.stored.get('guardedBrowserOriginDomains')).toEqual([]);
    expect(harness.buildInputs.at(-1).tabIds).not.toContain(9);
  });

  test('refuses unsupported browsers and rolls back a failed DNR installation', async () => {
    const unsupported = setup({ unsupported: true });
    await unsupported.authority.ready();
    unsupported.tabs.set(8, { id: 8, url: 'https://eight.example/' });
    await expect(unsupported.authority.ensureBrowserNetworkGuard(
      8, 'https://eight.example/',
    )).resolves.toEqual({ ok: false, reason: 'network_guard_unsupported' });

    const failed = setup();
    await failed.authority.ready();
    failed.tabs.set(9, { id: 9, url: 'https://nine.example/' });
    failed.failDnr();
    await expect(failed.authority.ensureBrowserNetworkGuard(
      9, 'https://nine.example/',
    )).resolves.toEqual({ ok: false, reason: 'network_guard_install_failed' });
    expect(failed.stored.get('guardedBrowserTabIds')).toEqual([]);
    expect(failed.stored.get('guardedBrowserOriginDomains')).toEqual([]);
    expect(failed.authority.status()).toMatchObject({
      ready: true,
      lastError: 'dnr-down',
    });
  });

  test('installs the injected portable Firefox rule posture without Chrome-only types', async () => {
    const harness = setup({
      external: [1],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest'],
    });
    await harness.authority.ready();

    expect(harness.buildInputs.at(-1)).toMatchObject({
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest'],
      exemptDomains: ['login.example'],
      tabIds: [1],
    });
    expect(harness.authority.status()).toMatchObject({
      supported: true,
      ready: true,
      lastError: null,
    });
  });

  test('settles failed hydration and keeps every later guard operation closed', async () => {
    const harness = setup({
      sessionGet: async (key: string) => {
        if (key === 'guardedBrowserTabIds') throw new Error('session-unavailable');
        return undefined;
      },
    });

    await expect(harness.authority.ready()).resolves.toMatchObject({
      ok: false,
      error: 'guarded_tabs_hydration_failed: session-unavailable',
    });
    await expect(harness.authority.updateBrowserNetworkGuardOrigin(
      1, 'https://one.example/',
    )).resolves.toEqual({ ok: false, reason: 'network_guard_install_failed' });
    expect(harness.authority.status()).toMatchObject({
      ready: false,
      startupError: 'guarded_tabs_hydration_failed: session-unavailable',
    });
  });

  test('keeps a volatile navigated origin closed until its snapshot persists', async () => {
    const harness = setup({ external: [1] });
    await harness.authority.ready();
    harness.failOriginPersistence();
    await harness.authority.onUpdated(1, { url: 'https://fail.example/' }, {
      id: 1, url: 'https://fail.example/',
    });
    expect(harness.authority.status().lastError).toBe('origin-storage-down');
    await expect(harness.authority.ensureBrowserNetworkGuard(
      1, 'https://fail.example/',
    )).resolves.toEqual({ ok: false, reason: 'network_guard_install_failed' });

    harness.failOriginPersistence(false);
    await harness.authority.onUpdated(1, { url: 'https://fail.example/' }, {
      id: 1, url: 'https://fail.example/',
    });
    expect(harness.authority.status().lastError).toBeNull();
    expect(harness.authority.status().origins).toContain('fail.example');
  });

  test('copies surviving startup rules only from an exact hydrated source', async () => {
    const guarded = setup({
      stored: { guardedBrowserTabIds: [1] },
      tabs: [
        { id: 1, url: 'https://source.example/' },
        { id: 9, url: 'https://child.example/' },
      ],
      rules: [{
        id: 10,
        priority: 4,
        action: { type: 'block' },
        condition: {
          tabIds: [1],
          resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
          regexFilter: '^https?://private', isUrlFilterCaseSensitive: false,
        },
      }],
    });
    const childFlow = guarded.authority.onNavigationTarget({
      sourceTabId: 1,
      tabId: 9,
      url: 'https://child.example/path',
    });
    guarded.setExternal([1]);
    await guarded.authority.ready();
    await childFlow;

    expect(guarded.dnrCalls.some((update) => update.addRules?.some((rule: any) =>
      rule.id === 10 && rule.condition.tabIds.includes(1)
        && rule.condition.tabIds.includes(9)))).toBe(true);
    expect(guarded.browserCalls).toContainEqual(['update', 9, { url: 'about:blank' }]);
    expect(guarded.browserCalls).toContainEqual([
      'update', 9, { url: 'https://child.example/path' },
    ]);
    expect(guarded.authority.status().tabs).toContain(9);

    const ordinary = setup({
      tabs: [
        { id: 8, url: 'https://user.example/' },
        { id: 10, url: 'https://ordinary.example/' },
      ],
    });
    const ordinaryFlow = ordinary.authority.onNavigationTarget({
      sourceTabId: 8,
      tabId: 10,
      url: 'https://ordinary.example/',
    });
    await ordinary.authority.ready();
    await ordinaryFlow;
    expect(ordinary.browserCalls).toEqual([]);
    expect(ordinary.authority.status().tabs).not.toContain(10);
  });

  test('never adopts a child that disappeared before rich custody', async () => {
    const harness = setup({
      tabs: [{ id: 1, url: 'https://source.example/' }],
      external: [1],
    });
    await harness.authority.ready();
    await harness.authority.onNavigationTarget({
      sourceTabId: 1, tabId: 9, url: 'https://child.example/',
    });
    expect(harness.authority.status().tabs).not.toContain(9);
    expect(harness.buildInputs.at(-1).tabIds).not.toContain(9);
    expect(harness.dnrCalls.every((update) => !update.addRules?.some((entry: any) =>
      entry?.condition?.tabIds?.includes(9)))).toBe(true);
  });

  test('keeps a recovered live child in the rich DNR projection', async () => {
    const startupIds = new Set([9]);
    const harness = setup({
      tabs: [
        { id: 1, url: 'https://source.example/' },
        { id: 9, openerTabId: 1, url: 'https://child.example/' },
      ],
      external: [1],
      startupGuard: {
        tabIds: () => [...startupIds],
        seal: async () => {}, release: async (tabId: number) => { startupIds.delete(tabId); },
        handoff: async (tabId: number) => { startupIds.delete(tabId); },
        adopt: async () => false,
      },
    });
    await harness.authority.ready();
    expect(harness.buildInputs.at(-1).tabIds).toEqual([1, 9]);
    expect(startupIds.has(9)).toBe(true);
    await harness.authority.onRemoved(9);
    expect(harness.buildInputs.at(-1).tabIds).toEqual([1]);
  });

  test('reconciles disappeared custody without replaying a browser event', async () => {
    const harness = setup();
    await harness.authority.ready();
    harness.tabs.set(7, { id: 7, url: 'https://seven.example/' });
    await harness.authority.ensureBrowserNetworkGuard(7, 'https://seven.example/');
    harness.tabs.delete(7);

    await harness.authority.reconcile();
    expect(harness.authority.status().tabs).not.toContain(7);
    expect(harness.authority.status().origins).not.toContain('seven.example');
    expect(harness.stored.get('guardedBrowserTabIds')).toEqual([]);
  });

  test('invalidates a closing generation while its durable write is pending', async () => {
    let releaseWrite = () => {};
    let markWriteStarted = () => {};
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let delayFirstAdd = true;
    const harness = setup({
      sessionSet: async (key: string, value: any, stored: Map<string, any>) => {
        if (key === 'guardedBrowserTabIds' && value.includes(9) && delayFirstAdd) {
          delayFirstAdd = false;
          markWriteStarted();
          await writeGate;
        }
        stored.set(key, structuredClone(value));
      },
    });
    await harness.authority.ready();
    harness.tabs.set(9, { id: 9, url: 'https://old.example/' });
    const installing = harness.authority.ensureBrowserNetworkGuard(9, 'https://old.example/');
    await writeStarted;
    harness.tabs.delete(9);
    const closing = harness.authority.onRemoved(9);
    releaseWrite();

    await expect(installing).resolves.toEqual({
      ok: false,
      reason: 'network_guard_install_failed',
    });
    await closing;
    expect(harness.stored.get('guardedBrowserTabIds')).toEqual([]);

    harness.tabs.set(9, { id: 9, url: 'https://new.example/' });
    await expect(harness.authority.ensureBrowserNetworkGuard(
      9, 'https://new.example/',
    )).resolves.toEqual({ ok: true });
    expect(harness.authority.status().origins).toEqual(['new.example']);
  });

  test('drops a hydrated numeric tab id not proven by restored tracker ownership', async () => {
    const updates: any[] = [];
    const session = new Map<string, any>([
      ['guardedBrowserTabIds', [41]],
      ['guardedBrowserOriginDomains', [{ tabId: 41, domain: 'user.example' }]],
    ]);
    const authority = createKernelBrowserNetworkAuthority({
      browser: {
        tabs: {
          query: async () => [{ id: 41, url: 'https://user.example/' }],
          get: async (tabId: number) => tabId === 41
            ? { id: 41, url: 'https://user.example/' } : null,
          update: async () => {}, remove: async () => {},
        },
      },
      dnr: {
        getSessionRules: async () => [],
        updateSessionRules: async (update: any) => { updates.push(update); },
      },
      sessionCache: {
        sessionGet: async (key: string) => session.get(key),
        sessionSet: async (key: string, value: any) => { session.set(key, value); },
      },
      denylist: { ready: async () => ({ ok: true }), patterns: () => [], blocks: () => false },
      buildRuleUpdate: ({ tabIds }: any) => ({ removeRuleIds: [1], addRules: tabIds.length ? [{}] : [] }),
      privateNetworkRuleIds: [4], resourceTypes: ['main_frame'], idpExemptDomains: [],
      getExternalTabIds: () => [], getAppTabIds: () => [], isWebActorTab: () => false,
      ensureExternalReady: async () => {}, classifyTarget: () => ({ allowed: true }),
      unavailableResult: () => ({ ok: false }),
    });

    await authority.ready();
    await authority.reconcileExternalProjection();
    expect(authority.status().tabs).toEqual([]);
    expect(session.get('guardedBrowserTabIds')).toEqual([]);
    expect(updates.at(-1)?.addRules).toEqual([]);
    await authority.onNavigationTarget({ sourceTabId: 41, tabId: 42 });
    expect(authority.status().tabs).not.toContain(42);
  });

  test('quarantines restored numeric IDs until tracker ownership is proven', async () => {
    let releaseTrackers!: () => void;
    const trackerGate = new Promise<void>((resolve) => { releaseTrackers = resolve; });
    const harness = setup({
      stored: { guardedBrowserTabIds: [41] },
      tabs: [
        { id: 41, url: 'https://user.example/' },
        { id: 42, url: 'https://child.example/' },
      ],
      ensureExternalReady: () => trackerGate,
    });
    await Promise.resolve();
    await Promise.resolve();
    const childFlow = harness.authority.onNavigationTarget({
      sourceTabId: 41, tabId: 42, url: 'https://child.example/',
    });
    await Promise.resolve();
    expect(harness.authority.status().tabs).toEqual([]);
    expect(harness.browserCalls).toEqual([]);
    releaseTrackers();
    await harness.authority.ready();
    await childFlow;
    expect(harness.browserCalls).toEqual([]);
    expect(harness.authority.status().tabs).toEqual([]);
  });

  test('arms a persistent unknown-tab floor and hands driven children to exact custody', async () => {
    const harness = setup({
      tabs: [
        { id: 1, url: 'https://source.example/' },
        { id: 2, url: 'https://ordinary.example/' },
      ],
      external: [1],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
      denylistBlocks: (hostname: string) => ['bank.example', 'login.example'].includes(hostname),
      classifyTarget: (url: string) => url.includes('127.0.0.1')
        ? { allowed: false, reason: 'private_network' }
        : url.includes('bank.example')
          ? { allowed: false, reason: 'sensitive_site' } : publicTarget(url),
    });
    await expect(harness.authority.armBrowserChildQuarantine(1))
      .resolves.toEqual({ ok: true });
    const armed = harness.rules().find((entry: any) => entry.id === 203);
    expect(armed.condition.excludedTabIds).toEqual([-1, 1, 2]);
    expect(armed.condition.resourceTypes).toEqual(['main_frame']);
    expect(harness.rules().find((entry: any) => entry.id === 310).condition)
      .toMatchObject({
        excludedTabIds: [-1, 1, 2],
        resourceTypes: ['sub_frame', 'xmlhttprequest', 'websocket'],
      });
    expect(harness.rules().find((entry: any) => entry.id === 203)).toMatchObject({
      action: { type: 'block' },
      condition: {
        regexFilter: '^https?://',
        excludedTabIds: [-1, 1, 2],
        resourceTypes: ['main_frame'],
      },
    });
    expect(harness.rules().find((entry: any) => entry.id === 202))
      .toMatchObject({
        action: { type: 'allow' },
        condition: { requestDomains: ['login.example'], resourceTypes: ['main_frame'] },
      });
    expect(harness.rules().find((entry: any) => entry.id === 301).condition)
      .toMatchObject({
        requestDomains: ['bank.example', 'login.example'], excludedTabIds: [-1, 1, 2],
        resourceTypes: ['sub_frame', 'xmlhttprequest', 'websocket'],
      });
    expect(harness.rules().filter((entry: any) => entry.id >= 200 && entry.id < 400)
      .every((entry: any) => entry.condition.excludedTabIds.includes(-1))).toBe(true);

    harness.tabs.set(3, {
      id: 3, openerTabId: 1, url: 'https://child.example/',
    });
    await harness.authority.onNavigationTarget({
      sourceTabId: 1, tabId: 3, url: 'https://child.example/',
    });
    expect(harness.rules().find((entry: any) => entry.id === 10)
      .condition.tabIds).toContain(3);
    expect(harness.rules().find((entry: any) => entry.id === 310)
      .condition.excludedTabIds).toContain(3);

    harness.tabs.set(4, {
      id: 4, openerTabId: 2, url: 'http://127.0.0.1/private',
    });
    await harness.authority.onCreated(harness.tabs.get(4));
    const transitionCommit = harness.dnrCalls.find((update: any) =>
      update.addRules?.some((rule: any) => rule.id === 203
        && rule.condition.excludedTabIds.includes(4))
      && update.addRules?.some((rule: any) => rule.id >= 10_000
        && rule.id <= 13_999 && rule.condition.tabIds[0] === 4));
    expect(transitionCommit.addRules.find((rule: any) => rule.id >= 10_000
      && rule.id <= 13_999)).toMatchObject({
      priority: 10, action: { type: 'block' },
      condition: {
        tabIds: [4], regexFilter: '^(?:https?|wss?)://',
        resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      },
    });
    const transitionRule = transitionCommit.addRules.find((rule: any) =>
      rule.id >= 10_000 && rule.id <= 13_999);
    for (const url of [
      'http://127.0.0.1/private', 'https://bank.example/private',
      'ws://127.0.0.1/socket', 'wss://bank.example/socket',
    ]) expect(new RegExp(transitionRule.condition.regexFilter).test(url)).toBe(true);
    expect(harness.rules().find((entry: any) => entry.id === 310)
      .condition.excludedTabIds).toContain(4);
    expect(harness.browserCalls).toContainEqual([
      'update', 4, { url: 'http://127.0.0.1/private' },
    ]);

    harness.tabs.set(6, {
      id: 6, openerTabId: 2, url: 'https://public-child.example/',
    });
    await harness.authority.onCreated(harness.tabs.get(6));
    expect(harness.rules().find((entry: any) => entry.id === 310)
      .condition.excludedTabIds).toContain(6);
    expect(harness.browserCalls).toContainEqual([
      'update', 6, { url: 'https://public-child.example/' },
    ]);

    harness.tabs.set(7, {
      id: 7, openerTabId: 1, url: 'https://login.example/sign-in',
    });
    await harness.authority.onNavigationTarget({
      sourceTabId: 1, tabId: 7, url: 'https://login.example/sign-in',
    });
    expect(harness.browserCalls).toContainEqual([
      'update', 7, { url: 'https://login.example/sign-in' },
    ]);
    expect(harness.browserCalls).not.toContainEqual(['remove', 7]);

    harness.tabs.set(5, { id: 5, url: 'https://late.example/' });
    expect(harness.rules().find((entry: any) => entry.id === 310)
      .condition.excludedTabIds).not.toContain(5);
    await harness.authority.onNavigationTarget({
      sourceTabId: 1, tabId: 5, url: 'https://late.example/',
    });
    expect(harness.rules().find((entry: any) => entry.id === 10)
      .condition.tabIds).toContain(5);
  });

  test('rehydrates a surviving quarantine before releasing an ordinary cold tab', async () => {
    const first = setup({
      tabs: [{ id: 1, url: 'https://source.example/' }], external: [1],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
    });
    await first.authority.armBrowserChildQuarantine(1);
    const stored = Object.fromEntries([...first.stored].map(([key, value]) =>
      [key, structuredClone(value)]));
    const second = setup({
      stored, rules: first.rules(), external: [1], quarantineClassificationMs: 1,
      tabs: [
        { id: 1, url: 'https://source.example/' },
        { id: 8, url: 'https://ordinary.example/' },
      ],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
    });
    await second.authority.onCreated(second.tabs.get(8));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(second.rules().find((rule: any) => rule.id === 203)
      .condition.excludedTabIds).toContain(8);
    expect(second.browserCalls).toContainEqual([
      'update', 8, { url: 'https://ordinary.example/' },
    ]);
  });

  test('retries a rejected cold quarantine read before one ordinary replay', async () => {
    const first = setup({
      tabs: [{ id: 1, url: 'https://source.example/' }], external: [1],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
    });
    await first.authority.armBrowserChildQuarantine(1);
    let reads = 0;
    const second = setup({
      stored: Object.fromEntries(first.stored), rules: first.rules(), external: [1],
      tabs: [
        { id: 1, url: 'https://source.example/' },
        { id: 8, url: 'https://ordinary.example/' },
      ],
      quarantineRetryMs: 1, quarantineClassificationMs: 1,
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
      getDnr: (rules: any[]) => {
        reads += 1;
        if (reads === 1) throw new Error('cold-read-down');
        return structuredClone(rules);
      },
    });
    await second.authority.onCreated(second.tabs.get(8));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(second.browserCalls.filter(([name, tabId]) =>
      name === 'update' && tabId === 8)).toHaveLength(1);
  });

  test('releases a timed-out cold read lane before one ordinary replay', async () => {
    const first = setup({
      tabs: [{ id: 1, url: 'https://source.example/' }], external: [1],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
    });
    await first.authority.armBrowserChildQuarantine(1);
    let reads = 0;
    const second = setup({
      stored: Object.fromEntries(first.stored), rules: first.rules(), external: [1],
      tabs: [
        { id: 1, url: 'https://source.example/' },
        { id: 8, url: 'https://ordinary.example/' },
      ],
      quarantineTimeoutMs: 5, quarantineRetryMs: 1, quarantineClassificationMs: 1,
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
      getDnr: (rules: any[]) => {
        reads += 1;
        if (reads === 1) return new Promise((resolve) => setTimeout(
          () => resolve(structuredClone(rules)), 8,
        ));
        return structuredClone(rules);
      },
    });
    await second.authority.onCreated(second.tabs.get(8));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(second.browserCalls.filter(([name, tabId]) =>
      name === 'update' && tabId === 8)).toHaveLength(1);
  });

  test('removes a stale cold quarantine before replaying an ordinary tab', async () => {
    const first = setup({
      tabs: [{ id: 1, url: 'https://source.example/' }], external: [1],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
    });
    await first.authority.armBrowserChildQuarantine(1);
    const stored = Object.fromEntries([...first.stored].map(([key, value]) =>
      [key, structuredClone(value)]));
    const second = setup({
      stored, rules: first.rules(), external: [],
      tabs: [{ id: 9, url: 'http://127.0.0.1/provider' }],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
    });
    await second.authority.onCreated(second.tabs.get(9));
    expect(second.rules().some((rule: any) => rule.id >= 200 && rule.id < 400)).toBe(false);
    expect(second.browserCalls).toContainEqual([
      'update', 9, { url: 'http://127.0.0.1/provider' },
    ]);
  });

  test('rebuilds drifted, missing, and narrowed surviving rules but refuses the action', async () => {
    const first = setup({
      tabs: [{ id: 1, url: 'https://source.example/' }], external: [1],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
    });
    await first.authority.armBrowserChildQuarantine(1);
    const stored = Object.fromEntries([...first.stored].map(([key, value]) =>
      [key, structuredClone(value)]));
    const variants = [
      first.rules().map((rule: any) => rule.id === 301
        ? { ...rule, condition: { ...rule.condition, requestDomains: ['drift.example'] } }
        : rule),
      first.rules().filter((rule: any) => rule.id !== 310),
      first.rules().map((rule: any) => rule.id === 310
        ? { ...rule, condition: { ...rule.condition, resourceTypes: ['websocket'] } }
        : rule),
    ];
    for (const rules of variants) {
      const second = setup({
        stored, rules, external: [1],
        tabs: [{ id: 1, url: 'https://source.example/' }],
        resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
        buildRuleUpdate: privateRuleUpdate,
      });
      await expect(second.authority.armBrowserChildQuarantine(1))
        .resolves.toEqual({ ok: false, reason: 'network_guard_install_failed' });
      expect(second.rules().find((rule: any) => rule.id === 301)
        .condition.requestDomains).toEqual(['bank.example', 'login.example']);
      expect(second.rules().find((rule: any) => rule.id === 310)
        .condition.resourceTypes).toEqual(['sub_frame', 'xmlhttprequest', 'websocket']);
      await expect(second.authority.armBrowserChildQuarantine(1))
        .resolves.toEqual({ ok: true });
    }
  });

  test('never lets a held install verification overwrite a newer exclusion', async () => {
    let reads = 0;
    let verifyStarted!: () => void;
    let releaseVerify!: () => void;
    const started = new Promise<void>((resolve) => { verifyStarted = resolve; });
    const held = new Promise<void>((resolve) => { releaseVerify = resolve; });
    const harness = setup({
      tabs: [
        { id: 1, url: 'https://source.example/' },
        { id: 2, url: 'https://ordinary.example/' },
      ],
      external: [1],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
      getDnr: (rules: any[]) => {
        reads += 1;
        const snapshot = structuredClone(rules);
        if (reads !== 2) return snapshot;
        verifyStarted();
        return held.then(() => snapshot);
      },
    });
    const arming = harness.authority.armBrowserChildQuarantine(1);
    await started;
    harness.tabs.set(4, {
      id: 4, openerTabId: 2, url: 'https://ordinary-child.example/',
    });
    const ordinary = harness.authority.onCreated(harness.tabs.get(4));
    await Promise.resolve();
    releaseVerify();
    await Promise.all([arming, ordinary]);
    expect(harness.rules().find((rule: any) => rule.id === 203)
      .condition.excludedTabIds).toContain(4);
  });

  test('refuses an arm whose verified floor disappeared before settlement', async () => {
    let hidFloor = false;
    const harness = setup({
      tabs: [{ id: 1, url: 'https://source.example/' }], external: [1],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
      getDnr: (rules: any[]) => {
        if (!hidFloor && rules.some((rule: any) => rule.id === 203)) {
          hidFloor = true;
          return structuredClone(rules.filter((rule: any) => rule.id < 200));
        }
        return structuredClone(rules);
      },
    });
    await expect(harness.authority.armBrowserChildQuarantine(1))
      .resolves.toEqual({ ok: false, reason: 'network_guard_install_failed' });
    expect(harness.rules().some((rule: any) => rule.id >= 200 && rule.id < 400)).toBe(false);
  });

  test('refuses a held arm after its source generation is reused', async () => {
    let reads = 0;
    let verifyStarted!: () => void;
    let releaseVerify!: () => void;
    const started = new Promise<void>((resolve) => { verifyStarted = resolve; });
    const held = new Promise<void>((resolve) => { releaseVerify = resolve; });
    const harness = setup({
      tabs: [{ id: 1, url: 'https://source.example/' }], external: [1],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
      getDnr: (rules: any[]) => {
        reads += 1;
        const snapshot = structuredClone(rules);
        if (reads !== 2) return snapshot;
        verifyStarted();
        return held.then(() => snapshot);
      },
    });
    const arming = harness.authority.armBrowserChildQuarantine(1);
    await started;
    const removal = harness.authority.onRemoved(1);
    harness.tabs.delete(1);
    harness.tabs.set(1, { id: 1, url: 'https://source.example/' });
    releaseVerify();
    await removal;
    await expect(arming).resolves.toEqual({
      ok: false, reason: 'network_guard_install_failed',
    });
    expect(harness.rules().some((rule: any) => rule.id >= 200 && rule.id < 400)).toBe(false);
  });

  test('keeps exact containment while rewriting a held exclusion after driven ID reuse', async () => {
    let hold = false;
    let replacementObserved = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const commits: any[] = [];
    const apply = (update: any, rules: any[], set: (next: any[]) => void) => {
      const next = [
        ...rules.filter((rule: any) => !update.removeRuleIds.includes(rule.id)),
        ...(update.addRules ?? []),
      ];
      set(next);
      if (replacementObserved) {
        commits.push({
          excluded: next.find((rule: any) => rule.id === 203)
            ?.condition.excludedTabIds.includes(4) === true,
          exact: next.find((rule: any) => rule.id === 10)
            ?.condition.tabIds.includes(4) === true,
          transition: next.some((rule: any) => rule.id >= 10_000
            && rule.id <= 13_999 && rule.condition.tabIds.includes(4)),
        });
      }
    };
    const harness = setup({
      tabs: [
        { id: 1, url: 'https://source.example/' },
        { id: 2, url: 'https://ordinary.example/' },
      ],
      external: [1],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
      updateDnr: async (update: any, rules: any[], set: (next: any[]) => void) => {
        if (hold && update.addRules?.some((rule: any) =>
          rule.id === 203 && rule.condition.excludedTabIds.includes(4))) await held;
        apply(update, rules, set);
      },
    });
    await harness.authority.armBrowserChildQuarantine(1);
    harness.tabs.set(4, {
      id: 4, openerTabId: 2, url: 'https://old.example/',
    });
    hold = true;
    const old = harness.authority.onCreated(harness.tabs.get(4));
    await Promise.resolve();
    const removed = harness.authority.onRemoved(4);
    harness.tabs.delete(4);
    harness.tabs.set(4, {
      id: 4, openerTabId: 1, url: 'https://new.example/',
    });
    replacementObserved = true;
    const replacement = harness.authority.onCreated(harness.tabs.get(4));
    release();
    await Promise.all([old, removed, replacement]);
    expect(harness.browserCalls).not.toContainEqual([
      'update', 4, { url: 'https://old.example/' },
    ]);
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every((commit) =>
      !commit.excluded || commit.exact || commit.transition)).toBe(true);
    expect(harness.rules().find((rule: any) => rule.id === 10)
      .condition.tabIds).toContain(4);
  });

  test('retries an ordinary navigation resume after a transient tab update failure', async () => {
    let attempts = 0;
    const harness = setup({
      tabs: [
        { id: 1, url: 'https://source.example/' },
        { id: 2, url: 'https://ordinary.example/' },
      ],
      external: [1], quarantineRetryMs: 1,
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
      updateTab: async (tabId: number, patch: any, tabs: Map<number, any>) => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient-update');
        const tab = tabs.get(tabId);
        Object.assign(tab, patch);
        return { ...tab };
      },
    });
    await harness.authority.armBrowserChildQuarantine(1);
    harness.tabs.set(4, {
      id: 4, openerTabId: 2, url: 'https://ordinary-child.example/',
    });
    await harness.authority.onCreated(harness.tabs.get(4));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(attempts).toBe(2);
    expect(harness.tabs.get(4).url).toBe('https://ordinary-child.example/');
  });

  test('resumes the unchanged child after its ordinary opener closes', async () => {
    let hold = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const apply = (update: any, rules: any[], set: (next: any[]) => void) => set([
      ...rules.filter((rule: any) => !update.removeRuleIds.includes(rule.id)),
      ...(update.addRules ?? []),
    ]);
    const harness = setup({
      tabs: [
        { id: 1, url: 'https://source.example/' },
        { id: 2, url: 'https://ordinary.example/' },
      ],
      external: [1],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
      updateDnr: async (update: any, rules: any[], set: (next: any[]) => void) => {
        if (hold && update.addRules?.some((rule: any) =>
          rule.id === 203 && rule.condition.excludedTabIds.includes(4))) await held;
        apply(update, rules, set);
      },
    });
    await harness.authority.armBrowserChildQuarantine(1);
    harness.tabs.set(4, {
      id: 4, openerTabId: 2, url: 'https://ordinary-child.example/',
    });
    hold = true;
    const pending = harness.authority.onCreated(harness.tabs.get(4));
    await Promise.resolve();
    harness.tabs.delete(2);
    delete harness.tabs.get(4).openerTabId;
    release();
    await pending;
    expect(harness.browserCalls).toContainEqual([
      'update', 4, { url: 'https://ordinary-child.example/' },
    ]);
  });

  test('serializes a re-arm behind a held quarantine removal', async () => {
    let holdRemove = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const apply = (update: any, rules: any[], set: (next: any[]) => void) => set([
      ...rules.filter((rule: any) => !update.removeRuleIds.includes(rule.id)),
      ...(update.addRules ?? []),
    ]);
    const harness = setup({
      tabs: [{ id: 1, url: 'https://source.example/' }], external: [1],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
      updateDnr: async (update: any, rules: any[], set: (next: any[]) => void) => {
        if (holdRemove && update.removeRuleIds.includes(203)
            && (update.addRules?.length ?? 0) === 0) await held;
        apply(update, rules, set);
      },
    });
    await harness.authority.armBrowserChildQuarantine(1);
    harness.setExternal([]);
    holdRemove = true;
    const removal = harness.authority.onRemoved(1);
    await Promise.resolve();
    harness.setExternal([1]);
    const rearm = harness.authority.armBrowserChildQuarantine(1);
    await Promise.resolve();
    release();
    await removal;
    await expect(rearm).resolves.toEqual({ ok: true });
    expect(harness.rules().find((rule: any) => rule.id === 203)).toBeDefined();
  });

  test('retries a failed last-owner removal and replays one pending ordinary tab', async () => {
    let failRemoval = false;
    let removals = 0;
    const apply = (update: any, rules: any[], set: (next: any[]) => void) => set([
      ...rules.filter((rule: any) => !update.removeRuleIds.includes(rule.id)),
      ...(update.addRules ?? []),
    ]);
    const harness = setup({
      tabs: [{ id: 1, url: 'https://source.example/' }], external: [1],
      quarantineRetryMs: 2, quarantineClassificationMs: 10,
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
      updateDnr: async (update: any, rules: any[], set: (next: any[]) => void) => {
        if (failRemoval && update.removeRuleIds.includes(203)
            && (update.addRules?.length ?? 0) === 0) {
          removals += 1;
          if (removals === 1) throw new Error('remove-down');
        }
        apply(update, rules, set);
      },
    });
    await harness.authority.armBrowserChildQuarantine(1);
    failRemoval = true;
    harness.setExternal([]);
    const closing = harness.authority.onRemoved(1);
    harness.tabs.delete(1);
    await closing;
    harness.tabs.set(8, { id: 8, url: 'https://ordinary.example/' });
    await harness.authority.onCreated(harness.tabs.get(8));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(removals).toBeGreaterThanOrEqual(2);
    expect(harness.rules().some((rule: any) => rule.id >= 200 && rule.id < 400)).toBe(false);
    expect(harness.browserCalls.filter(([name, tabId]) =>
      name === 'update' && tabId === 8)).toEqual([
      ['update', 8, { url: 'https://ordinary.example/' }],
    ]);
  });

  test('keeps a 500-tab arm and 100-tab churn bounded', async () => {
    const tabs = Array.from({ length: 500 }, (_, index) => ({
      id: index + 1, url: `https://tab-${index + 1}.example/`,
    }));
    const harness = setup({
      tabs, external: [1],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
    });
    const armStart = performance.now();
    await harness.authority.armBrowserChildQuarantine(1);
    const armMs = performance.now() - armStart;
    expect(harness.rules().find((rule: any) => rule.id === 203)
      .condition.excludedTabIds).toHaveLength(501);
    const churnStart = performance.now();
    for (let index = 0; index < 100; index += 1) {
      const tab = {
        id: 600 + index, openerTabId: 2,
        url: `https://ordinary-${index}.example/`,
      };
      harness.tabs.set(tab.id, tab);
      await harness.authority.onCreated(tab);
    }
    const churnMs = performance.now() - churnStart;
    expect(armMs).toBeLessThan(1_000);
    expect(churnMs).toBeLessThan(1_000);
    expect(harness.rules().find((rule: any) => rule.id === 203)
      .condition.excludedTabIds).toHaveLength(601);
  });

  test('reclaims transition rule IDs after serialized tab removal', async () => {
    const harness = setup({
      tabs: [
        { id: 1, url: 'https://source.example/' },
        { id: 2, url: 'https://ordinary.example/' },
      ],
      external: [1],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
    });
    await harness.authority.armBrowserChildQuarantine(1);
    for (let index = 0; index < 4_010; index += 1) {
      const tab = { id: 8, openerTabId: 2, url: `https://ordinary.example/${index}` };
      harness.tabs.set(8, tab);
      await harness.authority.onCreated(tab);
      harness.tabs.delete(8);
      await harness.authority.onRemoved(8);
    }
    harness.tabs.set(9, {
      id: 9, openerTabId: 2, url: 'https://ordinary.example/final',
    });
    await harness.authority.onCreated(harness.tabs.get(9));
    expect(harness.browserCalls).toContainEqual([
      'update', 9, { url: 'https://ordinary.example/final' },
    ]);
  });

  test('refuses a timed-out quarantine before page effects and removes a late install', async () => {
    let updates = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const apply = (update: any, rules: any[], set: (next: any[]) => void) => set([
      ...rules.filter((rule: any) => !update.removeRuleIds.includes(rule.id)),
      ...(update.addRules ?? []),
    ]);
    const harness = setup({
      tabs: [{ id: 1, url: 'https://source.example/' }], external: [1],
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket'],
      buildRuleUpdate: privateRuleUpdate,
      quarantineTimeoutMs: 5,
      updateDnr: async (update: any, rules: any[], set: (next: any[]) => void) => {
        updates += 1;
        if (updates === 2) await held;
        apply(update, rules, set);
      },
    });
    await expect(harness.authority.armBrowserChildQuarantine(1))
      .resolves.toMatchObject({ ok: false });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.rules().some((entry: any) => entry.id === 203 || entry.id === 310))
      .toBe(false);
  });
});
