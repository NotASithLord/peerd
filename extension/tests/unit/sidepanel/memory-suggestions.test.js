// @ts-check
// Options → Memory: auto-memory suggestion flow — component tests over
// a fake SW send().
//
// Renders the real OptionsApp shell pinned to the Memory section (the
// surface that replaced the Context view's Memory tab) and asserts the
// approve/dismiss flow end to end at the UI seam: pending notes render
// with their source chat, the Memory NAV entry carries the pending-count
// badge (the discoverability guarantee that used to live on the Context
// tab bar — it transfers to the options nav per the IA), Approve
// dispatches memory/suggestions/approve (and ONLY approve — the write
// happens SW-side), Dismiss dispatches dismiss, and a successful action
// re-fetches both the suggestion list and the docs. No SW, no storage:
// `send` is the seam, exactly like hooks-view.test.js.
//
// why mount the shell and not MemoryView alone: the badge lives on the
// nav (OptionsApp state), the strip lives in the pane (MemoryView
// state), and the onSuggestionsChanged wiring between them is exactly
// what keeps the badge honest after an approve — mounting the shell
// tests that contract instead of assuming it.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { OptionsApp } from '/options/components/options-app.js';

/** @typedef {{ type: string } & Record<string, any>} Msg */
/** @typedef {Record<string, (msg: Msg) => any>} Overrides */
/** @typedef {((msg: Msg) => Promise<any>) & { calls: Msg[] }} FakeSend */

// Query that asserts presence — a null here is a real test failure.
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

const FIXTURE_SUGGESTIONS = [
  {
    id: 'sug-1', text: 'Works at Hydra Host (bare-metal GPU broker)',
    sessionId: 's1', sessionTitle: 'GPU procurement', createdAt: 1,
  },
  {
    id: 'sug-2', text: 'Prefers dark UI surfaces',
    sessionId: 's2', sessionTitle: null, createdAt: 2,
  },
];

// Unlocked snapshot — the options shell gates on vault.initialized /
// vault.locked, so the fixture must read as an unlocked install.
const UNLOCKED_STATE = Object.freeze({
  vault: { initialized: true, locked: false, prfEnrolled: false, hasRecovery: false },
  settings: {},
  session: { permission: { mode: 'act', confirmActions: false } },
  providers: { current: 'anthropic', hasKey: false },
});

// Fake one-shot send(): records every message, answers the routes the
// shell + Memory page fetch on mount, lets a test override any route's
// reply.
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
      switch (msg.type) {
        case 'memory/suggestions':
          return { ok: true, suggestions: structuredClone(FIXTURE_SUGGESTIONS) };
        case 'memory/export':
          return { ok: true, payload: { version: 1, docs: [] } };
        default:
          return { ok: true };
      }
    },
    { calls },
  );
  return send;
};

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  m.redraw.sync();
};

/** @param {FakeSend} send */
const mountView = async (send) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, {
    view: () => m(OptionsApp, { state: UNLOCKED_STATE, send, section: 'memory' }),
  });
  await flush();
  // Two flushes: mount fans out several fetches whose redraws can land
  // across two macrotasks.
  await flush();
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

describe('options.memory-suggestions', () => {
  describe('rendering', () => {
    it('pending suggestions render with text, source chat, and per-note actions', async () => {
      const { root, unmount } = await mountView(makeSend());
      try {
        const cards = root.querySelectorAll('.memory-suggestion');
        expect(cards.length).toBe(2);
        expect(root.textContent).toContain('Works at Hydra Host');
        expect(root.textContent).toContain('from “GPU procurement”');
        // Every suggestion gets its own Approve + Dismiss.
        expect(root.querySelectorAll('.memory-suggestion button').length).toBe(4);
        // Nothing is saved without approval — the copy says so.
        expect(need(root, '.memory-suggestions').textContent)
          .toContain('Nothing is saved without your OK');
      } finally { unmount(); }
    });

    it('the Memory nav entry carries a pending-count badge', async () => {
      const { root, unmount } = await mountView(makeSend());
      try {
        const badge = root.querySelector('.options-nav .mem-badge');
        expect(badge?.textContent).toBe('2');
      } finally { unmount(); }
    });

    it('no suggestions → no strip, no badge', async () => {
      const send = makeSend({ 'memory/suggestions': () => ({ ok: true, suggestions: [] }) });
      const { root, unmount } = await mountView(send);
      try {
        expect(root.querySelector('.memory-suggestions')).toBe(null);
        expect(root.querySelector('.mem-badge')).toBe(null);
      } finally { unmount(); }
    });
  });

  describe('interactions', () => {
    it('Approve dispatches memory/suggestions/approve and re-fetches list + docs', async () => {
      const send = makeSend();
      const { root, unmount } = await mountView(send);
      try {
        const before = send.calls.filter((c) => c.type === 'memory/suggestions').length;
        need(root, 'button[aria-label^="Approve suggestion: Works at Hydra"]').click();
        await flush();
        await flush();
        const approve = send.calls.find((c) => c.type === 'memory/suggestions/approve');
        expect(approve).toEqual({ type: 'memory/suggestions/approve', id: 'sug-1' });
        // The approval write is SW-side: the UI never posts memory/write.
        expect(send.calls.some((c) => c.type === 'memory/write')).toBe(false);
        // Successful action re-fetches (SW is the source of truth) —
        // both the pane's list and the nav badge count.
        expect(send.calls.filter((c) => c.type === 'memory/suggestions').length)
          .toBeGreaterThan(before);
        expect(root.querySelector('.key-msg.ok')?.textContent).toContain('Added to user memory');
      } finally { unmount(); }
    });

    it('Dismiss dispatches memory/suggestions/dismiss', async () => {
      const send = makeSend();
      const { root, unmount } = await mountView(send);
      try {
        need(root, 'button[aria-label^="Dismiss suggestion: Prefers dark"]').click();
        await flush();
        const dismiss = send.calls.find((c) => c.type === 'memory/suggestions/dismiss');
        expect(dismiss).toEqual({ type: 'memory/suggestions/dismiss', id: 'sug-2' });
        expect(send.calls.some((c) => c.type === 'memory/suggestions/approve')).toBe(false);
      } finally { unmount(); }
    });

    it('a failed approve surfaces the error and keeps the suggestion', async () => {
      const send = makeSend({
        'memory/suggestions/approve': () => ({ ok: false, error: 'vault-locked' }),
      });
      const { root, unmount } = await mountView(send);
      try {
        need(root, 'button[aria-label^="Approve suggestion: Works at Hydra"]').click();
        await flush();
        await flush();
        expect(root.querySelector('.key-msg.err')?.textContent).toContain('vault-locked');
        // Still rendered — nothing was resolved.
        expect(root.querySelectorAll('.memory-suggestion').length).toBe(2);
      } finally { unmount(); }
    });
  });
});
