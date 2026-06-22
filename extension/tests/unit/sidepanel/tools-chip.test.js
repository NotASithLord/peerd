// @ts-check
// /tools presence chip — the chat mode-row must make a narrowed tool
// manifest VISIBLE where the authority is exercised (same contract as
// the /system chip it sits next to). Real ChatView mounted against a
// fake SW send(); we assert the chip's presence/label tracks
// state.session.toolManifest.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { ChatView } from '/sidepanel/components/chat-view.js';

/** @typedef {{ type: string } & Record<string, any>} Msg */

// Generic fake send() covering every route ChatView's children hit at
// init (RalphPanel → ralph/status).
const makeSend = () => /** @param {Msg} msg */ async (msg) => {
  if (msg.type === 'ralph/status') return { ok: true, state: null, plan: { goal: '' }, summary: null };
  if (msg.type === 'models/options') return { ok: true, options: [], selected: null };
  return { ok: true };
};

/** @param {Record<string, any>} [session] */
const baseState = (session = {}) => ({
  session: {
    sessionId: 's-1',
    messages: [],
    permission: { mode: 'act', tier: 'full-auto' },
    customSystemPrompt: null,
    toolManifest: null,
    ...session,
  },
  // hasKey false keeps the view minimal (no ModelPicker/CostChip/voice
  // onboarding) — the mode row + chips render regardless.
  providers: { hasKey: false },
  settings: { voiceOnboardingDismissed: true, voiceEnabled: false },
});

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  m.redraw.sync();
};

/** @param {ReturnType<typeof baseState>} state */
const mountChat = async (state) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const send = makeSend();
  m.mount(root, { view: () => m(ChatView, { state, send, voiceManager: null, uiActions: {} }) });
  await flush();
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

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

// The mode-row chip whose text includes '/tools'; throws if absent.
/**
 * @param {ParentNode} root
 * @returns {HTMLElement}
 */
const toolsChip = (root) => {
  const el = [...root.querySelectorAll('.chat-mode-row .session-sys-badge')]
    .find((c) => c.textContent?.includes('/tools'));
  if (!el) throw new Error('missing /tools chip');
  return /** @type {HTMLElement} */ (el);
};

describe('sidepanel.tools-chip', () => {
  it('no manifest → no /tools chip in the mode row', async () => {
    const { root, unmount } = await mountChat(baseState());
    try {
      const row = need(root, '.chat-mode-row');
      expect(row).toBeTruthy();
      expect((row.textContent ?? '').includes('/tools')).toBe(false);
    } finally { unmount(); }
  });

  it('a preset manifest renders the chip with its label and a how-to-clear hover', async () => {
    const { root, unmount } = await mountChat(baseState({ toolManifest: { preset: 'research' } }));
    try {
      const chip = toolsChip(root);
      expect(chip).toBeTruthy();
      expect(chip.textContent).toBe('/tools research');
      expect(chip.title).toContain('/tools full');
    } finally { unmount(); }
  });

  it('a custom allow-list manifest labels the chip with the tool count', async () => {
    const { root, unmount } = await mountChat(baseState({ toolManifest: { allow: ['get', 'check'] } }));
    try {
      const chip = toolsChip(root);
      expect(chip.textContent).toBe('/tools custom (2 tools)');
    } finally { unmount(); }
  });

  it('coexists with the /system chip — both visible when both are set', async () => {
    const { root, unmount } = await mountChat(baseState({
      toolManifest: { preset: 'browse-only' },
      customSystemPrompt: 'be terse',
    }));
    try {
      const chips = [...root.querySelectorAll('.chat-mode-row .session-sys-badge')];
      expect(chips.length).toBe(2);
      expect(chips.some((el) => el.textContent === '/system')).toBe(true);
      expect(chips.some((el) => el.textContent === '/tools browse-only')).toBe(true);
    } finally { unmount(); }
  });
});
