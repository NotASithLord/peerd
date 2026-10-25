// @ts-check
// Options → Memory: the lossy paths need a deliberate second step.
//
// Two defects, one harness. "Delete all" used to re-arm the SAME button, so
// the second click of a double-click wiped every doc with no undo; the
// confirm now renders as a separate Yes/No strip, like the per-doc Delete.
// And a draft lived only in the card's component state, so the first nav
// click (the shell mounts one section at a time) lost it with no warning;
// drafts now survive a section switch, and a tab close asks first.
//
// Mounts the real OptionsApp shell so the section switch is the real
// unmount/remount, exactly like memory-suggestions.test.js. `send` is the
// seam: no SW, no storage.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { OptionsApp } from '/options/components/options-app.js';

/** @typedef {{ type: string } & Record<string, any>} Msg */
/** @typedef {((msg: Msg) => Promise<any>) & { calls: Msg[] }} FakeSend */

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

/** @param {ParentNode} scope @param {string} text */
const hasButton = (scope, text) =>
  [...scope.querySelectorAll('button')].some((b) => b.textContent === text);

const USER_DOC = { id: 'user', kind: 'user', body: '# User memory\n\n- likes tea' };
const PROJECT_DOC = { id: 'project:demo', kind: 'project', workspace: 'demo', body: '# Project\n\n- uses bun' };

const UNLOCKED_STATE = Object.freeze({
  vault: { initialized: true, locked: false, prfEnrolled: false, hasRecovery: false },
  settings: {},
  session: { permission: { mode: 'act', confirmActions: false } },
  providers: { current: 'anthropic', hasKey: false },
});

// Fake one-shot send(): records every message and answers the routes the
// shell, the Memory page and the Activity page (the switch target) fetch.
// `docs` is read on every export, so a test can change it between mounts.
/** @param {{ list: any[] }} docs @param {Record<string, (msg: Msg) => any>} [overrides] */
const makeSend = (docs, overrides = {}) => {
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
        case 'memory/suggestions': return { ok: true, suggestions: [] };
        case 'memory/export': return { ok: true, payload: { version: 1, docs: structuredClone(docs.list) } };
        case 'audit/list': return { ok: true, entries: [], total: 0 };
        default: return { ok: true };
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
const mountShell = async (send) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const nav = { section: 'memory' };
  m.mount(root, {
    view: () => m(OptionsApp, { state: UNLOCKED_STATE, send, section: nav.section }),
  });
  await flush();
  await flush();
  return {
    root,
    /** @param {string} section */
    show: async (section) => { nav.section = section; m.redraw.sync(); await flush(); await flush(); },
    unmount: () => { m.mount(root, null); root.remove(); },
  };
};

/** @param {ParentNode} root */
const editor = (root) => /** @type {HTMLTextAreaElement} */ (need(root, 'textarea.memory-editor'));

/** @param {HTMLTextAreaElement} textarea @param {string} value */
const type = (textarea, value) => {
  textarea.value = value;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  m.redraw.sync();
};

// Leave no stash behind: a dirty draft arms the close guard for the whole
// runner page, and the next test that mounts the same doc would inherit it.
/** @param {ParentNode} root @param {string} body */
const settleDraft = (root, body) => {
  const t = root.querySelector('textarea.memory-editor');
  if (t instanceof HTMLTextAreaElement) type(t, body);
};

const closeAsks = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

