// @ts-check

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { DwebSection } from '/options/sections/dweb.js';

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync?.();
};

// The switch carries no text - its accessible name is the assertion surface,
// which is also what a screen reader announces. That is the point of the row:
// the control states WHERE YOU STAND, so the test can read the same string the
// user hears instead of an imperative like "Disable dweb".
/** @param {HTMLElement} root */
const networkSwitch = (root) => /** @type {HTMLButtonElement} */ (
  root.querySelector('button[role="switch"]')
);
/** @param {HTMLElement} root */
const rowState = (root) => ({
  name: networkSwitch(root)?.getAttribute('aria-label') ?? '',
  checked: networkSwitch(root)?.getAttribute('aria-checked') ?? '',
  pill: root.querySelector('.set-pill')?.textContent ?? '',
  badge: root.querySelector('.set-badge')?.textContent ?? '',
});

describe('options.dweb live-stop status', () => {
  it('reports an incomplete stop and keeps the retry explicit', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const state = { settings: { dwebEnabled: true, dwebAgentEnabled: false } };
    /** @type {any[]} */
    const calls = [];
    let attempt = 0;
    const send = async (/** @type {any} */ message) => {
      calls.push(message);
      attempt += 1;
      const reply = attempt === 1
        ? { ok: false, error: 'dweb-stop-failed', settings: { ...state.settings, dwebEnabled: false } }
        : { ok: true, settings: { ...state.settings, dwebEnabled: false } };
      state.settings = reply.settings;
      return reply;
    };
    m.mount(root, { view: () => m(DwebSection, { state, send, loadStatus: async () => null }) });
    try {
      expect(rowState(root).pill).toBe('ON');
      networkSwitch(root).click();
      await settle();

      // The setting persisted Off but the network did not stop. The row must
      // NOT read as a clean OFF - the badge is what carries the disagreement.
      const alert = root.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('live network could not be stopped');
      expect(rowState(root).badge).toBe('STILL RUNNING');
      expect(rowState(root).name).toContain('retry stopping');
      expect(networkSwitch(root).disabled).toBe(false);

      networkSwitch(root).click();
      await settle();
      expect(root.querySelector('[role="alert"]')).toBe(null);
      expect(rowState(root).badge).toBe('');
      expect(rowState(root).pill).toBe('OFF');
      expect(rowState(root).checked).toBe('false');
      expect(calls.map((call) => call.patch)).toEqual([
        { dwebEnabled: false },
        { dwebEnabled: false },
      ]);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });
});
