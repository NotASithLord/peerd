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

/** @param {any[]} messages @param {Record<string, any>} [attrs] */
const mount = (messages, attrs = {}) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(MessageList, { messages, ...attrs }) });
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

  it('the generic disclosure is a focusable native button with expansion state', async () => {
    const { root, unmount } = mount([
      {
        role: 'assistant', id: 'a1', content: '',
        toolUses: [{ id: 't1', name: 'script', input: { code: 'return 42' } }],
      },
      {
        role: 'user', id: 'u1', content: '',
        toolResults: [{ tool_use_id: 't1', is_error: true, content: 'script_failed: transport failed' }],
      },
    ]);
    try {
      await flush();
      const toggle = /** @type {HTMLButtonElement} */ (root.querySelector('button.tool-call-header'));
      expect(toggle).toBeTruthy();
      expect(toggle.type).toBe('button');
      expect(toggle.tabIndex).toBe(0);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      toggle.focus();
      expect(document.activeElement).toBe(toggle);
      toggle.click();
      await flush();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(root.textContent).toContain('script_failed: transport failed');
    } finally { unmount(); }
  });

  it('a stopped script delegation says cancelled, not failed', async () => {
    const { root, unmount } = mount([{
      role: 'assistant', id: 'a1', content: '', stopReason: 'aborted',
      toolUses: [{ id: 't1', name: 'script', input: { code: 'return actors.call()' } }],
    }], {
      scriptOps: {
        t1: [{ seq: 1, method: 'call', to: 'vm-1', phase: 'cancelled', cancelled: true, failed: false, ms: 12 }],
      },
    });
    try {
      await flush();
      const state = root.querySelector('.script-op-state');
      expect(state?.textContent).toBe('cancelled');
      expect(root.querySelector('.script-op-dot.dot-cancelled')).toBeTruthy();
      expect(root.querySelector('.script-op-dot.dot-failed')).toBeFalsy();
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

  it('labels a custody refusal Not run and keeps its recovery copy visible', async () => {
    const { root, unmount } = mount([{
      role: 'user', id: 'u1', synthetic: true,
      actorReply: { kind: 'web', instanceId: 'web', failed: true },
      content: 'The web actor could not complete your request:\n\n'
        + 'actor-provider-boundary-blocked: The actor model request was not run. '
        + 'Do not retry automatically. Ask the user to reload peerd before another actor attempt.',
    }]);
    try {
      await flush();
      const message = /** @type {Element} */ (root.querySelector('.message-actor-reply'));
      expect(message.querySelector('.role')?.textContent).toContain('Not run');
      expect(message.querySelector('.role')?.textContent?.includes(' · failed')).toBe(false);
      expect(message.querySelector('.bubble')?.textContent).toContain('Reload peerd, then try again');
      expect(message.querySelector('.bubble')?.textContent?.includes('Do not retry automatically')).toBe(false);
    } finally { unmount(); }
  });
});

describe('sidepanel.message-list actor disclosures', () => {
  it('keeps model-directed custody recovery text out of a live actor card', async () => {
    const { root, unmount } = mount([{
      role: 'assistant', id: 'a0', content: '',
      toolUses: [{ id: 't0', name: 'message_actor', input: { to: 'web', message: 'inspect it' } }],
    }], {
      actors: {
        t0: {
          kind: 'web', instanceId: 'web', streaming: false,
          error: 'actor-provider-boundary-blocked: The actor model request was not run. '
            + 'Do not retry automatically. Ask the user to reload peerd before another actor attempt.',
        },
      },
    });
    try {
      await flush();
      const toggle = /** @type {HTMLButtonElement} */ (root.querySelector('.tool-actor > button.tool-call-header'));
      expect(toggle.textContent).toContain('Not run');
      toggle.click();
      await flush();
      expect(root.textContent).toContain('Reload peerd, then try again');
      expect(root.textContent.includes('Do not retry automatically')).toBe(false);
      expect(root.textContent.includes('Ask the user')).toBe(false);
    } finally { unmount(); }
  });

  it('renders a boundary refusal as a native Not run disclosure', async () => {
    const { root, unmount } = mount([
      {
        role: 'assistant', id: 'a1', content: '',
        toolUses: [{ id: 't1', name: 'message_actor', input: { to: 'web', message: 'inspect it', await: true } }],
      },
      {
        role: 'user', id: 'u1', content: '',
        toolResults: [{
          tool_use_id: 't1', is_error: true,
          content: 'actor-provider-boundary-blocked: The actor model request was not run.',
        }],
      },
    ]);
    try {
      await flush();
      const toggle = /** @type {HTMLButtonElement} */ (root.querySelector('.tool-actor > button.tool-call-header'));
      expect(toggle).toBeTruthy();
      expect(toggle.type).toBe('button');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.textContent).toContain('Not run');
      toggle.focus();
      expect(document.activeElement).toBe(toggle);
      toggle.click();
      await flush();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(root.textContent).toContain('actor-provider-boundary-blocked');
      expect(root.textContent).toContain('Reload peerd, then try again');
      expect(root.textContent.includes('Do not retry automatically')).toBe(false);
      expect(root.textContent.includes('reply will arrive')).toBe(false);
    } finally { unmount(); }
  });

  it('renders actor_create with native disclosure state and a visible terminal label', async () => {
    const { root, unmount } = mount([
      {
        role: 'assistant', id: 'a2', content: '',
        toolUses: [{ id: 't2', name: 'actor_create', input: { task: 'check it' } }],
      },
      {
        role: 'user', id: 'u2', content: '',
        toolResults: [{ tool_use_id: 't2', is_error: false, content: 'complete' }],
      },
    ]);
    try {
      await flush();
      const toggle = /** @type {HTMLButtonElement} */ (root.querySelector('.tool-actor > button.tool-call-header'));
      expect(toggle).toBeTruthy();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.textContent).toContain('done');
      toggle.click();
      await flush();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
    } finally { unmount(); }
  });

  it('labels a no-card async acknowledgement accepted, not done', async () => {
    const { root, unmount } = mount([
      {
        role: 'assistant', id: 'a3', content: '',
        toolUses: [{ id: 't3', name: 'message_actor', input: { to: 'web', message: 'inspect it' } }],
      },
      {
        role: 'user', id: 'u3', content: '',
        toolResults: [{
          tool_use_id: 't3', is_error: false,
          content: 'Message delivered. Its reply will arrive on a later turn.',
        }],
      },
    ]);
    try {
      await flush();
      const toggle = /** @type {HTMLButtonElement} */ (root.querySelector('.tool-actor > button.tool-call-header'));
      expect(toggle.textContent).toContain('accepted');
      expect(toggle.textContent?.includes('done')).toBe(false);
      toggle.click();
      await flush();
      expect(root.textContent).toContain('request accepted; check later messages for the reply');
    } finally { unmount(); }
  });

  it('labels a completed awaited reply done and shows its result after reload', async () => {
    const { root, unmount } = mount([
      {
        role: 'assistant', id: 'a4', content: '',
        toolUses: [{
          id: 't4', name: 'message_actor',
          input: { to: 'web', message: 'inspect it', await: true },
        }],
      },
      {
        role: 'user', id: 'u4', content: '',
        toolResults: [{
          tool_use_id: 't4', is_error: false,
          content: 'The web actor you messaged has replied:\n\nThe result is 42.',
        }],
      },
    ]);
    try {
      await flush();
      const toggle = /** @type {HTMLButtonElement} */ (root.querySelector('.tool-actor > button.tool-call-header'));
      expect(toggle.textContent).toContain('done');
      expect(toggle.textContent?.includes('accepted')).toBe(false);
      toggle.click();
      await flush();
      expect(root.textContent).toContain('The result is 42');
      expect(root.textContent.includes('check later messages')).toBe(false);
    } finally { unmount(); }
  });

  it('labels an await-cap handoff separately from a completed reply', async () => {
    const { root, unmount } = mount([
      {
        role: 'assistant', id: 'a5', content: '',
        toolUses: [{
          id: 't5', name: 'message_actor',
          input: { to: 'web', message: 'inspect it', await: true },
        }],
      },
      {
        role: 'user', id: 'u5', content: '',
        toolResults: [{
          tool_use_id: 't5', is_error: false,
          content: 'The web actor is still working; its reply will arrive as a fenced note on a later turn.',
        }],
      },
    ]);
    try {
      await flush();
      const toggle = /** @type {HTMLButtonElement} */ (root.querySelector('.tool-actor > button.tool-call-header'));
      expect(toggle.textContent).toContain('handed off');
      expect(toggle.textContent?.includes('done')).toBe(false);
      toggle.click();
      await flush();
      expect(root.textContent).toContain('the actor is still working; check later messages for the reply');
    } finally { unmount(); }
  });
});
