// @ts-check
// Options → API integrations (DESIGN-18 P1): component tests over a fake SW send().
//
// Renders the real OptionsApp shell pinned to the api-integrations section and asserts
// the UI seam: stored integrations render (origin + header badge, value NEVER shown),
// the empty state, and that Save dispatches origin-cred/set with the typed origin + key
// (a custom header switches to scheme:'raw'). The options page is outside the e2e
// side-panel loop, so this in-browser render test is the coverage that catches a Mithril
// crash / broken form on the surface I otherwise couldn't eyeball. `send` is the seam —
// no SW, no vault — exactly like memory-suggestions.test.js.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { OptionsApp } from '/options/components/options-app.js';

const need = (/** @type {ParentNode} */ root, /** @type {string} */ sel) => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
};

const UNLOCKED_STATE = Object.freeze({
  vault: { initialized: true, locked: false, prfEnrolled: false, hasRecovery: false },
  settings: {},
  session: { permission: { mode: 'act', confirmActions: false } },
  providers: { current: 'anthropic', hasKey: false },
});

/** @param {Record<string, (msg: any) => any>} [overrides] */
const makeSend = (overrides = {}) => {
  /** @type {any[]} */
  const calls = [];
  const send = Object.assign(
    async (/** @type {any} */ msg) => {
      calls.push(msg);
      const override = overrides[msg.type];
      if (override) return override(msg);
      switch (msg.type) {
        case 'origin-cred/list':
          return { ok: true, integrations: [{ origin: 'https://api.stripe.com', header: 'Authorization' }] };
        default:
          return { ok: true };
      }
    },
    { calls },
  );
  return send;
};

const flush = async () => { await new Promise((r) => setTimeout(r, 0)); m.redraw.sync(); };

const mountView = async (/** @type {any} */ send) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(OptionsApp, { state: UNLOCKED_STATE, send, section: 'api-integrations' }) });
  await flush();
  await flush();
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

describe('options.api-integrations', () => {
  it('renders a stored integration with its origin + header, never a value', async () => {
    const { root, unmount } = await mountView(makeSend());
    try {
      const card = need(root, '.provider-card');
      expect(card.textContent).toContain('https://api.stripe.com');
      expect(card.textContent).toContain('Authorization');     // the header NAME badge
      // The add-key form renders: origin + key (password) + header inputs, and a Save.
      expect(root.querySelectorAll('.provider-card-form input').length).toBe(3);
      expect(need(root, 'input[type=password]')).toBeTruthy();
      expect(root.textContent).toContain('Save');
    } finally { unmount(); }
  });

  it('shows an empty state when no integrations are stored', async () => {
    const { root, unmount } = await mountView(makeSend({ 'origin-cred/list': () => ({ ok: true, integrations: [] }) }));
    try {
      expect(root.textContent).toContain('No API integrations yet');
    } finally { unmount(); }
  });

  it('Save dispatches origin-cred/set with the typed origin + key (Bearer when header blank)', async () => {
    const send = makeSend();
    const { root, unmount } = await mountView(send);
    try {
      const inputs = root.querySelectorAll('.provider-card-form input');
      const origin = /** @type {HTMLInputElement} */ (inputs[0]);
      const key = /** @type {HTMLInputElement} */ (inputs[1]);
      origin.value = 'api.github.com'; origin.dispatchEvent(new Event('input'));
      key.value = 'ghp_abcdefgh1234'; key.dispatchEvent(new Event('input'));
      await flush();
      need(root, '.provider-card-form').dispatchEvent(new Event('submit'));
      await flush();
      const set = send.calls.find((c) => c.type === 'origin-cred/set');
      expect(set).toBeTruthy();
      expect(set.origin).toBe('api.github.com');
      expect(set.key).toBe('ghp_abcdefgh1234');
      expect(set.header).toBe(undefined);   // blank header → Bearer (no raw scheme)
    } finally { unmount(); }
  });
});
