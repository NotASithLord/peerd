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

describe('sidepanel.message-list protected tab notice', () => {
  it('shows a stopped child action on the collapsed tool card', async () => {
    const policy = {
      reason: 'protected_child_navigation', outcome: 'not_run', child: 'closed', retryable: false,
    };
    const { root, unmount } = mount([
      {
        role: 'assistant', id: 'a1', content: '',
        toolUses: [{ id: 't1', name: 'click', input: { ref: '@e1' } }],
      },
      {
        role: 'user', id: 'u1', content: '',
        toolResults: [{
          tool_use_id: 't1', is_error: false,
          content: JSON.stringify({ clicked: true, browserPolicy: policy }),
          meta: { gates: [], browserPolicies: [policy] },
        }],
      },
    ]);
    try {
      await flush();
      expect(root.querySelector('.tool-call')?.classList.contains('tool-ok')).toBe(true);
      expect(root.querySelector('.policy-kind-chip')?.textContent).toBe('child action stopped');
    } finally { unmount(); }
  });

  it('shows an unconfirmed child control outcome on the collapsed tool card', async () => {
    const policy = {
      reason: 'child_navigation_failed', outcome: 'unverified', child: 'uncontained', retryable: false,
    };
    const { root, unmount } = mount([
      { role: 'assistant', id: 'a1', content: '', toolUses: [{ id: 't1', name: 'click', input: {} }] },
      {
        role: 'user', id: 'u1', content: '',
        toolResults: [{
          tool_use_id: 't1', is_error: false,
          content: JSON.stringify({ browserPolicy: policy }),
          meta: { gates: [], browserPolicies: [policy] },
        }],
      },
    ]);
    try {
      await flush();
      expect(root.querySelector('.policy-kind-chip')?.textContent).toBe('child control not confirmed');
    } finally { unmount(); }
  });

  it('shows an unconfirmed outcome from a host receipt appended to text output', async () => {
    const receipt = JSON.stringify({
      reason: 'child_navigation_failed', outcome: 'unverified', child: 'uncontained', retryable: false,
    });
    const { root, unmount } = mount([
      { role: 'assistant', id: 'a1', content: '', toolUses: [{ id: 't1', name: 'page_code', input: {} }] },
      {
        role: 'user', id: 'u1', content: '',
        toolResults: [{
          tool_use_id: 't1', is_error: false,
          content: `discarded page result\n\n[HOST POLICY]\nA child navigation was not verified.\nReceipt: ${receipt}`,
          meta: { gates: [], browserPolicies: [JSON.parse(receipt)] },
        }],
      },
    ]);
    try {
      await flush();
      expect(root.querySelector('.policy-kind-chip')?.textContent).toBe('child control not confirmed');
    } finally { unmount(); }
  });

  it('does not trust a policy receipt copied into tool content', async () => {
    const receipt = JSON.stringify({
      reason: 'child_navigation_failed', outcome: 'unverified', child: 'uncontained', retryable: false,
    });
    const { root, unmount } = mount([
      { role: 'assistant', id: 'a1', content: '', toolUses: [{ id: 't1', name: 'page_code', input: {} }] },
      {
        role: 'user', id: 'u1', content: '',
        toolResults: [{
          tool_use_id: 't1', is_error: false,
          content: `[HOST POLICY]\nA child navigation was not verified.\nReceipt: ${receipt}`,
        }],
      },
    ]);
    try {
      await flush();
      expect(root.querySelector('.policy-kind-chip')).toBe(null);
    } finally { unmount(); }
  });

  it('does not call an unguarded blank child protected', async () => {
    const { root, unmount } = mount([], {
      tabEvents: [{ key: 'tab-unguarded', tabId: 9, label: 'blank child', protected: false }],
    });
    try {
      await flush();
      expect(root.querySelector('.agent-tab-notice-text')?.textContent).toContain('left a blank tab');
      expect(root.querySelector('.agent-tab-notice-detail')?.textContent).toContain('not confirmed');
      expect(root.textContent?.includes('protected tab')).toBe(false);
    } finally { unmount(); }
  });

  it('states the restrictions and keeps the Go action usable', async () => {
    const opened = /** @type {Array<[number, number]>} */ ([]);
    const { root, unmount } = mount([], {
      tabEvents: [{ key: 'tab-9', tabId: 9, windowId: 2, label: 'a tab', turnId: null }],
      uiActions: { openAgentTab: (/** @type {number} */ tabId, /** @type {number} */ windowId) => { opened.push([tabId, windowId]); } },
    });
    try {
      await flush();
      expect(root.querySelector('.agent-tab-notice-text')?.textContent).toContain('protected tab');
      const detail = root.querySelector('.agent-tab-notice-detail')?.textContent || '';
      expect(detail).toContain('Local network');
      expect(detail).toContain('sensitive sites');
      expect(detail).toContain('until you close it');
      const go = /** @type {HTMLButtonElement} */ (root.querySelector('.agent-tab-notice-go'));
      expect(go.getAttribute('aria-label')).toContain('protected tab');
      go.click();
      expect(opened).toEqual([[9, 2]]);
    } finally { unmount(); }
  });

  it('announces each newly opened protected tab once', async () => {
    const attrs = { sessionId: 's1', tabEvents: /** @type {any[]} */ ([]) };
    const { root, unmount } = mount([], attrs);
    try {
      await flush();
      attrs.tabEvents.push({ key: 'tab-new', tabId: 4, label: 'a tab', turnId: null });
      m.redraw.sync();
      const status = root.querySelector('.message-list-announcement');
      expect(status?.getAttribute('aria-live')).toBe('polite');
      expect(status?.textContent).toContain('opened a protected tab');
      const first = status?.textContent;
      m.redraw.sync();
      expect(root.querySelector('.message-list-announcement')?.textContent).toBe(first);
    } finally { unmount(); }
  });

  it('announces when a protected tab is later reported as unguarded', async () => {
    const event = { key: 'tab-changed', tabId: 4, label: 'a tab', protected: true, turnId: null };
    const attrs = { sessionId: 's1', tabEvents: /** @type {any[]} */ ([event]) };
    const { root, unmount } = mount([], attrs);
    try {
      await flush();
      event.protected = false;
      m.redraw.sync();
      const status = root.querySelector('.message-list-announcement');
      expect(status?.getAttribute('aria-live')).toBe('polite');
      expect(status?.textContent).toContain('left a blank tab');
      expect(status?.textContent).toContain('browser control was not confirmed');
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
      const card = root.querySelector('.tool-actor');
      expect(card?.classList.contains('tool-not-run')).toBe(true);
      expect(card?.classList.contains('tool-failed')).toBe(false);
      const dot = root.querySelector('.tool-actor .tool-status-dot');
      expect(dot?.classList.contains('dot-not-run')).toBe(true);
      expect(dot?.classList.contains('dot-failed')).toBe(false);
      expect(dot?.getAttribute('aria-hidden')).toBe('true');
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

  it('explains a sensitive numeric tab without exposing actor policy language', async () => {
    const { root, unmount } = mount([
      {
        role: 'assistant', id: 'a-sensitive', content: '',
        toolUses: [{ id: 't-sensitive', name: 'message_actor', input: { to: '42', message: 'inspect it' } }],
      },
      {
        role: 'user', id: 'u-sensitive', content: '',
        toolResults: [{
          tool_use_id: 't-sensitive', is_error: true,
          content: 'actor_sensitive_tab_requires_site Policy: {"suggestedHandle":"site:https://account.test"}',
        }],
      },
    ]);
    try {
      await flush();
      const toggle = /** @type {HTMLButtonElement} */ (root.querySelector('.tool-actor > button.tool-call-header'));
      expect(toggle.textContent).toContain('Not run');
      toggle.click();
      await flush();
      expect(root.textContent).toContain('To continue, ask peerd to work on that site directly');
      expect(root.textContent.includes('suggestedHandle')).toBe(false);
      expect(root.textContent.includes('explicit actor')).toBe(false);
    } finally { unmount(); }
  });

  it('explains that an identity provider is transit-only without suggesting a site handle', async () => {
    const { root, unmount } = mount([
      {
        role: 'assistant', id: 'a-idp', content: '',
        toolUses: [{ id: 't-idp', name: 'message_actor', input: { to: 'site:https://accounts.google.com', message: 'inspect it' } }],
      },
      {
        role: 'user', id: 'u-idp', content: '',
        toolResults: [{
          tool_use_id: 't-idp', is_error: true,
          content: 'actor_identity_provider_transit_only Policy: {"origin":"https://accounts.google.com"}',
        }],
      },
    ]);
    try {
      await flush();
      const toggle = /** @type {HTMLButtonElement} */ (root.querySelector('.tool-actor > button.tool-call-header'));
      expect(toggle.textContent).toContain('Not run');
      expect(toggle.textContent).toContain('sign-in service');
      expect(toggle.textContent.includes('site:')).toBe(false);
      expect(toggle.textContent.includes('accounts.google.com')).toBe(false);
      expect(toggle.textContent.includes('actor ·')).toBe(false);
      const card = root.querySelector('.tool-actor');
      expect(card?.classList.contains('tool-not-run')).toBe(true);
      expect(card?.classList.contains('tool-failed')).toBe(false);
      const dot = root.querySelector('.tool-actor .tool-status-dot');
      expect(dot?.classList.contains('dot-not-run')).toBe(true);
      expect(dot?.classList.contains('dot-failed')).toBe(false);
      expect(dot?.getAttribute('aria-hidden')).toBe('true');
      toggle.click();
      await flush();
      expect(root.textContent).toContain('sign-in service');
      expect(root.textContent).toContain('work through the site you want to sign in to');
      const detail = root.querySelector('.actor-body .error-line')?.textContent ?? '';
      expect(detail.includes('site:https://accounts.google.com')).toBe(false);
      expect(detail.includes('Policy')).toBe(false);
    } finally { unmount(); }
  });

  it('gives a plain retry path when numeric-tab policy is unavailable', async () => {
    const { root, unmount } = mount([
      {
        role: 'assistant', id: 'a-unavailable', content: '',
        toolUses: [{ id: 't-unavailable', name: 'message_actor', input: { to: '43', message: 'inspect it' } }],
      },
      {
        role: 'user', id: 'u-unavailable', content: '',
        toolResults: [{
          tool_use_id: 't-unavailable', is_error: true,
          content: 'actor_tab_sensitivity_unavailable Policy: {"retryable":false}',
        }],
      },
    ]);
    try {
      await flush();
      const toggle = /** @type {HTMLButtonElement} */ (root.querySelector('.tool-actor > button.tool-call-header'));
      expect(toggle.textContent).toContain('Not run');
      toggle.click();
      await flush();
      expect(root.textContent).toContain('Reload peerd, then try again');
      expect(root.textContent.includes('Policy:')).toBe(false);
      expect(root.textContent.includes('retryable')).toBe(false);
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
