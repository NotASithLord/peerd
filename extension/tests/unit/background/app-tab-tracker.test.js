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
});
