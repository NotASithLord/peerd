// @ts-check
// The failure-class chip — a failed tool card and a failed turn each carry
// the classified failure NEIGHBORHOOD (policy / provider / …) as a chip, so
// triage doesn't require parsing the raw error string. The chip must appear
// ONLY on failures: a clean card with a chip would cry wolf.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { MessageList } from '/sidepanel/components/message-list.js';

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  m.redraw.sync();
};

/** @param {any[]} messages */
const mount = (messages) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(MessageList, { messages }) });
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

describe('sidepanel.failure-kind chip', () => {
  it('a failed tool card carries the classified kind; an ok card carries none', async () => {
    const { root, unmount } = mount([
      {
        role: 'assistant', id: 'a1', content: '',
        // why generic tool names: message_actor/actor_create take the
        // dedicated actor-card render path, not the generic ToolCall header
        // this chip lives in.
        toolUses: [
          { id: 't-ok', name: 'view', input: {} },
          { id: 't-bad', name: 'script', input: {} },
        ],
      },
      {
        role: 'user', id: 'u1', content: '',
        toolResults: [
          { tool_use_id: 't-ok', content: '42', is_error: false },
          { tool_use_id: 't-bad', content: 'message_actor: oneShot is sandbox-only (webvm/notebook/app)', is_error: true },
        ],
      },
    ]);
    try {
      await flush();
      const cards = [...root.querySelectorAll('.tool-call')];
      expect(cards.length).toBe(2);
      const failed = /** @type {Element} */ (root.querySelector('.tool-call.tool-failed'));
      const chip = /** @type {Element} */ (failed.querySelector('.failure-kind-chip'));
      expect(chip).toBeTruthy();
      expect(chip.textContent).toBe('policy');
      const okCard = cards.find((c) => !c.classList.contains('tool-failed'));
      expect(/** @type {Element} */ (okCard).querySelector('.failure-kind-chip')).toBeFalsy();
    } finally { unmount(); }
  });

  it('a failed TURN (message-level error) carries the classified kind', async () => {
    const { root, unmount } = mount([{
      role: 'assistant', id: 'a2', content: 'partial',
      error: "Provider 'ollama' HTTP 400: {\"error\":\"bad request\"}",
    }]);
    try {
      await flush();
      const chip = /** @type {Element} */ (root.querySelector('.message-assistant .failure-kind-chip'));
      expect(chip).toBeTruthy();
      expect(chip.textContent).toBe('provider');
    } finally { unmount(); }
  });

  it('a clean turn renders no chip', async () => {
    const { root, unmount } = mount([{ role: 'assistant', id: 'a3', content: 'all done' }]);
    try {
      await flush();
      expect(root.querySelector('.failure-kind-chip')).toBeFalsy();
    } finally { unmount(); }
  });
});
