import { describe, expect, test } from 'bun:test';
import {
  createKernelBrowserNetworkOwner,
  createKernelTabCustody,
} from '../../extension/background/kernel-tab-events.js';
import { WEB_ACTOR_SOURCE_PROJECTION_KEY } from '../../extension/shared/web-actor-source-projection.js';

const directAuthority = (overrides: Record<string, any> = {}) => ({
  ready: async () => ({ ok: true }),
  status: () => ({ supported: true, lastError: null, ready: false }),
  reconcileExternalProjection: async () => ({ ok: true }),
  syncDenylistNetwork: async () => {},
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

  test('rejects stale Firefox source identity and ambiguous session projection', async () => {
    for (const tab of [
      { id: 7, url: 'https://reused.example/', cookieStoreId: 'firefox-default' },
      { id: 7, url: restoredSource.url, cookieStoreId: 'firefox-container-2' }, null,
    ]) {
      const { owner } = restoredOwner([restoredSource], tab ? [tab] : []);
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

  test('constructs the authority synchronously and binds live projections later', async () => {
    const calls: any[] = [];
    let config: any;
    let constructions = 0;
    const relays = {
      engineTrackersHydrated: Promise.resolve(),
      externalDrivenTabIds: () => [2, 3], appTabIds: () => [3],
      isWebActorTab: (tabId: number) => tabId === 2,
      eventOwners: { reconcileTrackers: async () => { calls.push('live:reconcile'); } },
    };
    const owner = createKernelBrowserNetworkOwner({
      firefox: false, browser: {}, dnr: { updateSessionRules() {} },
      sessionCache: {}, denylist: {}, getRelays: () => null,
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

    expect(constructions).toBe(1);
    expect(owner.sourceProjectionReady()).toBe(false);
    owner.bind(relays);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(config.getExternalTabIds()).toEqual([2, 3]);
    expect(config.getAppTabIds()).toEqual([3]);
    expect(config.isWebActorTab(2)).toBe(true);
    expect(calls).toEqual(['live:reconcile', 'network:projection', 'network:ready']);
    expect(owner.sourceProjectionReady()).toBe(true);
    await owner.ensureBrowserNetworkGuard(2, 'https://public.example/');
    await owner.custody.sync();
    expect(calls).toContainEqual(['ensure', 2, 'https://public.example/']);
    expect(calls).toContain('network:sync');
  });

  test('retries a failed static projection when live relays bind', async () => {
    const relays = {
      engineTrackersHydrated: Promise.resolve(), isDrivenSource: () => true,
      externalDrivenTabIds: () => [7], appTabIds: () => [],
      eventOwners: { reconcileTrackers: async () => {} },
    };
    const owner = createKernelBrowserNetworkOwner({
      firefox: false, browser: {}, dnr: {}, sessionCache: {}, denylist: {},
      getRelays: () => null, createAuthority: () => directAuthority(),
    });
    await expect(owner.ensureSourceProjection()).resolves.toBe(false);
    owner.bind(relays);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(owner.sourceProjectionReady()).toBe(true);
    expect(owner.relays()?.isDrivenSource(7)).toBe(true);
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

  test('ordinary tab lifecycle stays in the direct authority without controller demand', async () => {
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
    expect(calls).toEqual([
      ['created', 2], ['updated', 2], ['removed', 2], ['reconcile'],
    ]);
  });

  test('bounds a frozen startup proof and closes only a tracker-confirmed child', async () => {
    for (const driven of [false, true]) {
      const calls: any[] = [];
      const owner = createKernelBrowserNetworkOwner({
        firefox: false,
        browser: { tabs: {
          remove: async (tabId: number) => { calls.push(['remove', tabId]); },
          update: async (tabId: number, patch: any) => { calls.push(['update', tabId, patch]); },
        } },
        dnr: {}, sessionCache: {}, denylist: {}, loadTimeoutMs: 5,
        startupGuard: { adopt: async () => new Promise(() => {}), release: async () => {} },
        getRelays: () => ({
          engineTrackersHydrated: Promise.resolve(), isDrivenSource: () => driven,
          eventOwners: { reconcileTrackers: async () => {} },
        }),
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
      const owner = createKernelBrowserNetworkOwner({
        firefox: false,
        browser: { tabs: {
          remove: async (tabId: number) => { calls.push(['remove', tabId]); },
          update: async () => {},
        } },
        dnr: { getSessionRules: async () => [] }, sessionCache: {}, denylist: {},
        startupGuard: { adopt: async () => false, release: async () => {} },
        getRelays: () => {
          if (source === 'unavailable') throw new Error('tracker-down');
          return {
            engineTrackersHydrated: Promise.resolve(),
            isDrivenSource: () => source === 'driven',
            eventOwners: { reconcileTrackers: async () => {} },
          };
        },
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
    const owner = createKernelBrowserNetworkOwner({
      firefox: false, browser: { tabs: {} }, dnr: {}, sessionCache: {}, denylist: {},
      loadTimeoutMs: 5,
      startupGuard: {
        adopt: async () => true, release: async () => {}, isGuarded: () => true,
      },
      getRelays: () => ({
        engineTrackersHydrated: Promise.resolve(), isDrivenSource: () => true,
        eventOwners: { reconcileTrackers: async () => {} },
      }),
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
      return false;
    }]));
    const child = {
      onNavigationTarget: (details: any) => calls.push(['child:mark', details.tabId]),
      resolveNavigationTarget: (details: any) => calls.push(['child:resolve', details.tabId]),
      release: (tabId: number) => calls.push(['child:release', tabId]),
      reconcile: () => calls.push(['child:reconcile']), onBeforeRequest: () => ({}),
    };
    let richLoads = 0;
    const custody = createKernelTabCustody({
      firefox: false, browser: { tabs: { query: async () => [] } }, network, child,
      getRelays: () => null,
      loadRelays: async () => { richLoads += 1; return { eventOwners: {} }; },
    });

    await custody.onCreated({ id: 4 });
    await custody.onNavigationTarget({ sourceTabId: 2, tabId: 4 });
    await custody.onRemoved(4, {});
    expect(richLoads).toBe(0);
    expect(calls).toContainEqual(['network', 'onCreated', { id: 4 }]);
    expect(calls).toContainEqual(['child:mark', 4]);
    expect(calls).toContainEqual(['child:resolve', 4]);
    expect(calls).toContainEqual(['child:release', 4]);
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
      loadRelays: async () => ({ eventOwners: {} }),
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
