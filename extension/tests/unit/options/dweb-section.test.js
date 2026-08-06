// @ts-check

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { DwebSection } from '/options/sections/dweb.js';

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync?.();
};

/** @param {HTMLElement} root @param {string} label */
const button = (root, label) => /** @type {HTMLButtonElement} */ (
  Array.from(root.querySelectorAll('button')).find((entry) => entry.textContent === label)
);

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
      button(root, 'Disable dweb').click();
      await settle();
      const alert = root.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('live network could not be stopped');
      expect(button(root, 'Retry stopping dweb') instanceof HTMLButtonElement).toBe(true);
      button(root, 'Retry stopping dweb').click();
      await settle();
      expect(root.querySelector('[role="alert"]')).toBe(null);
      expect(button(root, 'Enable dweb') instanceof HTMLButtonElement).toBe(true);
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
