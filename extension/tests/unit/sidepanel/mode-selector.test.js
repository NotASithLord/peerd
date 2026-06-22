// @ts-check
// ModeSelector — the Plan/Act + confirm-actions control (Feature 03,
// post-tier-collapse). These tests render the real component against
// permission fixtures and pin the contract that replaced the old tier
// dropdown: Plan ⇄ Act buttons plus ONE confirm toggle that drives the
// same permission/set route the Settings toggle uses (single source of
// truth — no second axis).

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { ModeSelector } from '/sidepanel/components/mode-badge.js';

/** @typedef {{ mode?: string, confirmActions?: boolean } | null | undefined} Permission */

/**
 * @typedef {import('/sidepanel/components/mode-badge.js').Send & { calls: object[] }} FakeSend
 */

// Fake send(): records permission/set calls; the component fires and
// forgets (state comes back via the SW push, not the reply).
const makeSend = () => {
  /** @type {object[]} */
  const calls = [];
  /** @type {FakeSend} */
  const send = Object.assign(
    /** @param {object} msg */
    async (msg) => { calls.push(msg); return { ok: true }; },
    { calls },
  );
  return send;
};

/**
 * @param {Permission} permission
 * @param {FakeSend} send
 */
const mount = (permission, send) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(ModeSelector, { permission, send }) });
  m.redraw.sync();
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

// Query that asserts presence — the test relies on the element existing,
// so a null here is a real failure (same as the old direct .click()).
/**
 * @template {HTMLElement} [T=HTMLElement]
 * @param {ParentNode} root
 * @param {string} sel
 * @returns {T}
 */
const need = (root, sel) => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return /** @type {T} */ (el);
};

describe('ModeSelector (Plan/Act + confirm toggle)', () => {
  it('renders Plan/Act buttons and a single confirm toggle — no tier select', () => {
    const { root, unmount } = mount({ mode: 'act', confirmActions: false }, makeSend());
    try {
      const modes = root.querySelectorAll('.planact-mode');
      expect(modes.length).toBe(2);
      expect(modes[0].textContent).toBe('Plan');
      expect(modes[1].textContent).toBe('Act');
      // The old three-tier dropdown is gone.
      expect(root.querySelector('select')).toBe(null);
      const confirm = need(root, '.planact-confirm');
      expect(!!confirm).toBe(true);
      expect(confirm.textContent).toBe('Confirm: off');
      expect(confirm.getAttribute('aria-pressed')).toBe('false');
    } finally { unmount(); }
  });

  it('clicking the inactive mode sends permission/set with the mode only', () => {
    const send = makeSend();
    const { root, unmount } = mount({ mode: 'act', confirmActions: false }, send);
    try {
      /** @type {HTMLElement} */ (root.querySelectorAll('.planact-mode')[0]).click();  // Plan
      expect(send.calls).toEqual([{ type: 'permission/set', mode: 'plan' }]);
    } finally { unmount(); }
  });

  it('clicking the confirm toggle sends permission/set with the flipped boolean', () => {
    const send = makeSend();
    const { root, unmount } = mount({ mode: 'act', confirmActions: false }, send);
    try {
      need(root, '.planact-confirm').click();
      expect(send.calls).toEqual([{ type: 'permission/set', confirmActions: true }]);
    } finally { unmount(); }
  });

  it('confirm toggle reflects ON state and flips back off', () => {
    const send = makeSend();
    const { root, unmount } = mount({ mode: 'act', confirmActions: true }, send);
    try {
      const confirm = /** @type {HTMLButtonElement} */ (need(root, '.planact-confirm'));
      expect(confirm.textContent).toBe('Confirm: on');
      expect(confirm.getAttribute('aria-pressed')).toBe('true');
      expect(confirm.disabled).toBe(false);
      confirm.click();
      expect(send.calls).toEqual([{ type: 'permission/set', confirmActions: false }]);
    } finally { unmount(); }
  });

  it('disables the confirm toggle in Plan mode (Plan blocks, never confirms)', () => {
    const send = makeSend();
    const { root, unmount } = mount({ mode: 'plan', confirmActions: false }, send);
    try {
      const confirm = /** @type {HTMLButtonElement} */ (need(root, '.planact-confirm'));
      expect(confirm.disabled).toBe(true);
      confirm.click();  // disabled buttons don't fire
      expect(send.calls.length).toBe(0);
    } finally { unmount(); }
  });

  it('fails toward "confirms on" when permission state is missing', () => {
    // No SW state yet → render the cautious reading the policy enforces:
    // Plan mode, confirm shown as on.
    const { root, unmount } = mount(undefined, makeSend());
    try {
      const modes = root.querySelectorAll('.planact-mode');
      expect(modes[0].className.includes('is-active')).toBe(true);  // Plan
      expect(need(root, '.planact-confirm').textContent).toBe('Confirm: on');
    } finally { unmount(); }
  });
});
