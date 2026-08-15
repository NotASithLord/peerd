// @ts-check

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { InputBar } from '/sidepanel/components/input-bar.js';

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync?.();
};

/** @param {any} state */
const mountInput = (state) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  /** @type {any[]} */
  const sent = [];
  const send = async (/** @type {any} */ msg) => { sent.push(msg); return { ok: true }; };
  m.mount(root, { view: () => m(InputBar, { state, send, voiceManager: null }) });
  return {
    root,
    sent,
    unmount: () => { m.mount(root, null); root.remove(); },
  };
};

describe('session-aware composer readiness', () => {
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
});
