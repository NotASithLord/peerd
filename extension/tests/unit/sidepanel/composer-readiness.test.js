// @ts-check

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { InputBar } from '/sidepanel/components/input-bar.js';
import { ConfirmModal } from '/sidepanel/components/app.js';

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync?.();
};

/** @param {any} state @param {any} [options] */
const mountInput = (state, options = {}) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  /** @type {any[]} */
  const sent = [];
  const send = async (/** @type {any} */ msg) => {
    sent.push(msg);
    return options.send ? options.send(msg) : { ok: true };
  };
  m.mount(root, { view: () => [
    options.prompt ? m(ConfirmModal, { prompt: options.prompt }) : null,
    m(InputBar, { state, send, voiceManager: null, goalArmed: options.goalArmed }),
  ] });
  return {
    root,
    sent,
    unmount: () => { m.mount(root, null); root.remove(); },
  };
};

describe('session-aware composer readiness', () => {
  it('focuses the ready composer when it replaces the body focus', () => {
    /** @type {HTMLElement|null} */ (document.activeElement)?.blur();
    expect(document.activeElement).toBe(document.body);
    const mounted = mountInput({
      session: { sessionId: 'composer-focus-body', provider: 'ollama' },
      providers: { current: 'ollama', hasKey: false, model: 'local' },
      composer: { provider: 'ollama', model: 'local', canSend: true, reason: null },
      capabilities: {},
    });
    try {
      const field = mounted.root.querySelector('textarea');
      expect(field instanceof HTMLTextAreaElement).toBe(true);
      expect(document.activeElement).toBe(field);
      expect(field?.getAttribute('role')).toBe(null);
    } finally {
      mounted.unmount();
      localStorage.removeItem('peerd.draft.composer-focus-body');
    }
  });

  it('keeps focus on another control when the composer mounts', () => {
    const other = document.createElement('button');
    other.textContent = 'Other control';
    document.body.append(other);
    other.focus();
    const mounted = mountInput({
      session: { sessionId: 'composer-focus-other', provider: 'ollama' },
      providers: { current: 'ollama', hasKey: false, model: 'local' },
      composer: { provider: 'ollama', model: 'local', canSend: true, reason: null },
      capabilities: {},
    });
    try {
      expect(document.activeElement).toBe(other);
      expect(mounted.root.querySelector('textarea') instanceof HTMLTextAreaElement).toBe(true);
    } finally {
      mounted.unmount();
      other.remove();
      localStorage.removeItem('peerd.draft.composer-focus-other');
    }
  });

  it('keeps a real confirmation control focused when the composer mounts', () => {
    /** @type {HTMLElement|null} */ (document.activeElement)?.blur();
    const mounted = mountInput({
      session: { sessionId: 'composer-focus-modal', provider: 'ollama' },
      providers: { current: 'ollama', hasKey: false, model: 'local' },
      composer: { provider: 'ollama', model: 'local', canSend: true, reason: null },
      capabilities: {},
    }, { prompt: {
      id: 'composer-focus-confirmation', tool: 'click', summary: 'Review this action',
      origins: ['https://example.com'],
    } });
    try {
      const reject = mounted.root.querySelector('[data-confirm-reject]');
      expect(reject instanceof HTMLButtonElement).toBe(true);
      expect(document.activeElement).toBe(reject);
      expect(mounted.root.querySelector('textarea') instanceof HTMLTextAreaElement).toBe(true);
    } finally {
      mounted.unmount();
      localStorage.removeItem('peerd.draft.composer-focus-modal');
    }
  });

  it('keeps the draft field and another control focus through redraws', () => {
    const mounted = mountInput({
      session: { sessionId: 'composer-focus-redraw', provider: 'ollama' },
      providers: { current: 'ollama', hasKey: false, model: 'local' },
      composer: { provider: 'ollama', model: 'local', canSend: true, reason: null },
      capabilities: {},
    });
    const other = document.createElement('button');
    other.textContent = 'Other control';
    document.body.append(other);
    try {
      const field = mounted.root.querySelector('textarea');
      if (!(field instanceof HTMLTextAreaElement)) throw new Error('textarea missing');
      field.value = 'Keep this draft and focus';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      other.focus();
      for (let redraw = 0; redraw < 3; redraw += 1) {
        m.redraw.sync();
        expect(mounted.root.querySelector('textarea')).toBe(field);
        expect(field.value).toBe('Keep this draft and focus');
        expect(document.activeElement).toBe(other);
      }
    } finally {
      mounted.unmount();
      other.remove();
      localStorage.removeItem('peerd.draft.composer-focus-redraw');
    }
  });

  for (const throws of [false, true]) {
    it(`keeps a goal receipt with its originating chat after ${throws ? 'transport failure' : 'an unknown reply'}`, async () => {
      const sessionA = `goal-receipt-a-${throws}`;
      const sessionB = `goal-receipt-b-${throws}`;
      const key = (/** @type {string} */ id) => `peerd.unconfirmed-send.${id}`;
      const pendingB = {
        operationId: `pending-b-${throws}`, sessionId: sessionB,
        text: 'B is still pending', goal: false, hadAttachments: false, source: 'composer',
      };
      localStorage.setItem(key(sessionB), JSON.stringify(pendingB));
      const draftB = 'Keep this separate draft in B';
      localStorage.setItem(`peerd.draft.${sessionB}`, draftB);
      /** @type {(value?:any)=>void} */
      let finish = () => {};
      const reply = new Promise((resolve, reject) => {
        finish = () => throws ? reject(new Error('lost reply'))
          : resolve({ ok: false, outcomeKnown: false });
      });
      const state = {
        session: { sessionId: sessionA, provider: 'ollama' },
        providers: { current: 'ollama', hasKey: false, model: 'local' },
        composer: { provider: 'ollama', model: 'local', canSend: true, reason: null },
        capabilities: {},
      };
      const mounted = mountInput(state, {
        goalArmed: true,
        send: (/** @type {any} */ message) => message.type === 'agent/send' ? reply : { ok: true },
      });
      try {
        await settle();
        const textarea = mounted.root.querySelector('textarea');
        if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('textarea missing');
        textarea.value = 'Goal A';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        m.redraw.sync?.();
        mounted.root.querySelector('form')?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
        await settle();
        expect(mounted.sent.some((message) => message.type === 'agent/send' && message.goal)).toBe(true);
        state.session = { sessionId: sessionB, provider: 'ollama' };
        await settle();
        finish();
        await settle();
        expect(JSON.parse(localStorage.getItem(key(sessionB)) ?? 'null').operationId)
          .toBe(pendingB.operationId);
        expect(JSON.parse(localStorage.getItem(key(sessionA)) ?? 'null').sessionId)
          .toBe(sessionA);
        expect(textarea.value).toBe(draftB);
        expect(localStorage.getItem(`peerd.draft.${sessionB}`)).toBe(draftB);
        state.session = { sessionId: sessionA, provider: 'ollama' };
        await settle();
        expect(textarea.value).toBe('Goal A');
        expect(localStorage.getItem(`peerd.draft.${sessionA}`)).toBe('Goal A');
        expect(mounted.root.textContent).toContain('Check delivery');
      } finally {
        finish();
        mounted.unmount();
        for (const id of [sessionA, sessionB]) {
          localStorage.removeItem(key(id));
          localStorage.removeItem(`peerd.draft.${id}`);
        }
      }
    });
  }

  it('lets an Ollama-bound chat send even when the future-chat default lacks a key', async () => {
    const mounted = mountInput({
      session: { sessionId: 'composer-ready-ollama', provider: 'ollama' },
      providers: { current: 'openai', hasKey: false, model: 'gpt-5' },
      composer: { provider: 'ollama', model: 'qwen3:8b', canSend: true, reason: null },
      capabilities: {},
    });
    try {
      await settle();
      const textarea = mounted.root.querySelector('textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('textarea missing');
      expect(textarea?.disabled).toBe(false);
      expect(textarea?.placeholder).toBe('Message peerd…');
      textarea.value = 'hello locally';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      m.redraw.sync?.();
      mounted.root.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await settle();
      expect(mounted.sent.some((msg) => msg.type === 'agent/send' && msg.text === 'hello locally')).toBe(true);
    } finally {
      mounted.unmount();
      localStorage.removeItem('peerd.draft.composer-ready-ollama');
    }
  });

  it('keeps drafts editable but blocks send with provider-specific recovery copy', async () => {
    const mounted = mountInput({
      session: { sessionId: 'composer-missing-openai', provider: 'openai' },
      providers: { current: 'anthropic', hasKey: true, model: 'claude' },
      composer: { provider: 'openai', model: 'gpt-5', canSend: false, reason: 'missing-key' },
      capabilities: {},
    });
    try {
      await settle();
      const textarea = mounted.root.querySelector('textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('textarea missing');
      expect(textarea?.disabled).toBe(false);
      expect(textarea?.placeholder).toContain('OpenAI');
      textarea.value = 'keep this draft';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      m.redraw.sync?.();
      const note = mounted.root.querySelector('#composer-readiness-note');
      expect(note?.textContent).toContain('OpenAI');
      expect(textarea.getAttribute('aria-describedby')).toBe('composer-readiness-note');
      expect(/** @type {HTMLButtonElement|null} */ (mounted.root.querySelector('button.send-btn'))?.disabled).toBe(true);
      mounted.root.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await settle();
      expect(mounted.sent.some((msg) => msg.type === 'agent/send')).toBe(false);
      expect(textarea.value).toBe('keep this draft');
    } finally {
      mounted.unmount();
      localStorage.removeItem('peerd.draft.composer-missing-openai');
    }
  });

  it('keeps a startup draft editable while blocking send with honest recovery copy', async () => {
    /** @type {HTMLElement|null} */ (document.activeElement)?.blur();
    const mounted = mountInput({
      session: { sessionId: 'composer-controller-startup', provider: 'openai' },
      providers: { current: 'openai', hasKey: true, model: 'gpt-5' },
      composer: {
        provider: 'openai', model: 'gpt-5', canSend: false, reason: 'controller-not-ready',
      },
      capabilities: {},
    });
    try {
      expect(document.activeElement).toBe(mounted.root.querySelector('textarea'));
      await settle();
      const textarea = mounted.root.querySelector('textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('textarea missing');
      expect(textarea.disabled).toBe(false);
      expect(textarea.placeholder).toBe('Starting up. Try again in a moment.');
      textarea.value = 'keep this startup draft';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      m.redraw.sync?.();
      expect(mounted.root.querySelector('#composer-readiness-note')?.textContent)
        .toBe('Starting up. Try again in a moment.');
      const sendButton = /** @type {HTMLButtonElement|null} */ (
        mounted.root.querySelector('button.send-btn')
      );
      expect(sendButton?.disabled).toBe(true);
      mounted.root.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await settle();
      expect(mounted.sent.some((msg) => msg.type === 'agent/send')).toBe(false);
      expect(textarea.value).toBe('keep this startup draft');
    } finally {
      mounted.unmount();
      localStorage.removeItem('peerd.draft.composer-controller-startup');
    }
  });
});