describe('options.memory-safety', () => {
  describe('Delete all', () => {
    it('one click arms a separate Yes/No strip and sends nothing', async () => {
      const send = makeSend({ list: [USER_DOC, PROJECT_DOC] });
      const { root, unmount } = await mountShell(send);
      try {
        button(root, 'Delete all').click();
        m.redraw.sync();
        // The trigger left the pointer's spot: a repeat click lands on the
        // question, never on the action.
        expect(hasButton(root, 'Delete all')).toBe(false);
        expect(need(root, '.memory-actions .memory-confirm').textContent)
          .toContain('Delete all memory (2 scopes)?');
        expect(send.calls.some((c) => c.type === 'memory/deleteAll')).toBe(false);
        button(root, 'No').click();
        m.redraw.sync();
        expect(hasButton(root, 'Delete all')).toBe(true);
        expect(send.calls.some((c) => c.type === 'memory/deleteAll')).toBe(false);
      } finally { unmount(); }
    });

    it('Yes sends memory/deleteAll exactly once', async () => {
      const send = makeSend({ list: [USER_DOC] });
      const { root, unmount } = await mountShell(send);
      try {
        button(root, 'Delete all').click();
        m.redraw.sync();
        button(root, 'Yes').click();
        await flush();
        await flush();
        expect(send.calls.filter((c) => c.type === 'memory/deleteAll').length).toBe(1);
        expect(root.querySelector('.key-msg.ok')?.textContent).toBe('All memory deleted.');
      } finally { unmount(); }
    });

    it('keyboard focus lands on No, and comes back to the trigger', async () => {
      // The strip replaces the focused trigger. Without a hand-off a keyboard
      // user lands on <body> and tabs through the whole page to reach it.
      const send = makeSend({ list: [USER_DOC, PROJECT_DOC] }, {
        'memory/deleteAll': () => ({ ok: false, outcomeKnown: true }),
      });
      const { root, unmount } = await mountShell(send);
      try {
        const trigger = button(root, 'Delete all');
        trigger.focus();
        trigger.click();
        m.redraw.sync();
        expect(document.activeElement).toBe(button(root, 'No'));
        button(root, 'No').click();
        m.redraw.sync();
        expect(document.activeElement).toBe(button(root, 'Delete all'));
        button(root, 'Delete all').click();
        m.redraw.sync();
        button(root, 'Yes').click();
        await flush();
        await flush();
        // A refused wipe brings the trigger back; focus follows it.
        expect(root.querySelector('.key-msg.err')).toBeTruthy();
        expect(document.activeElement).toBe(button(root, 'Delete all'));
      } finally { unmount(); }
    });
  });

  describe('drafts', () => {
    it('an unsaved edit survives a section switch, unsaved', async () => {
      const send = makeSend({ list: [USER_DOC] });
      const { root, show, unmount } = await mountShell(send);
      try {
        type(editor(root), `${USER_DOC.body}\n- my long unsaved edit`);
        expect(button(root, 'Save').disabled).toBe(false);
        await show('activity');
        expect(root.querySelector('textarea.memory-editor')).toBe(null);
        await show('memory');
        expect(editor(root).value).toContain('my long unsaved edit');
        expect(button(root, 'Save').disabled).toBe(false);
        expect(send.calls.some((c) => c.type === 'memory/write')).toBe(false);
      } finally {
        settleDraft(root, USER_DOC.body);
        unmount();
      }
    });

    it('a tab close asks while a draft is dirty, and not after Revert', async () => {
      const send = makeSend({ list: [USER_DOC] });
      const { root, unmount } = await mountShell(send);
      try {
        expect(closeAsks()).toBe(false);
        type(editor(root), `${USER_DOC.body}\n- unsaved`);
        expect(closeAsks()).toBe(true);
        button(root, 'Revert').click();
        m.redraw.sync();
        expect(editor(root).value).toBe(USER_DOC.body);
        expect(closeAsks()).toBe(false);
      } finally {
        settleDraft(root, USER_DOC.body);
        unmount();
      }
    });

    it('Save forgets the draft, so nothing stale comes back later', async () => {
      const docs = { list: [{ ...USER_DOC }] };
      const send = makeSend(docs, {
        'memory/write': (msg) => { docs.list = [{ ...USER_DOC, body: msg.body }]; return { ok: true }; },
      });
      const { root, show, unmount } = await mountShell(send);
      try {
        const saved = `${USER_DOC.body}\n- saved line`;
        type(editor(root), saved);
        button(root, 'Save').click();
        await flush();
        await flush();
        expect(closeAsks()).toBe(false);
        await show('activity');
        await show('memory');
        expect(editor(root).value).toBe(saved);
        expect(button(root, 'Save').disabled).toBe(true);
      } finally {
        settleDraft(root, docs.list[0].body);
        unmount();
      }
    });

    for (const action of [
      { label: 'Save', type: 'memory/write' },
      { label: 'Delete', type: 'memory/delete' },
      { label: 'Delete all', type: 'memory/deleteAll' },
    ]) {
      it(`a late ${action.label} reply keeps a newer draft`, async () => {
        const docs = { list: [{ ...USER_DOC }] };
        /** @type {(reply: any) => void} */
        let finish = () => {};
        const reply = new Promise((resolve) => { finish = resolve; });
        const send = makeSend(docs, {
          [action.type]: (msg) => {
            docs.list = action.type === 'memory/write' ? [{ ...USER_DOC, body: msg.body }] : [];
            return reply;
          },
        });
        const { root, show, unmount } = await mountShell(send);
        try {
          if (action.type === 'memory/write') type(editor(root), `${USER_DOC.body}\n- first draft`);
          button(root, action.label).click();
          m.redraw.sync();
          if (action.type !== 'memory/write') {
            button(root, 'Yes').click();
            m.redraw.sync();
          }
          await show('activity');
          // The write finished, but its reply is late. A deleted scope can
          // also be created again before that reply reaches the old card.
          if (docs.list.length === 0) docs.list = [{ ...USER_DOC }];
          await show('memory');
          const newer = `${docs.list[0].body}\n- newer draft`;
          type(editor(root), newer);
          finish({ ok: true });
          await flush();
          await flush();
          await show('activity');
          await show('memory');
          expect(editor(root).value).toBe(newer);
          expect(closeAsks()).toBe(true);
          expect(send.calls.filter((msg) => msg.type === action.type).length).toBe(1);
        } finally {
          finish({ ok: true });
          await flush();
          settleDraft(root, docs.list[0].body);
          unmount();
        }
      });
    }

    it('a draft restored over a doc that changed meanwhile says so', async () => {
      const docs = { list: [{ ...USER_DOC }] };
      const send = makeSend(docs);
      const { root, show, unmount } = await mountShell(send);
      try {
        const draft = `${USER_DOC.body}\n- unsaved`;
        type(editor(root), draft);
        await show('activity');
        // An approved suggestion landed while the draft was parked.
        docs.list = [{ ...USER_DOC, body: `${USER_DOC.body}\n- approved note` }];
        await show('memory');
        expect(editor(root).value).toBe(draft);
        expect(root.querySelector('.memory-card .key-msg.err')?.textContent)
          .toContain('This memory changed while your draft was open');
      } finally {
        settleDraft(root, docs.list[0].body);
        unmount();
      }
    });
  });
});
