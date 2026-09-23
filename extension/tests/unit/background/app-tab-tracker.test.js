// @ts-check

import { describe, expect, it } from '../../framework.js';
import { createAppTabTracker } from '/background/app-tab-tracker.js';
import { AppRoomAuthorityChangedError, createAppRoomAuthority } from '/offscreen/app-room-authority.js';
import { makeEngineLiveness } from '/peerd-runtime/background.js';

const deferred = () => {
  /** @type {(value:any)=>void} */ let resolve = () => {};
  /** @type {(error:Error)=>void} */ let reject = () => {};
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('App tab tracker quiescence', () => {
  it('sends an instance-pinned editor flush before repository callers proceed', async () => {
    /** @type {any[]} */ const messages = [];
    /** @type {Record<string,any>} */ const stored = {};
    const invalidationStarted = deferred();
    /** @type {(value:any)=>void} */ let releaseInvalidation = () => {};
    const invalidationReply = new Promise((resolve) => { releaseInvalidation = resolve; });
    const storage = /** @type {any} */ ({
      get: async () => ({ ...stored }),
      set: async (/** @type {any} */ values) => { Object.assign(stored, values); },
    });
    const tracker = createAppTabTracker({
      tabs: /** @type {any} */ ({ query: async () => [], remove: async () => {} }),
      sendTabMessage: async (tabId, message) => {
        messages.push({ tabId, message });
        if (message.action !== 'invalidate-dweb') return { ok: true };
        invalidationStarted.resolve(undefined);
        return invalidationReply;
      },
      storage,
    });
    tracker.onTabPending('app-1', 41);
    expect(tracker.getDwebGeneration('app-1')).toBe(0);
    expect(await tracker.quiesceTab('app-1')).toBe(true);
    const invalidating = tracker.invalidateDweb('app-1');
    await invalidationStarted.promise;
    expect(tracker.getDwebGeneration('app-1')).toBe(1);
    releaseInvalidation({ ok: true });
    expect(await invalidating).toBe(true);
    expect(messages).toEqual([
      { tabId: 41, message: { type: 'app/quiesce', action: 'acquire', appId: 'app-1' } },
      { tabId: 41, message: { type: 'app/quiesce', action: 'invalidate-dweb', appId: 'app-1' } },
    ]);
    const restarted = createAppTabTracker({
      tabs: /** @type {any} */ ({ query: async () => [] }),
      sendTabMessage: async () => ({ ok: true }), storage,
    });
    await restarted.bootstrap();
    expect(restarted.getDwebGeneration('app-1')).toBe(1);
  });

  it('fails closed when the App editor refuses to flush', async () => {
    const tracker = createAppTabTracker({
      tabs: /** @type {any} */ ({ query: async () => [], remove: async () => {} }),
      sendTabMessage: async () => ({ ok: false, error: 'save failed' }),
      storage: /** @type {any} */ ({ get: async () => ({}), set: async () => {} }),
    });
    tracker.onTabPending('app-1', 41);
    await expect(() => tracker.quiesceTab('app-1'))
      .toThrow((error) => error?.message === 'save failed');
    await expect(() => tracker.invalidateDweb('app-1'))
      .toThrow((error) => error?.message === 'save failed');
    expect(tracker.getDwebGeneration('app-1')).toBe(1);
  });

  it('retires room authority when a tab closes without a page leave', async () => {
    /** @type {Record<string,any>} */ const stored = { 'app.dweb-generation.app-1': 3 };
    const owners = new Set(['app:app-1:41:3']);
    const authority = createAppRoomAuthority({ get: async () => ({ ...stored }) });
    const tracker = createAppTabTracker({
      tabs: /** @type {any} */ ({ query: async () => [] }),
      sendTabMessage: async () => ({ ok: true }),
      purgeDwebOwners: (appId, generation) => authority.rotate(appId, generation, () => { owners.clear(); }),
      storage: /** @type {any} */ ({
        get: async () => ({ ...stored }),
        set: async (/** @type {any} */ values) => { Object.assign(stored, values); },
      }),
    });
    tracker.onTabPending('app-1', 41);
    tracker.onTabReady('app-1', 41);
    const appId = tracker.onTabRemoved(41);
    expect(appId).toBe('app-1');
    expect(await tracker.retireDwebTab(/** @type {string} */ (appId))).toBe(undefined);
    expect(stored['app.dweb-generation.app-1']).toBe(4);
    expect(owners.size).toBe(0);
    let staleError = null;
    try { await authority.run('app-1', 3, () => { owners.add('late'); }); }
    catch (error) { staleError = error; }
    expect(staleError instanceof AppRoomAuthorityChangedError).toBe(true);
    expect(owners.size).toBe(0);
  });

  it('retires a cold App tab from its durable liveness entry', async () => {
    /** @type {any} */ let ledger = null;
    const livenessStorage = {
      get: async () => structuredClone(ledger),
      set: async (/** @type {string} */ _key, /** @type {any} */ value) => { ledger = structuredClone(value); },
    };
    await makeEngineLiveness({ storage: livenessStorage, now: () => 1 }).adopt('app', 'app-1', 41);
    const stored = { 'app.dweb-generation.app-1': 3 };
    const authority = createAppRoomAuthority({ get: async () => ({ ...stored }) });
    const tracker = createAppTabTracker({
      tabs: /** @type {any} */ ({ query: async () => [] }),
      sendTabMessage: async () => ({ ok: true }),
      purgeDwebOwners: (appId, generation) => authority.rotate(appId, generation, () => {}),
      storage: /** @type {any} */ ({
        get: async () => ({ ...stored }), set: async (/** @type {any} */ values) => { Object.assign(stored, values); },
      }),
    });
    expect(tracker.onTabRemoved(41)).toBe(null);
    const entry = await makeEngineLiveness({ storage: livenessStorage }).findByTab('app', 41);
    expect(entry?.id).toBe('app-1');
    await tracker.retireDwebTab(/** @type {string} */ (entry?.id));
    expect(stored['app.dweb-generation.app-1']).toBe(4);
    let accepted = false;
    try { await authority.run('app-1', 3, () => { accepted = true; }); } catch { /* stale */ }
    expect(accepted).toBe(false);
  });

  it('keeps failed tab identity durable until physical removal', async () => {
    /** @type {string[]} */ const liveness = [];
    const tracker = createAppTabTracker({
      tabs: /** @type {any} */ ({ query: async () => [] }),
      sendTabMessage: async () => ({ ok: true }),
      onAdopt: (appId, tabId) => { liveness.push(`adopt:${appId}:${tabId}`); },
      onDrop: (appId) => { liveness.push(`drop:${appId}`); },
      storage: /** @type {any} */ ({ get: async () => ({}), set: async () => {} }),
    });
    tracker.onTabPending('app-1', 41);
    expect(tracker.onTabFailed('app-1', new Error('attach failed'), 41)).toBe(41);
    expect(tracker.getAppIdByTab(41)).toBe('app-1');
    expect(tracker.onTabRemoved(41)).toBe('app-1');
    expect(liveness).toEqual([
      'adopt:app-1:41', 'drop:app-1', 'adopt:app-1:41', 'drop:app-1',
    ]);
  });

  it('does not persist a new App tab before its first document claims it', async () => {
    /** @type {string[]} */ const adopted = [];
    const tracker = createAppTabTracker({
      tabs: /** @type {any} */ ({
        create: async () => ({ id: 41 }), query: async () => [],
      }),
      sendTabMessage: async () => ({ ok: true }),
      onAdopt: (appId, tabId) => { adopted.push(`${appId}:${tabId}`); },
      storage: /** @type {any} */ ({ get: async () => ({}), set: async () => {} }),
    });
    const opening = tracker.ensureTab('app-1');
    await Promise.resolve();
    await Promise.resolve();
    expect(adopted).toEqual([]);
    tracker.onTabPending('app-1', 41);
    tracker.onTabReady('app-1', 41);
    expect(await opening).toBe(41);
    expect(adopted).toEqual(['app-1:41', 'app-1:41']);
  });

  it('invalidates an exact cold-start App tab and persists its generation', async () => {
    const reply = deferred();
    const reached = deferred();
    /** @type {Record<string,any>} */ const stored = {
      'app.dweb-generation.app-1': 4,
    };
    const tabs = /** @type {any} */ ({
      query: async (/** @type {{url:string}} */ query) => [{
        id: 51,
        url: `${query.url.slice(0, -1)}#app-1`,
      }],
      remove: async () => {},
    });
    const storage = /** @type {any} */ ({
      get: async () => ({ ...stored }),
      set: async (/** @type {Record<string,any>} */ values) => { Object.assign(stored, values); },
    });
    const tracker = createAppTabTracker({
      tabs,
      sendTabMessage: async (tabId, message) => {
        reached.resolve({ tabId, message });
        return reply.promise;
      },
      storage,
    });
    expect(tracker.getTabId('app-1')).toBe(null);
    const invalidating = tracker.invalidateDweb('app-1');
    let settled = false;
    invalidating.then(() => { settled = true; }, () => { settled = true; });
    expect(await reached.promise).toEqual({
      tabId: 51,
      message: { type: 'app/quiesce', action: 'invalidate-dweb', appId: 'app-1' },
    });
    expect(settled).toBe(false);
    expect(stored['app.dweb-generation.app-1']).toBe(5);
    reply.resolve({ ok: true });
    expect(await invalidating).toBe(true);

    const restarted = createAppTabTracker({
      tabs: /** @type {any} */ ({ query: async () => [] }),
      sendTabMessage: async () => ({ ok: true }),
      storage,
    });
    await restarted.dwebGenerationsReady();
    expect(restarted.getDwebGeneration('app-1')).toBe(5);
  });

  it('drains a delayed room join before failed cold invalidation and retry mutation', async () => {
    const invalidationReply = deferred();
    const invalidationStarted = deferred();
    const joinStarted = deferred();
    const releaseJoin = deferred();
    /** @type {number[]} */ const removed = [];
    const owners = new Set();
    let live = true;
    let mutated = false;
    let invalidationCalls = 0;
    let purgeCalls = 0;
    /** @type {number[]} */ const purgedGenerations = [];
    const tracker = createAppTabTracker({
      tabs: /** @type {any} */ ({
        query: async (/** @type {{url:string}} */ query) => live ? [{
          id: 51,
          url: `${query.url.slice(0, -1)}#app-1`,
        }] : [],
        remove: async (/** @type {number} */ tabId) => { removed.push(tabId); live = false; },
      }),
      sendTabMessage: async () => {
        invalidationCalls += 1;
        invalidationStarted.resolve(undefined);
        return invalidationReply.promise;
      },
      purgeDwebOwners: async (_appId, generation) => {
        purgeCalls += 1;
        purgedGenerations.push(generation);
        owners.clear();
      },
      storage: /** @type {any} */ ({ get: async () => ({}), set: async () => {} }),
    });
    expect(tracker.getTabId('app-1')).toBe(null);
    const joining = tracker.withDwebAuthority('app-1', async () => {
      joinStarted.resolve(undefined);
      await releaseJoin.promise;
      owners.add('app:app-1:51:0');
    });
    await joinStarted.promise;
    const firstMutation = tracker.withDwebAuthority('app-1', async () => { mutated = true; }, { invalidate: true });
    await Promise.resolve();
    expect(invalidationCalls).toBe(0);
    expect(purgeCalls).toBe(0);
    releaseJoin.resolve(undefined);
    await joining;
    await invalidationStarted.promise;
    expect(owners.size).toBe(1);
    invalidationReply.reject(new Error('cold App tab did not respond'));
    await expect(() => firstMutation)
      .toThrow((error) => error?.message === 'cold App tab did not respond');
    expect(removed).toEqual([51]);
    expect(owners.size).toBe(0);
    expect(purgeCalls).toBe(1);
    expect(purgedGenerations).toEqual([1]);
    expect(mutated).toBe(false);
    await tracker.withDwebAuthority('app-1', async () => {
      expect(owners.size).toBe(0);
      mutated = true;
    }, { invalidate: true });
    expect(mutated).toBe(true);
    expect(purgeCalls).toBe(2);
    expect(purgedGenerations).toEqual([1, 2]);
  });

  it('waits for generation hydration before it invalidates a bridge', async () => {
    const hydration = deferred();
    /** @type {any[]} */ const messages = [];
    const tracker = createAppTabTracker({
      tabs: /** @type {any} */ ({ query: async () => [], remove: async () => {} }),
      sendTabMessage: async (_tabId, message) => {
        messages.push(message);
        return { ok: true };
      },
      storage: /** @type {any} */ ({
        get: async () => hydration.promise,
        set: async () => {},
      }),
    });
    tracker.onTabPending('app-1', 41);
    const invalidating = tracker.invalidateDweb('app-1');
    await Promise.resolve();
    expect(messages).toEqual([]);
    expect(tracker.getDwebGeneration('app-1')).toBe(0);
    hydration.resolve({ 'app.dweb-generation.app-1': 3 });
    expect(await invalidating).toBe(true);
    expect(tracker.getDwebGeneration('app-1')).toBe(4);
    expect(messages).toEqual([{
      type: 'app/quiesce', action: 'invalidate-dweb', appId: 'app-1',
    }]);
  });

  it('fails closed when generation hydration fails', async () => {
    const hydration = deferred();
    /** @type {any[]} */ const messages = [];
    const tracker = createAppTabTracker({
      tabs: /** @type {any} */ ({ query: async () => [], remove: async () => {} }),
      sendTabMessage: async (_tabId, message) => {
        messages.push(message);
        return { ok: true };
      },
      storage: /** @type {any} */ ({
        get: async () => hydration.promise,
        set: async () => {},
      }),
    });
    tracker.onTabPending('app-1', 41);
    const invalidating = tracker.invalidateDweb('app-1');
    hydration.reject(new Error('generation storage unavailable'));
    await expect(() => invalidating)
      .toThrow((error) => error?.message === 'generation storage unavailable');
    expect(messages).toEqual([]);
    expect(tracker.getDwebGeneration('app-1')).toBe(0);
  });

  it('pins an adopted App host to one owner root and refuses cross-chat reuse', async () => {
    const tabs = /** @type {any} */ ({
      get: async () => ({ id: 41 }),
      sendMessage: async () => ({ ok: true }),
      query: async () => [], create: async () => ({ id: 42 }),
      reload: async () => {}, remove: async () => {},
    });
    const tracker = createAppTabTracker({
      tabs,
      storage: /** @type {any} */ ({ get: async () => ({}), set: async () => {} }),
    });
    tracker.onTabPending('app-1', 41, 'chat-a', 'root-a');
    tracker.onTabReady('app-1', 41, 'chat-a', 'root-a');
    expect(tracker.getOwnedTabId('app-1', 'root-a')).toBe(41);
    expect(tracker.getOwnedTabId('app-1', 'root-b')).toBe(null);
    await expect(() => tracker.ensureTab('app-1', { ownerSessionId: 'chat-b' }))
      .toThrow((error) => error?.message === 'app-owned-by-another-chat');
  });
});

describe('App tab tracker races', () => {
  it('waits for actor readiness after it reloads an App tab', async () => {
    const reloadStarted = deferred();
    const tracker = createAppTabTracker({
      tabs: /** @type {any} */ ({
        get: async (/** @type {number} */ tabId) => ({ id: tabId }), query: async () => [],
        reload: async () => { reloadStarted.resolve(undefined); },
      }),
      sendTabMessage: async () => ({ ok: true }),
      storage: /** @type {any} */ ({ get: async () => ({}), set: async () => {} }),
    });
    tracker.onTabPending('app-1', 41);
    tracker.onTabReady('app-1', 41);
    const reloading = tracker.reloadTab('app-1');
    await reloadStarted.promise;
    let settled = false;
    reloading.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    tracker.onTabPending('app-1', 41);
    tracker.onTabReady('app-1', 41);
    expect(await reloading).toBe(true);
  });

  it('uses a new attach epoch after reload and removes it with the tab', async () => {
    const firstAttach = deferred();
    const nextAttach = deferred();
    let operationCalls = 0;
    /** @type {number[]} */ const epochs = [];
    const tracker = createAppTabTracker({
      tabs: /** @type {any} */ ({ query: async () => [] }),
      sendTabMessage: async () => ({ ok: true }),
      storage: /** @type {any} */ ({ get: async () => ({}), set: async () => {} }),
    });
    tracker.onTabPending('app-1', 41);
    const operation = async (/** @type {number} */ epoch) => {
      operationCalls += 1;
      epochs.push(epoch);
      return firstAttach.promise;
    };
    const first = tracker.coordinateAttach(41, operation);
    const duplicate = tracker.coordinateAttach(41, operation);
    expect(duplicate).toBe(first);
    await Promise.resolve();
    expect(operationCalls).toBe(1);
    expect(tracker.markAttachLoading(41)).toBe(1);
    expect(tracker.isAttachCurrent(41, 0)).toBe(false);
    const reloaded = tracker.coordinateAttach(41, async (epoch) => {
      operationCalls += 1;
      epochs.push(epoch);
      return nextAttach.promise;
    });
    expect(reloaded === first).toBe(false);
    await Promise.resolve();
    expect(epochs).toEqual([0, 1]);
    firstAttach.resolve({ ok: false, error: 'stale-app-attach' });
    expect(await first).toEqual({ ok: false, error: 'stale-app-attach' });
    expect(await duplicate).toEqual({ ok: false, error: 'stale-app-attach' });
    const attached = { ok: true, actorId: 'actor-2' };
    nextAttach.resolve(attached);
    expect(await reloaded).toBe(attached);
    expect(await tracker.coordinateAttach(41, async () => { throw new Error('must not run'); })).toBe(attached);
    expect(operationCalls).toBe(2);

    expect(tracker.onTabRemoved(41)).toBe('app-1');
    const removedResult = { ok: true, actorId: 'actor-3' };
    expect(await tracker.coordinateAttach(41, async () => {
      operationCalls += 1;
      return removedResult;
    })).toBe(removedResult);
    expect(operationCalls).toBe(3);
  });

  it('creates one tab for concurrent requests', async () => {
    const created = deferred();
    let createCalls = 0;
    const tabs = /** @type {any} */ ({
      create: () => {
        createCalls += 1;
        return created.promise;
      },
      get: async (/** @type {number} */ tabId) => ({ id: tabId }),
      query: async () => [], remove: async () => {},
      reload: async () => {}, sendMessage: async () => ({ ok: true }),
    });
    const tracker = createAppTabTracker({
      tabs,
      storage: /** @type {any} */ ({ get: async () => ({}), set: async () => {} }),
    });
    const first = tracker.ensureTab('app-1');
    const second = tracker.ensureTab('app-1');
    expect(createCalls).toBe(1);
    created.resolve({ id: 42 });
    await Promise.resolve();
    tracker.onTabReady('app-1', 42);
    expect(await Promise.all([first, second])).toEqual([42, 42]);
    expect(createCalls).toBe(1);
  });

  it('does not give one owner the tab that another owner opened', async () => {
    const created = deferred();
    let createCalls = 0;
    const tabs = /** @type {any} */ ({
      create: () => {
        createCalls += 1;
        return created.promise;
      },
      get: async (/** @type {number} */ tabId) => ({ id: tabId }),
      query: async () => [], remove: async () => {},
      reload: async () => {}, sendMessage: async () => ({ ok: true }),
    });
    const tracker = createAppTabTracker({
      tabs,
      storage: /** @type {any} */ ({ get: async () => ({}), set: async () => {} }),
    });
    const first = tracker.ensureTab('app-1', { ownerSessionId: 'chat-a' });
    const second = tracker.ensureTab('app-1', { ownerSessionId: 'chat-b' });
    const secondResult = second.then(
      () => null,
      (error) => error,
    );
    created.resolve({ id: 42 });
    await Promise.resolve();
    tracker.onTabReady('app-1', 42, 'chat-a', 'root-a');
    expect(await first).toBe(42);
    expect((await secondResult)?.message).toBe('app-owned-by-another-chat');
    expect(createCalls).toBe(1);
  });

  it('refuses a second pending tab for the same App', () => {
    const tracker = createAppTabTracker({
      tabs: /** @type {any} */ ({ query: async () => [] }),
      sendTabMessage: async () => ({ ok: true }),
      storage: /** @type {any} */ ({ get: async () => ({}), set: async () => {} }),
    });
    expect(tracker.onTabPending('app-1', 41, 'chat-a', 'root-a')).toBe(true);
    expect(tracker.onTabPending('app-1', 42, 'chat-b', 'root-b')).toBe(false);
    expect(tracker.getTabId('app-1')).toBe(41);
    expect(tracker.getOwnedTabId('app-1', 'root-a')).toBe(41);
    expect(tracker.getOwnedTabId('app-1', 'root-b')).toBe(null);
  });

  it('ignores stale ready, failure, removal, and same-tab navigation events', async () => {
    const tracker = createAppTabTracker({
      tabs: /** @type {any} */ ({ query: async () => [] }),
      sendTabMessage: async () => ({ ok: true }),
      storage: /** @type {any} */ ({ get: async () => ({}), set: async () => {} }),
    });
    tracker.onTabPending('app-1', 41, 'chat-a', 'root-a');
    expect(tracker.onTabRemoved(41)).toBe('app-1');
    tracker.onTabPending('app-1', 42, 'chat-b', 'root-b');
    tracker.onTabReady('app-1', 42, 'chat-b', 'root-b');
    expect(tracker.onTabReady('app-1', 41, 'chat-a', 'root-a')).toBe(false);
    expect(tracker.onTabFailed('app-1', new Error('late failure'), 41)).toBe(null);
    expect(tracker.onTabRemoved(41)).toBe(null);
    expect(tracker.getTabId('app-1')).toBe(42);
    expect(tracker.getOwnedTabId('app-1', 'root-b')).toBe(42);
    expect(tracker.getOwnedTabId('app-1', 'root-a')).toBe(null);

    /** @type {any[]} */ const messages = [];
    const rebound = createAppTabTracker({
      tabs: /** @type {any} */ ({ query: async () => [] }),
      sendTabMessage: async (tabId, message) => { messages.push({ tabId, message }); return { ok: true }; },
      storage: /** @type {any} */ ({ get: async () => ({}), set: async () => {} }),
    });
    rebound.onTabPending('app-a', 61);
    rebound.onTabPending('app-b', 61);
    expect(rebound.getTabId('app-a')).toBe(null);
    expect(rebound.getTabId('app-b')).toBe(61);
    expect(await rebound.invalidateDweb('app-a')).toBe(false);
    expect(messages).toEqual([]);
    expect(rebound.onTabRemoved(61)).toBe('app-b');
    expect(rebound.getTabId('app-b')).toBe(null);
  });
});
