// @ts-check

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { EmptyState, promptsFor } from '/sidepanel/components/chat-view.js';
import { InputBar } from '/sidepanel/components/input-bar.js';
import { eventBelongsToSidepanelWindow, focusBrowserTab } from '/sidepanel/tab-context.js';

/** @param {'none'|'unknown'|'web'|'protected_private'|'protected_sensitive'} status */
const browsePrompt = (status) => promptsFor({
  surface: 'sidepanel',
  activeTabStatus: status,
}).find((prompt) => prompt.type === 'web');

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync();
};

/** @param {()=>unknown} fn */
const until = async (fn) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fn()) return;
    await flush();
  }
  throw new Error('timeout');
};

describe('sidepanel protected-tab starter', () => {
  it('offers summarize only for a verified public page', () => {
    const prompt = browsePrompt('web');
    expect(prompt?.label).toBe('Summarize');
    expect(prompt?.text).toBe('Summarize the current page.');
  });

  it('replaces private and sensitive page work with a disabled policy receipt', () => {
    const privatePage = browsePrompt('protected_private');
    const sensitivePage = browsePrompt('protected_sensitive');
    expect(privatePage?.label).toBe('Protected');
    expect(privatePage?.blocked).toBe(true);
    expect(privatePage?.text).toContain('private-network page');
    expect(sensitivePage?.label).toBe('Protected');
    expect(sensitivePage?.blocked).toBe(true);
    expect(sensitivePage?.text).toContain('sensitive page');
  });

  it('keeps the generic browse starter when policy status is unavailable', () => {
    const prompt = browsePrompt('unknown');
    expect(prompt?.label).toBe('Browse');
    expect(prompt?.text.includes('current page')).toBe(false);
  });

  it('ignores active-tab events from another browser window', () => {
    expect(eventBelongsToSidepanelWindow(4, 9)).toBe(false);
    expect(eventBelongsToSidepanelWindow(4, 4)).toBe(true);
    expect(eventBelongsToSidepanelWindow(null, 9)).toBe(true);
  });

  it('activates a protected tab and focuses its current window', async () => {
    /** @type {Array<[string, number, Record<string, boolean>]>} */
    const calls = [];
    const focused = await focusBrowserTab({
      tabs: {
        update: async (tabId, update) => {
          calls.push(['tab', tabId, update]);
          return { windowId: 8 };
        },
      },
      windows: {
        update: async (windowId, update) => { calls.push(['window', windowId, update]); },
      },
    }, 14, 3);

    expect(focused).toBe(true);
    expect(calls).toEqual([
      ['tab', 14, { active: true }],
      ['window', 8, { focused: true }],
    ]);
  });

  it('reports a failed protected-tab focus without throwing', async () => {
    const focused = await focusBrowserTab({
      tabs: { update: async () => { throw new Error('tab closed'); } },
    }, 14, 3);
    expect(focused).toBe(false);
  });

  it('fences a stuck starter send across double-click and reload', async () => {
    localStorage.removeItem('peerd.draft.new');
    localStorage.removeItem('peerd.unconfirmed-send.new');
    /** @type {any[]} */
    const calls = [];
    /** @type {(cause:Error)=>void} */
    let rejectStarter = () => {};
    /** @param {any} message */
    const send = (message) => {
      calls.push(message);
      if (message.checkOnly) return Promise.resolve({ ok: true, duplicate: true });
      return new Promise((_resolve, reject) => { rejectStarter = reject; });
    };
    const state = {
      streaming: false,
      session: null,
      providers: { hasKey: true, current: 'anthropic' },
      cost: null,
    };
    const root = document.createElement('div');
    document.body.appendChild(root);
    try {
      m.mount(root, { view: () => m('div', [
        m(EmptyState, { canSend: true, send, surface: 'sidepanel' }),
        m(InputBar, { state, send, voiceManager: null }),
      ]) });
      await flush();
      const card = /** @type {HTMLButtonElement|null} */ (root.querySelector('.path-card'));
      if (!card) throw new Error('starter card missing');
      card.click();
      card.click();
      expect(calls.length).toBe(1);
      expect(calls[0].operationId).toBeTruthy();
      expect(calls[0].sessionId).toBe(null);
      expect(localStorage.getItem('peerd.unconfirmed-send.new'))
        .toContain(calls[0].operationId);
      rejectStarter(Object.assign(new Error('receipt lost'), { outcomeKnown: false }));
      await flush();
      await flush();
      expect(card.disabled).toBe(true);
      card.click();
      expect(calls.length).toBe(1);

      m.mount(root, null);
      m.mount(root, { view: () => m(InputBar, { state, send, voiceManager: null }) });
      await flush();
      expect(root.textContent?.includes('Check delivery')).toBe(true);
      expect(/** @type {HTMLButtonElement} */ (root.querySelector('.send-btn')).disabled).toBe(true);
      const check = /** @type {HTMLButtonElement|undefined} */ (
        [...root.querySelectorAll('button')].find((button) => button.textContent === 'Check delivery')
      );
      if (!check) throw new Error('delivery check missing');
      check.click();
      await until(() => calls.length === 2);
      expect(calls[1].checkOnly).toBe(true);
      expect(calls[1].operationId).toBe(calls[0].operationId);
      expect(calls.filter((message) => !message.checkOnly).length).toBe(1);
      expect(localStorage.getItem('peerd.unconfirmed-send.new')).toBe(null);
    } finally {
      m.mount(root, null);
      root.remove();
      localStorage.removeItem('peerd.draft.new');
      localStorage.removeItem('peerd.unconfirmed-send.new');
    }
  });
});
