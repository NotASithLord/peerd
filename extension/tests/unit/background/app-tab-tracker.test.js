// @ts-check

import { describe, expect, it } from '../../framework.js';
import { createAppTabTracker } from '/background/app-tab-tracker.js';
import browser from '/shared/browser-api.js';

describe('App tab tracker quiescence', () => {
  it('sends an instance-pinned editor flush before repository callers proceed', async () => {
    /** @type {any[]} */ const messages = [];
    const tracker = createAppTabTracker({
      sendTabMessage: async (tabId, message) => {
        messages.push({ tabId, message });
        return { ok: true };
      },
    });
    tracker.onTabPending('app-1', 41);
    expect(await tracker.quiesceTab('app-1')).toBe(true);
    expect(messages).toEqual([{
      tabId: 41,
      message: { type: 'app/quiesce', action: 'acquire', appId: 'app-1' },
    }]);
  });

  it('fails closed when the App editor refuses to flush', async () => {
    const tracker = createAppTabTracker({
      sendTabMessage: async () => ({ ok: false, error: 'save failed' }),
    });
    tracker.onTabPending('app-1', 41);
    await expect(() => tracker.quiesceTab('app-1'))
      .toThrow((error) => error?.message === 'save failed');
  });

  it('pins an adopted App host to one owner root and refuses cross-chat reuse', async () => {
    const tabs = /** @type {any} */ ({
      get: async () => ({ id: 41 }),
      sendMessage: async () => ({ ok: true }),
      query: async () => [], create: async () => ({ id: 42 }),
      reload: async () => {}, remove: async () => {},
    });
    const tracker = createAppTabTracker({ tabs });
    tracker.onTabPending('app-1', 41, 'chat-a', 'root-a');
    tracker.onTabReady('app-1', 41, 'chat-a', 'root-a');
    expect(tracker.getOwnedTabId('app-1', 'root-a')).toBe(41);
    expect(tracker.getOwnedTabId('app-1', 'root-b')).toBe(null);
    await expect(() => tracker.ensureTab('app-1', { ownerSessionId: 'chat-b' }))
      .toThrow((error) => error?.message === 'app-owned-by-another-chat');
  });

  it('drops a stale claim only after a complete tab snapshot proves it left', async () => {
    let queryFails = true;
    const tabs = /** @type {any} */ ({
      get: async () => null,
      sendMessage: async () => ({ ok: true }),
      query: async () => {
        if (queryFails) throw new Error('tabs unavailable');
        return [];
      },
      create: async () => ({ id: 42 }), reload: async () => {}, remove: async () => {},
    });
    const tracker = createAppTabTracker({ tabs });
    tracker.onTabReady('app-1', 41, 'chat-a', 'root-a');
    expect(await tracker.reconcileTabClaim('app-1', 42)).toBe(41);
    expect(tracker.getTabId('app-1')).toBe(41);
    queryFails = false;
    expect(await tracker.reconcileTabClaim('app-1', 42)).toBe(null);
    expect(tracker.getTabId('app-1')).toBe(null);
  });

  it('does not close a tab that navigated away from its App claim', async () => {
    /** @type {number[]} */ const removed = [];
    const tabs = /** @type {any} */ ({
      sendMessage: async () => ({ ok: true }),
      query: async () => [{ id: 41, url: 'moz-extension://test/home/home.html' }],
      remove: async (/** @type {number} */ tabId) => { removed.push(tabId); },
    });
    const tracker = createAppTabTracker({ tabs });
    tracker.onTabReady('app-1', 41, 'chat-a', 'root-a');
    expect(await tracker.closeTab('app-1')).toBe(false);
    expect(removed).toEqual([]);
    expect(tracker.getTabId('app-1')).toBe(null);
  });

  it('closes only a snapshot-verified App tab and fails closed without a snapshot', async () => {
    /** @type {number[]} */ const removed = [];
    let snapshotFails = false;
    const tabs = /** @type {any} */ ({
      sendMessage: async () => ({ ok: true }),
      query: async () => {
        if (snapshotFails) throw new Error('tabs unavailable');
        return [{ id: 41, url: browser.runtime.getURL('/engine-tabs/app-tab/index.html#app-1') }];
      },
      remove: async (/** @type {number} */ tabId) => { removed.push(tabId); },
    });
    const tracker = createAppTabTracker({ tabs });
    tracker.onTabReady('app-1', 41, 'chat-a', 'root-a');
    snapshotFails = true;
    await expect(() => tracker.closeTab('app-1'))
      .toThrow((error) => error?.message === 'app-tab-state-unavailable');
    snapshotFails = false;
    expect(await tracker.closeTab('app-1')).toBe(true);
    expect(removed).toEqual([41]);
  });
});
