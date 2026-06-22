// @ts-check
// MessageList — aborted-turn tool cards must show a terminal "cancelled"
// state, not a perpetual "running…". An aborted turn (Stop / spend-limit /
// steer) persists its toolUses with no tool_result; without threading the
// parent message's stopReason the card derives status='pending' forever (and
// across a reload).

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

describe('sidepanel.message-list aborted cards', () => {
  it('an aborted turn shows "cancelled" tool cards, not a perpetual "running…"', async () => {
    const { root, unmount } = mount([{
      role: 'assistant', id: 'a1', content: '', stopReason: 'aborted',
      toolUses: [{ id: 't1', name: 'click', input: {} }],
    }]);
    try {
      await flush();
      const card = /** @type {Element} */ (root.querySelector('.tool-call'));
      expect(card).toBeTruthy();
      // terminal cancelled state — no live "running…" label, no pulsing dot
      expect(card.classList.contains('tool-cancelled')).toBe(true);
      expect(card.querySelector('.dot-cancelled')).toBeTruthy();
      expect(card.querySelector('.tool-pending')).toBeFalsy();
      // the turn itself shows a "stopped" chip
      const chip = /** @type {Element} */ (root.querySelector('.stop-chip'));
      expect(chip).toBeTruthy();
      expect((chip.textContent || '').includes('stopped')).toBe(true);
    } finally { unmount(); }
  });

  it('a live turn (no abort) keeps the "running…" pending state', async () => {
    const { root, unmount } = mount([{
      role: 'assistant', id: 'a1', content: '', // no stopReason → turn in flight
      toolUses: [{ id: 't1', name: 'click', input: {} }],
    }]);
    try {
      await flush();
      const card = /** @type {Element} */ (root.querySelector('.tool-call'));
      expect(card.classList.contains('tool-pending')).toBe(true);
      expect(card.classList.contains('tool-cancelled')).toBe(false);
      expect(card.querySelector('.tool-pending')).toBeTruthy();
    } finally { unmount(); }
  });
});
