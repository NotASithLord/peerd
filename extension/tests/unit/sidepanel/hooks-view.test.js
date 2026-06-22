// @ts-check
// Context → Hooks tab — component tests over a fake SW send().
//
// Renders the real Mithril component against fixture hook lists and
// asserts (a) provenance renders honestly — built-ins visibly lack the
// disable/remove controls, user hooks have them — and (b) interactions
// dispatch exactly the SW messages the routes expect (hooks/toggle,
// hooks/remove, hooks/save). No SW, no storage: `send` is the seam.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { HooksView, orderHooks } from '/sidepanel/components/hooks-view.js';

/** @typedef {import('/sidepanel/components/hooks-view.js').HookRecord} HookRecord */
/** @typedef {{ type: string } & Record<string, any>} Msg */
/** @typedef {Record<string, (msg: Msg) => any>} Overrides */
/** @typedef {((msg: Msg) => Promise<any>) & { calls: Msg[] }} FakeSend */

// Query that asserts presence — a null here is a real test failure (same
// as the old direct .click()/.value access on a missing node). The
// optional ctor drives the return type so .value/.checked/.title resolve.
/**
 * @template {HTMLElement} [T=HTMLElement]
 * @param {ParentNode} root
 * @param {string} sel
 * @param {new () => T} [_ctor]
 * @returns {T}
 */
const need = (root, sel, _ctor) => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return /** @type {T} */ (el);
};

// Find a <button> by exact text within a scope; throws if absent so
// `.click()` mirrors the old `.find(...).click()`.
/**
 * @param {ParentNode} scope
 * @param {string} text
 * @returns {HTMLButtonElement}
 */
const button = (scope, text) => {
  const el = [...scope.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!el) throw new Error(`missing button: ${text}`);
  return el;
};

// Find the .hook-row whose text includes `needle`; throws if absent.
/**
 * @param {ParentNode} root
 * @param {string} needle
 * @returns {HTMLElement}
 */
const rowWith = (root, needle) => {
  const el = [...root.querySelectorAll('.hook-row')]
    .find((r) => r.textContent?.includes(needle));
  if (!el) throw new Error(`missing hook-row: ${needle}`);
  return /** @type {HTMLElement} */ (el);
};

const FIXTURE_HOOKS = [
  {
    id: 'egress-allowlist', event: 'pre-tool-use', enabled: true, order: 10,
    match: '*', isDefault: true, kind: 'builtin',
    doc: 'Blocks network tools whose target origin is off the provider allowlist — the always-on egress floor.',
  },
  {
    id: 'block-secrets', event: 'pre-tool-use', enabled: true, order: 100,
    match: 'type', isDefault: false, kind: 'declarative',
    doc: 'Block the type tool from typing secrets.',
  },
  {
    id: 'observer', event: 'post-tool-use', enabled: false, order: 100,
    match: '*', isDefault: false, kind: 'js', doc: '',
  },
];

// Fake one-shot send(): records every message, answers hooks/list with
// the fixture (cloned so component-side sorting can't bleed between
// tests), and lets a test override any route's reply.
/** @param {Overrides} [overrides] */
const makeSend = (overrides = {}) => {
  /** @type {Msg[]} */
  const calls = [];
  /** @type {FakeSend} */
  const send = Object.assign(
    /** @param {Msg} msg */
    async (msg) => {
      calls.push(msg);
      const override = overrides[msg.type];
      if (override) return override(msg);
      if (msg.type === 'hooks/list') {
        return { ok: true, hooks: structuredClone(FIXTURE_HOOKS) };
      }
      return { ok: true };
    },
    { calls },
  );
  return send;
};

// Let the component's async oninit fetch settle, then force a sync
// redraw so assertions see the final DOM without racing the rAF-based
// auto-redraw.
const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  m.redraw.sync();
};

/** @param {FakeSend} send */
const mountView = async (send) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(HooksView, { send }) });
  await flush();
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

