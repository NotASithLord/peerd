import { describe, expect, test } from 'bun:test';
import {
  createKernelBrowserNetworkOwner,
  createKernelTabCustody,
} from '../../extension/background/kernel-tab-events.js';
import {
  FIREFOX_DRIVEN_CHILD_IDS_KEY,
  FIREFOX_DRIVEN_CHILD_MARKERS_KEY,
  makeDrivenChildRequestGuard,
} from '../../extension/background/driven-child-request-guard.js';
import { WEB_ACTOR_SOURCE_PROJECTION_KEY } from '../../extension/shared/web-actor-source-projection.js';

const directAuthority = (overrides: Record<string, any> = {}) => ({
  ready: async () => ({ ok: true }),
  status: () => ({ supported: true, lastError: null, ready: false }),
  reconcileExternalProjection: async () => ({ ok: true }),
  syncDenylistNetwork: async () => {},
  verifyAppNetwork: async () => true,
  ensureBrowserNetworkGuard: async () => ({ ok: true }),
  acquireBrowserNetworkGuardLease: async () => ({ ok: true }),
  releaseBrowserNetworkGuardLease: async () => {},
  updateBrowserNetworkGuardOrigin: async () => ({ ok: true }),
  armBrowserChildQuarantine: async () => ({ ok: true }),
  onCreated: async () => {}, onUpdated: async () => {}, onRemoved: async () => {},
  onNavigationTarget: async () => {}, reconcile: async () => {},
  ...overrides,
});

