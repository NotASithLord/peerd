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

// Trickle-up: an actor's reply-wake (synthetic + actorReply) renders as its
// OWN attributed bubble; plain synthetic plumbing turns stay hidden.
describe('sidepanel.message-list actor-reply bubbles', () => {
  it('renders a synthetic actorReply turn as an attributed bubble, lead line dropped', async () => {
    const { root, unmount } = mount([{
      role: 'user', id: 'u1', synthetic: true,
      actorReply: { kind: 'notebook', instanceId: 'nb-1', name: 'Esoteric Math', failed: false },
      content: 'The notebook actor Esoteric Math (nb-1) you messaged has replied:\n\nran the script, chart rendered',
    }]);
    try {
      await flush();
      const bubbleMsg = /** @type {Element} */ (root.querySelector('.message-actor-reply'));
      expect(bubbleMsg).toBeTruthy();
      const role = (bubbleMsg.querySelector('.role')?.textContent) || '';
      expect(role.includes('notebook actor')).toBe(true);
      expect(role.includes('Esoteric Math')).toBe(true);
      const body = (bubbleMsg.querySelector('.bubble')?.textContent) || '';
      expect(body.includes('ran the script, chart rendered')).toBe(true);
      expect(body.includes('has replied:')).toBe(false);   // lead dropped — the role label says who
    } finally { unmount(); }
  });

  it('a FAILED reply is marked; a plain synthetic turn still renders nothing', async () => {
    const { root, unmount } = mount([
      { role: 'user', id: 'u1', synthetic: true, content: 'RESUME' },           // plumbing → hidden
      {
        role: 'user', id: 'u2', synthetic: true,
        actorReply: { kind: 'webvm', instanceId: 'vm-1', failed: true },
        content: 'The webvm actor vm-1 could not complete your request:\n\nboom',
      },
    ]);
    try {
      await flush();
      const bubbles = root.querySelectorAll('.message');
      expect(bubbles.length).toBe(1);                       // only the actor reply renders
      const msg = /** @type {Element} */ (root.querySelector('.message-actor-reply'));
      expect(msg.classList.contains('failed')).toBe(true);
      expect(((msg.querySelector('.role')?.textContent) || '').includes('failed')).toBe(true);
    } finally { unmount(); }
  });
});
