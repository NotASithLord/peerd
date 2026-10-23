// @ts-check

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { INITIAL_STATE } from '/sidepanel/chat-reducer.js';
import { ChatView } from '/sidepanel/components/chat-view.js';
import { createContextSnapshots } from '/shared/model-context-snapshot.js';

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync();
};

for (const closing of ['Escape', 'Close', 'backdrop']) {
  describe(`sidepanel context inspector focus: ${closing}`, () => {
    it('keeps the menu closed, traps visible summaries and returns to the debug button', async () => {
      const state = structuredClone(INITIAL_STATE);
      const sessionId = `context-focus-${closing}`;
      state.session.sessionId = sessionId;
      state.settings.devMode = true;
      state.settings.voiceOnboardingDismissed = true;
      const ring = createContextSnapshots();
      ring.record({ sessionId, provider: state.providers.current, model: state.providers.model,
        messages: state.session.messages });
      /** @type {(value:any)=>void} */
      let finish = () => {};
      const pending = new Promise((resolve) => { finish = resolve; });
      /** @type {any[]} */
      const sent = [];
      const root = document.createElement('div');
      document.body.appendChild(root);
      m.mount(root, { view: () => m(ChatView, {
        state, voiceManager: null, uiActions: {},
        send: async (/** @type {any} */ message) => {
          sent.push(message);
          return message.type === 'session/contextSnapshots' ? pending : { ok: true, options: [] };
        },
      }) });
      try {
        const trigger = /** @type {HTMLButtonElement} */ (root.querySelector('.debug-export-btn'));
        trigger.focus(); trigger.click();
        await settle();
        const item = /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('.debug-menu-item')]
          .find((button) => button.textContent === 'context inspector'));
        item.focus(); item.click();
        await settle();
        const dialog = /** @type {HTMLElement} */ (root.querySelector('.context-inspector'));
        const close = /** @type {HTMLButtonElement} */ (dialog.querySelector('.ctx-close'));
        expect(root.querySelector('.debug-menu')).toBe(null);
        expect(item.isConnected).toBe(false);
        expect(dialog.getAttribute('role')).toBe('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-labelledby')).toBe('context-inspector-title');
        expect(root.querySelector('#context-inspector-title')?.textContent).toBe('context inspector');
        expect(close.getAttribute('aria-label')).toBe('Close');
        expect(document.activeElement).toBe(close);
        expect(dialog.textContent).toContain('loading…');
        close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(close);
        finish({ ok: true, snapshots: ring.snapshotsFor(sessionId) });
        await settle();
        const details = /** @type {HTMLDetailsElement} */ (dialog.querySelector('.ctx-snap'));
        const outer = /** @type {HTMLElement} */ (details.querySelector('summary'));
        const nested = /** @type {HTMLElement} */ (details.querySelector('.ctx-snap-system summary'));
        expect(details.open).toBe(false);
        expect(outer.getClientRects().length > 0).toBe(true);
        expect(nested.checkVisibility()).toBe(false);
        close.focus();
        close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(outer);
        outer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(close);
        outer.click();
        await settle();
        expect(details.open).toBe(true);
        expect(nested.getClientRects().length > 0).toBe(true);
        close.focus();
        close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(nested);
        nested.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(close);
        m.redraw.sync();
        if (closing === 'Escape') dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        else if (closing === 'Close') close.click();
        else /** @type {HTMLElement} */ (root.querySelector('.peerd-modal-backdrop')).click();
        await settle();
        expect(root.querySelector('.context-inspector')).toBe(null);
        expect(root.querySelector('.debug-menu')).toBe(null);
        expect(document.activeElement).toBe(trigger);
        expect(sent.filter((message) => message.type === 'session/contextSnapshots')).toEqual([
          { type: 'session/contextSnapshots', sessionId },
        ]);
        expect(sent.some((message) => message.type === 'agent/send')).toBe(false);
      } finally {
        finish({ ok: true, snapshots: [] });
        m.mount(root, null); root.remove();
        localStorage.removeItem(`peerd.draft.${sessionId}`);
      }
    });
  });
}