describe('kernel browser network owner', () => {
  const restoredSource = {
    tabId: 7, sessionId: 'actor-7', url: 'https://public.example/',
    openerTabId: null, cookieStoreId: 'firefox-default',
  };
  const restoredOwner = (projection: unknown, tabs: any[],
    bindings: unknown = [[7, 'actor-7']]) => {
    let relayReads = 0;
    const owner = createKernelBrowserNetworkOwner({
      firefox: true,
      browser: { tabs: { query: async () => tabs } }, dnr: {}, denylist: {},
      sessionCache: { sessionGet: async (key: string) => key === 'webActorTabBindings'
        ? bindings : key === WEB_ACTOR_SOURCE_PROJECTION_KEY ? projection : null },
      getRelays: () => { relayReads += 1; return null; },
      createAuthority: () => directAuthority(),
    });
    return { owner, relayReads: () => relayReads };
  };

  test('restores exact Firefox source authority without a controller relay', async () => {
    const tab = {
      id: 7, url: restoredSource.url, openerTabId: undefined,
      cookieStoreId: restoredSource.cookieStoreId,
    };
    for (let generation = 0; generation < 2; generation += 1) {
      const { owner, relayReads } = restoredOwner([restoredSource], [tab]);
      await expect(owner.ensureSourceProjection()).resolves.toBe(true);
      expect(owner.sourceProjectionReady()).toBe(true);
      expect(owner.relays()?.isDrivenSource(7)).toBe(true);
      expect(owner.relays()?.webActorSessionForTab(7)).toBe('actor-7');
      expect(relayReads()).toBe(0);
    }
  });

  test('prunes concretely stale Firefox source identity without loading relays', async () => {
    for (const tab of [
      { id: 7, url: 'https://reused.example/', cookieStoreId: 'firefox-default' },
      { id: 7, url: restoredSource.url, cookieStoreId: 'firefox-container-2' },
      {
        id: 7, url: restoredSource.url, openerTabId: 9,
        cookieStoreId: restoredSource.cookieStoreId,
      },
      null,
    ]) {
      const { owner, relayReads } = restoredOwner([restoredSource], tab ? [tab] : []);
      await expect(owner.ensureSourceProjection()).resolves.toBe(true);
      expect(owner.sourceProjectionReady()).toBe(true);
      expect(owner.relays()?.isDrivenSource(7)).toBe(false);
      expect(owner.relays()?.webActorSessionForTab(7)).toBeNull();
      expect(relayReads()).toBe(0);
    }
  });

  test('rejects unavailable Firefox identity fields and ambiguous sessions', async () => {
    for (const [source, tab] of [
      [restoredSource, {
        id: 7, cookieStoreId: restoredSource.cookieStoreId,
      }],
      [restoredSource, { id: 7, url: restoredSource.url }],
      [{ ...restoredSource, openerTabId: 5 }, {
        id: 7, url: restoredSource.url, cookieStoreId: restoredSource.cookieStoreId,
      }],
    ] as const) {
      const { owner } = restoredOwner([source], [tab]);
      await expect(owner.ensureSourceProjection()).resolves.toBe(false);
      expect(owner.sourceProjectionReady()).toBe(false);
      expect(owner.relays()).toBeNull();
    }
    const mismatch = restoredOwner(
      [{ ...restoredSource, sessionId: 'other-actor' }],
      [{ id: 7, url: restoredSource.url, cookieStoreId: restoredSource.cookieStoreId }],
    );
    await expect(mismatch.owner.ensureSourceProjection()).resolves.toBe(false);
  });

  test('a pruned source releases restored child custody before agent/send', async () => {
    const { owner } = restoredOwner([restoredSource], []);
    const values = new Map<string, string>([
      [FIREFOX_DRIVEN_CHILD_MARKERS_KEY, JSON.stringify([{ tabId: 8, sourceTabId: 7 }])],
      [FIREFOX_DRIVEN_CHILD_IDS_KEY, '[8]'],
    ]);
    const guard = makeDrivenChildRequestGuard({
      isSourceReady: owner.sourceProjectionReady,
      isDrivenSource: (tabId) => owner.relays()?.isDrivenSource(tabId) === true,
      markers: {
        read: () => JSON.parse(values.get(FIREFOX_DRIVEN_CHILD_MARKERS_KEY) ?? '[]'),
        readExactIds: () => JSON.parse(values.get(FIREFOX_DRIVEN_CHILD_IDS_KEY) ?? '[]'),
        write: (markers) => {
          values.set(FIREFOX_DRIVEN_CHILD_MARKERS_KEY, JSON.stringify(markers));
          values.set(FIREFOX_DRIVEN_CHILD_IDS_KEY, JSON.stringify(
            markers.map(({ tabId }) => tabId),
          ));
        },
      },
    });

    expect(guard.ready()).toBe(false);
    await expect(owner.ensureSourceProjection()).resolves.toBe(true);
    expect(guard.ready()).toBe(true);
    expect(guard.has(8)).toBe(false);
  });

  test('keeps authority cold and binds a fenced source projection', async () => {
    const calls: any[] = [];
    let config: any;
    let constructions = 0;
    const identity = { bootId: 'boot-source-a', kernelEpoch: 'kernel-source-a' };
    const tabs = [{ id: 2, url: 'https://source.test/' }];
    const owner = createKernelBrowserNetworkOwner({
      firefox: false, browser: { tabs: { query: async () => tabs } },
      dnr: { updateSessionRules() {} }, sessionCache: {}, denylist: {},
      kernelIdentity: identity,
      createAuthority: (deps: any) => {
        constructions += 1;
        config = deps;
        return directAuthority({
          ready: async () => { calls.push('network:ready'); },
          reconcileExternalProjection: async () => {
            calls.push('network:projection');
            return { ok: true };
          },
          syncDenylistNetwork: async () => { calls.push('network:sync'); },
          ensureBrowserNetworkGuard: async (...args: any[]) => {
            calls.push(['ensure', ...args]);
          },
        });
      },
    });

    expect(constructions).toBe(0);
    expect(owner.sourceProjectionReady()).toBe(false);
    owner.bind('controller-a');
    expect(await owner.updateSourceProjection(
      [[2, 'actor-2']], [{
        tabId: 2, sessionId: 'actor-2', url: 'https://source.test/',
        openerTabId: null, cookieStoreId: null,
      }], { ...identity, generation: 'controller-a', revision: 1 },
    )).toBe(true);
    expect(owner.sourceProjectionReady()).toBe(true);
    await owner.ensureBrowserNetworkGuard(2, 'https://public.example/');
    expect(constructions).toBe(1);
    expect(config.getExternalTabIds()).toEqual([2]);
    expect(config.getAppTabIds()).toEqual([]);
    expect(config.isWebActorTab(2)).toBe(true);
    await owner.custody.sync();
    expect(calls).toContainEqual(['ensure', 2, 'https://public.example/']);
    expect(calls).toContain('network:sync');
  });

  test('bounds lazy authority startup before effects and reuses a late load', async () => {
    let finish!: (value: any) => void;
    let loads = 0;
    const loading = new Promise((resolve) => { finish = resolve; });
    const owner = createKernelBrowserNetworkOwner({
      firefox: false, browser: {}, dnr: {}, sessionCache: {}, denylist: {},
      loadTimeoutMs: 5,
      createAuthority: async () => { loads += 1; return loading; },
    });
    await expect(owner.ensureBrowserNetworkGuard(3, 'https://public.example/'))
      .resolves.toMatchObject({
        ok: false,
        code: 'kernel-browser-network-ensureBrowserNetworkGuard-load-timeout',
        outcomeKnown: true,
        retryable: true,
        phase: 'startup',
      });
    finish(directAuthority());
    await Promise.resolve();
    await expect(owner.ensureBrowserNetworkGuard(3, 'https://public.example/'))
      .resolves.toEqual({ ok: true });
    expect(loads).toBe(1);
  });

  test('keeps a post-entry authority timeout unknown and non-retryable', async () => {
    const owner = createKernelBrowserNetworkOwner({
      firefox: false, browser: {}, dnr: {}, sessionCache: {}, denylist: {},
      loadTimeoutMs: 5,
      createAuthority: async () => directAuthority({
        ensureBrowserNetworkGuard: async () => new Promise(() => {}),
      }),
    });
    await expect(owner.ensureBrowserNetworkGuard(3, 'https://public.example/'))
      .resolves.toMatchObject({
        ok: false,
        code: 'kernel-browser-network-ensureBrowserNetworkGuard-timeout',
        outcomeKnown: false,
        retryable: false,
        phase: 'run',
      });
  });

  test('keeps authority construction failures known and retryable', async () => {
    for (const createAuthority of [
      () => { throw new Error('construction failed'); },
      async () => ({}),
    ]) {
      const owner = createKernelBrowserNetworkOwner({
        firefox: false, browser: {}, dnr: {}, sessionCache: {}, denylist: {},
        createAuthority,
      });
      await expect(owner.ensureBrowserNetworkGuard(3, 'https://public.example/'))
        .resolves.toMatchObject({
          ok: false, code: 'kernel-browser-network-authority-startup-failed',
          outcomeKnown: true, retryable: true, phase: 'startup',
        });
    }
  });

  test('admits only the exact installed App tab into network custody', async () => {
    const appTabUrl = 'moz-extension://peerd/engine-tabs/app-tab/index.html';
    const url = `${appTabUrl}#app-1?owner=session-1`;
    let config: any;
    let syncs = 0;
    let verifications = 0;
    let constructions = 0;
    const owner = createKernelBrowserNetworkOwner({
      firefox: true, appTabUrl,
      browser: { tabs: {
        query: async () => [{ id: 17, url }],
        get: async (tabId: number) => tabId === 17 ? { id: 17, url } : null,
      } },
      dnr: { updateSessionRules() {} }, denylist: {},
      sessionCache: { sessionGet: async () => [] },
      createAuthority: (deps: any) => {
        constructions += 1;
        config = deps;
        return directAuthority({
          syncDenylistNetwork: async () => { syncs += 1; },
          verifyAppNetwork: async (tabId: number) => {
            verifications += 1;
            return tabId === 17;
          },
          status: () => ({
            supported: true, lastError: null, ready: true,
            tabs: config.getExternalTabIds(), origins: [],
          }),
        });
      },
    });

    await expect(owner.custody.admitAppTab(17, `${url}-wrong`))
      .resolves.toEqual({ ok: false });
    expect(constructions).toBe(0);
    await expect(owner.custody.admitAppTab(17, url)).resolves.toEqual({ ok: true });
    expect(config.getAppTabIds()).toEqual([17]);
    expect(config.getExternalTabIds()).toEqual([17]);
    expect(config.isWebActorTab(17)).toBe(false);
    expect(owner.relays()?.isDrivenSource(17)).toBe(true);
    expect(syncs).toBe(1);
    expect(verifications).toBe(1);
  });

  test('refuses App admission without exact rule verification', async () => {
    const appTabUrl = 'moz-extension://peerd/engine-tabs/app-tab/index.html';
    const url = `${appTabUrl}#app-1`;
    const owner = createKernelBrowserNetworkOwner({
      firefox: true, appTabUrl,
      browser: { tabs: {
        query: async () => [{ id: 17, url }],
        get: async () => ({ id: 17, url }),
      } },
      dnr: { updateSessionRules() {} }, denylist: {},
      sessionCache: { sessionGet: async () => [] },
      createAuthority: () => directAuthority({
        verifyAppNetwork: async () => false,
        status: () => ({
          supported: true, lastError: null, ready: true,
          tabs: [17], origins: [],
        }),
      }),
    });

    await expect(owner.custody.admitAppTab(17, url)).resolves.toEqual({ ok: false });
  });

  test('rejects stale source generations and revisions', async () => {
    const identity = { bootId: 'boot-source-b', kernelEpoch: 'kernel-source-b' };
    const row = {
      tabId: 7, sessionId: 'actor-7', url: 'https://source.test/',
      openerTabId: null, cookieStoreId: null,
    };
    const owner = createKernelBrowserNetworkOwner({
      firefox: false,
      browser: { tabs: { query: async () => [{ id: 7, url: row.url }] } },
      dnr: {}, sessionCache: {}, denylist: {}, kernelIdentity: identity,
      createAuthority: () => directAuthority(),
    });
    await expect(owner.ensureSourceProjection()).resolves.toBe(false);
    owner.bind('controller-b');
    expect(await owner.updateSourceProjection(
      [[7, 'actor-7']], [row], { ...identity, generation: 'retired-one', revision: 1 },
    )).toBe(false);
    expect(await owner.updateSourceProjection(
      [[7, 'actor-7']], [row], { ...identity, generation: 'controller-b', revision: 2 },
    )).toBe(true);
    expect(await owner.updateSourceProjection(
      [], [], { ...identity, generation: 'controller-b', revision: 1 },
    )).toBe(false);
    owner.bind('controller-c');
    expect(await owner.updateSourceProjection(
      [], [], { ...identity, generation: 'controller-b', revision: 3 },
    )).toBe(false);
  });

  test('contains child ingress through the direct authority without controller demand', async () => {
    const calls: any[] = [];
    const owner = createKernelBrowserNetworkOwner({
      firefox: false, browser: {}, dnr: {}, sessionCache: {}, denylist: {},
      startupGuard: {
        adopt: async (sourceTabId: number, tabId: number) => {
          calls.push(['startup:adopt', sourceTabId, tabId]);
          return true;
        },
        release: async () => {}, isGuarded: () => true,
        hasSourceEvidence: () => true,
      },
      getRelays: () => { throw new Error('controller-must-not-load'); },
      createAuthority: (config: any) => {
        expect(config.isWebActorTab(7)).toBe(true);
        return directAuthority({
          onNavigationTarget: async (event: any) => {
            calls.push(['authority:target', event.sourceTabId, event.tabId]);
          },
        });
      },
    });

    await expect(owner.onNavigationTarget({ sourceTabId: 7, tabId: 8 }))
      .resolves.toBe(true);
    expect(calls).toEqual([
      ['startup:adopt', 7, 8], ['authority:target', 7, 8],
    ]);
  });

  test('ordinary tab lifecycle stays cold without network work', async () => {
    const calls: any[] = [];
    const owner = createKernelBrowserNetworkOwner({
      firefox: false, browser: {}, dnr: {}, sessionCache: {}, denylist: {},
      startupGuard: { release: async () => {} },
      getRelays: () => { throw new Error('controller-must-not-load'); },
      createAuthority: () => directAuthority({
        onCreated: async (tab: any) => { calls.push(['created', tab.id]); },
        onUpdated: async (tabId: number) => { calls.push(['updated', tabId]); },
        onRemoved: async (tabId: number) => { calls.push(['removed', tabId]); },
        reconcile: async () => { calls.push(['reconcile']); },
      }),
    });

    await owner.onCreated({ id: 2, url: 'https://ordinary.example/' });
    await owner.onUpdated(2, { status: 'complete' }, { id: 2 });
    await owner.onRemoved(2);
    await owner.reconcile();
    expect(calls).toEqual([]);
  });

  test('bounds a frozen startup proof and closes only a tracker-confirmed child', async () => {
    for (const driven of [false, true]) {
      const calls: any[] = [];
      const source = {
        tabId: 7, sessionId: 'actor-7', url: 'https://source.test/',
        openerTabId: null, cookieStoreId: null,
      };
      const owner = createKernelBrowserNetworkOwner({
        firefox: false,
        browser: { tabs: {
          query: async () => [{ id: 7, url: source.url }],
          remove: async (tabId: number) => { calls.push(['remove', tabId]); },
          update: async (tabId: number, patch: any) => { calls.push(['update', tabId, patch]); },
        } },
        dnr: {}, sessionCache: { sessionGet: async (key: string) => driven
          ? key === 'webActorTabBindings' ? [[7, 'actor-7']]
            : key === WEB_ACTOR_SOURCE_PROJECTION_KEY ? [source] : null
          : key === 'webActorTabBindings' || key === WEB_ACTOR_SOURCE_PROJECTION_KEY
            ? [] : null }, denylist: {}, loadTimeoutMs: 5,
        startupGuard: { adopt: async () => new Promise(() => {}), release: async () => {} },
        createAuthority: () => directAuthority(),
        onPopupFailed: (event: any) => { calls.push(['failed', event]); },
      });
      expect(await owner.onNavigationTarget({ sourceTabId: 7, tabId: 8 })).toBe(false);
      if (driven) {
        expect(calls[0]).toEqual(['remove', 8]);
        expect(calls[1][1]).toMatchObject({
          sourceTabId: 7, tabId: 8, child: 'closed', guarded: false,
          reason: 'kernel-browser-network-onNavigationTarget-startup-timeout',
        });
      } else expect(calls).toEqual([]);
    }
  });

  test('a false startup proof distinguishes driven, ordinary, and unavailable sources', async () => {
    for (const source of ['driven', 'ordinary', 'unavailable'] as const) {
      const calls: any[] = [];
      const projection = {
        tabId: 7, sessionId: 'actor-7', url: 'https://source.test/',
        openerTabId: null, cookieStoreId: null,
      };
      const owner = createKernelBrowserNetworkOwner({
        firefox: false,
        browser: { tabs: {
          query: async () => [{ id: 7, url: projection.url }],
          remove: async (tabId: number) => { calls.push(['remove', tabId]); },
          update: async () => {},
        } },
        dnr: { getSessionRules: async () => [] },
        sessionCache: source === 'unavailable' ? {} : {
          sessionGet: async (key: string) => source === 'driven'
            ? key === 'webActorTabBindings' ? [[7, 'actor-7']]
              : key === WEB_ACTOR_SOURCE_PROJECTION_KEY ? [projection] : null
            : key === 'webActorTabBindings' || key === WEB_ACTOR_SOURCE_PROJECTION_KEY
              ? [] : null,
        }, denylist: {},
        startupGuard: { adopt: async () => false, release: async () => {} },
        createAuthority: () => directAuthority(),
        onPopupFailed: (event: any) => { calls.push(['failed', event]); },
        onError: (error: any) => { calls.push(['error', error]); },
      });
      expect(await owner.onNavigationTarget({ sourceTabId: 7, tabId: 8 })).toBe(false);
      if (source === 'driven') expect(calls).toMatchObject([
        ['remove', 8], ['failed', { retryable: true, child: 'closed' }],
      ]);
      else if (source === 'ordinary') expect(calls).toEqual([]);
      else expect(calls.at(-1)?.[1]).toMatchObject({
        code: 'kernel-browser-child-source-classification-unavailable',
        outcomeKnown: false, retryable: true, contained: false,
      });
    }
  });

  test('does not contain a reused tab after its observed generation closes', async () => {
    const calls: any[] = [];
    let rejectProof!: (cause: Error) => void;
    const proof = new Promise<boolean>((_resolve, reject) => { rejectProof = reject; });
    const owner = createKernelBrowserNetworkOwner({
      firefox: false,
      browser: { tabs: {
        remove: async (tabId: number) => { calls.push(['remove', tabId]); },
        update: async (tabId: number) => { calls.push(['update', tabId]); },
      } },
      dnr: {}, sessionCache: {}, denylist: {},
      startupGuard: { adopt: () => proof, release: async () => {} },
      getRelays: () => { throw new Error('controller-must-not-load'); },
      createAuthority: () => directAuthority(),
      onPopupFailed: (event: any) => { calls.push(['failed', event]); },
    });
    const pending = owner.onNavigationTarget({ sourceTabId: 7, tabId: 8 });
    await owner.onRemoved(8);
    rejectProof(new Error('old child gone'));
    expect(await pending).toBe(false);
    expect(calls).toEqual([]);
  });

  test('a timed-out direct authority reports guarded retryable custody', async () => {
    const calls: any[] = [];
    const source = {
      tabId: 9, sessionId: 'actor-9', url: 'https://source.test/',
      openerTabId: null, cookieStoreId: null,
    };
    const owner = createKernelBrowserNetworkOwner({
      firefox: false, browser: { tabs: {
        query: async () => [{ id: 9, url: source.url }],
      } }, dnr: {}, sessionCache: {
        sessionGet: async (key: string) => key === 'webActorTabBindings'
          ? [[9, 'actor-9']] : key === WEB_ACTOR_SOURCE_PROJECTION_KEY ? [source] : null,
      }, denylist: {},
      loadTimeoutMs: 5,
      startupGuard: {
        adopt: async () => true, release: async () => {}, isGuarded: () => true,
      },
      createAuthority: () => directAuthority({
        onNavigationTarget: async () => new Promise(() => {}),
      }),
      onPopupFailed: (event: any) => { calls.push(event); },
    });
    expect(await owner.onNavigationTarget({ sourceTabId: 9, tabId: 10 })).toBe(false);
    expect(calls).toMatchObject([{
      sourceTabId: 9, tabId: 10, reason: 'child_authority_unavailable',
      child: 'guarded', guarded: true, retryable: true,
    }]);
  });

  test('fans synchronous ingress into network custody without waking rich state', async () => {
    const calls: any[] = [];
    const network = Object.fromEntries([
      'onCreated', 'onUpdated', 'onRemoved', 'onNavigationTarget', 'reconcile',
    ].map((name) => [name, async (...args: any[]) => {
      calls.push(['network', name, ...args]);
      return true;
    }]));
    const child = {
      onNavigationTarget: (details: any) => calls.push(['child:mark', details.tabId]),
      resolveNavigationTarget: (details: any) => calls.push(['child:resolve', details.tabId]),
      release: (tabId: number) => calls.push(['child:release', tabId]),
      reconcile: () => calls.push(['child:reconcile']), onBeforeRequest: () => ({}),
    };
    const custody = createKernelTabCustody({
      firefox: false, browser: { tabs: { query: async () => [] } }, network, child,
      getRelays: () => null,
    });

    await custody.onCreated({ id: 4 });
    await custody.onNavigationTarget({ sourceTabId: 2, tabId: 4 });
    await custody.onRemoved(4, {});
    expect(calls).toContainEqual(['network', 'onCreated', { id: 4 }]);
    expect(calls).toContainEqual(['child:mark', 4]);
    expect(calls).toContainEqual(['child:resolve', 4]);
    expect(calls).toContainEqual(['child:release', 4]);
  });

  test('runs network custody once when a live event owner throws synchronously', async () => {
    const calls: string[] = [];
    const richFailure = new Error('rich-event-failed');
    const custody = createKernelTabCustody({
      browser: {},
      network: {
        onUpdated: async () => { calls.push('network'); return true; },
      },
      child: {},
      getRelays: () => ({
        eventOwners: {
          onUpdated: () => { calls.push('rich'); throw richFailure; },
        },
      }),
    });

    await expect(custody.onUpdated(4, { status: 'complete' }, { id: 4 }))
      .rejects.toBe(richFailure);
    expect(calls).toEqual(['rich', 'network']);
  });

  test('requeries Firefox tabs after reconciliation before releasing markers', async () => {
    let releaseNetwork!: () => void;
    const networkGate = new Promise<void>((resolve) => { releaseNetwork = resolve; });
    let queryCount = 0;
    let tabs: any[] = [{ id: 1 }];
    const childIds = new Set<number>();
    const custody = createKernelTabCustody({
      firefox: true,
      browser: { tabs: { query: async () => { queryCount += 1; return tabs; } } },
      network: { reconcile: async () => { await networkGate; } },
      child: {
        onNavigationTarget: ({ tabId }: any) => { childIds.add(tabId); },
        resolveNavigationTarget: () => {}, release: (tabId: number) => childIds.delete(tabId),
        reconcile: (snapshot: any[]) => {
          const live = new Set(snapshot.map((tab) => tab.id));
          for (const tabId of childIds) if (!live.has(tabId)) childIds.delete(tabId);
        },
        onBeforeRequest: ({ tabId }: any) => childIds.has(tabId) ? { cancel: true } : {},
      },
      getRelays: () => ({ eventOwners: { reconcile: async () => {} } }),
    });

    const pending = custody.reconcile();
    await Promise.resolve();
    childIds.add(2);
    tabs = [{ id: 1 }, { id: 2, openerTabId: 1 }];
    releaseNetwork();
    await pending;
    expect(queryCount).toBe(2);
    expect(childIds.has(2)).toBe(true);
    expect(custody.onBeforeRequest({ tabId: 2 })).toEqual({ cancel: true });
  });
});