describe('sidepanel.hooks-view', () => {
  describe('orderHooks', () => {
    it('sorts pre before post, then by order, then id', () => {
      // Minimal fixtures — orderHooks only reads id/event/order. Cast to
      // the production record type they stand in for.
      const sorted = orderHooks(/** @type {HookRecord[]} */ ([
        { id: 'z-post', event: 'post-tool-use', order: 1 },
        { id: 'b-pre', event: 'pre-tool-use', order: 50 },
        { id: 'a-pre', event: 'pre-tool-use', order: 50 },
        { id: 'low-pre', event: 'pre-tool-use', order: 10 },
      ]));
      expect(sorted.map((h) => h.id)).toEqual(['low-pre', 'a-pre', 'b-pre', 'z-post']);
    });
  });

  describe('rendering', () => {
    it('renders every hook with phase, match, and provenance', async () => {
      const { root, unmount } = await mountView(makeSend());
      try {
        const rows = root.querySelectorAll('.hook-row');
        expect(rows.length).toBe(3);
        const text = root.textContent;
        expect(text).toContain('egress-allowlist');
        expect(text).toContain('block-secrets');
        expect(text).toContain('built-in');
        expect(text).toContain('user');
        // The user hook's tool-name match renders.
        expect(text).toContain('type');
        // Phase badges exist for both events.
        const badges = [...root.querySelectorAll('.hook-phase')].map((b) => b.textContent);
        expect(badges).toContain('pre');
        expect(badges).toContain('post');
      } finally { unmount(); }
    });

    it('built-in hooks are visibly not disableable, with the reason shown', async () => {
      const { root, unmount } = await mountView(makeSend());
      try {
        const egress = rowWith(root, 'egress-allowlist');
        expect(egress.querySelector('.hook-lock')?.textContent).toBe('always on');
        // No toggle, no remove for a built-in.
        expect(egress.querySelector('input[type="checkbox"]')).toBe(null);
        expect(egress.querySelector('.hook-x')).toBe(null);
        // The reason is visible in the row (doc line) AND on the control.
        expect(egress.textContent).toContain('always-on egress floor');
        expect(need(egress, '.hook-lock').title).toContain('safety floor');
      } finally { unmount(); }
    });

    it('user hooks expose toggle + remove; disabled ones render off', async () => {
      const { root, unmount } = await mountView(makeSend());
      try {
        const user = rowWith(root, 'block-secrets');
        expect(need(user, 'input[type="checkbox"]', HTMLInputElement).checked).toBe(true);
        expect(user.querySelector('.hook-x')).toBeTruthy();

        const off = rowWith(root, 'observer');
        expect(need(off, 'input[type="checkbox"]', HTMLInputElement).checked).toBe(false);
        expect(off.classList.contains('is-off')).toBe(true);
      } finally { unmount(); }
    });
  });

  describe('interactions', () => {
    it('toggling a user hook dispatches hooks/toggle with the new state', async () => {
      const send = makeSend();
      const { root, unmount } = await mountView(send);
      try {
        const cb = need(root, 'input[aria-label="Enable block-secrets"]', HTMLInputElement);
        cb.checked = false;
        cb.dispatchEvent(new Event('change'));
        await flush();
        const toggle = send.calls.find((c) => c.type === 'hooks/toggle');
        expect(toggle).toEqual({ type: 'hooks/toggle', id: 'block-secrets', enabled: false });
        // Successful mutation re-fetches the list (SW is source of truth).
        expect(send.calls.filter((c) => c.type === 'hooks/list').length).toBeGreaterThan(1);
      } finally { unmount(); }
    });

    it('remove is two-step and dispatches hooks/remove on confirm', async () => {
      const send = makeSend();
      const { root, unmount } = await mountView(send);
      try {
        need(root, 'button[aria-label="Remove block-secrets"]').click();
        await flush();
        // First click arms the confirm — nothing dispatched yet.
        expect(send.calls.some((c) => c.type === 'hooks/remove')).toBe(false);
        button(root, 'Remove?').click();
        await flush();
        const remove = send.calls.find((c) => c.type === 'hooks/remove');
        expect(remove).toEqual({ type: 'hooks/remove', id: 'block-secrets' });
      } finally { unmount(); }
    });

    it('the add form posts markdown via hooks/save', async () => {
      const send = makeSend();
      const { root, unmount } = await mountView(send);
      try {
        button(root, 'Add hook…').click();
        await flush();
        const editor = need(root, '.hook-add-editor', HTMLTextAreaElement);
        editor.value = '---\nid: x\nevent: pre-tool-use\n---\n';
        editor.dispatchEvent(new Event('input'));
        await flush();
        const form = need(root, 'form.hook-add');
        form.dispatchEvent(new Event('submit'));
        await flush();
        const save = send.calls.find((c) => c.type === 'hooks/save');
        expect(save?.markdown).toContain('id: x');
      } finally { unmount(); }
    });

    it('a failed save surfaces the compile error', async () => {
      const send = makeSend({
        'hooks/save': () => ({ ok: false, error: "hook 'x': invalid event 'nope'" }),
      });
      const { root, unmount } = await mountView(send);
      try {
        button(root, 'Add hook…').click();
        await flush();
        const editor = need(root, '.hook-add-editor', HTMLTextAreaElement);
        editor.value = '---\nid: x\nevent: nope\n---\n';
        editor.dispatchEvent(new Event('input'));
        await flush();
        need(root, 'form.hook-add').dispatchEvent(new Event('submit'));
        await flush();
        expect(root.querySelector('.key-msg.err')?.textContent).toContain('invalid event');
      } finally { unmount(); }
    });
  });
});
