// @ts-check

import { describe, expect, it } from '../../framework.js';
import { createAppTabTracker } from '/background/app-tab-tracker.js';

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
});
