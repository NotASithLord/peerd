// @ts-check

import { describe, expect, it } from '../../framework.js';
import { createJsTabTracker } from '/background/notebook-tab-tracker.js';

describe('Notebook tab tracker quiescence', () => {
  it('flushes through an instance-pinned tab message', async () => {
    /** @type {any[]} */ const messages = [];
    const tracker = createJsTabTracker({
      sendTabMessage: async (tabId, message) => {
        messages.push({ tabId, message });
        return { ok: true };
      },
    });
    tracker.onTabReady('notebook-1', 42);
    expect(await tracker.quiesceTab('notebook-1')).toBe(true);
    expect(messages).toEqual([{
      tabId: 42,
      message: { type: 'js/quiesce', action: 'acquire', notebookId: 'notebook-1' },
    }]);
  });

  it('fails closed when the editor flush fails', async () => {
    const tracker = createJsTabTracker({
      sendTabMessage: async () => ({ ok: false, error: 'quota exceeded' }),
    });
    tracker.onTabReady('notebook-1', 42);
    await expect(() => tracker.quiesceTab('notebook-1'))
      .toThrow((error) => error?.message === 'quota exceeded');
  });
});
