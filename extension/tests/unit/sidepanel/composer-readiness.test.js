// @ts-check

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { InputBar } from '/sidepanel/components/input-bar.js';
import { ChatView } from '/sidepanel/components/chat-view.js';

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
  m.mount(root, { view: () => m(InputBar, {
    state, send, voiceManager: null, goalArmed: options.goalArmed,
  }) });
  return {
    root,
    sent,
    unmount: () => { m.mount(root, null); root.remove(); },
  };
};

describe('sidepanel own-send scroll', () => {
  it('follows only the submitting surface and keeps a reader in place during streaming', async () => {
    const sessionId = 'own-send-scroll-integrated';
    const storageKeys = [`peerd.draft.${sessionId}`, `peerd.unconfirmed-send.${sessionId}`];
    for (const key of storageKeys) localStorage.removeItem(key);
    const state = /** @type {any} */ ({
      session: {
        sessionId, provider: 'ollama', model: 'qwen3:8b',
        permission: { mode: 'act', confirmActions: false },
        messages: Array.from({ length: 24 }, (_, index) => ({
          role: 'user', id: `history-${index}`, content: `Earlier message ${index + 1}.`,
        })),
      },
      providers: { current: 'ollama', hasKey: false, model: 'qwen3:8b' },
      composer: { provider: 'ollama', model: 'qwen3:8b', canSend: true, reason: null },
      settings: { voiceOnboardingDismissed: true, voiceEnabled: false },
      capabilities: {}, goalRuns: {}, streaming: false,
    });
    /** @type {any[]} */ const sends = [];
    /** @type {((reply: any) => void)[]} */ const finishReplies = [];
    const send = async (/** @type {any} */ message) => {
      if (message.type === 'models/options') return { ok: true, options: [] };
      if (message.type !== 'agent/send') return { ok: true };
      sends.push(message);
      state.session.messages.push(
        { role: 'user', id: `sent-${sends.length}`, content: message.text },
        { role: 'assistant', id: `reply-${sends.length}`, content: '', streaming: true },
      );
      state.streaming = true;
      return new Promise((resolve) => { finishReplies.push(resolve); });
    };
    const root = document.createElement('div');
    root.style.width = '600px';
    document.body.appendChild(root);
    try {
      m.mount(root, { view: () => m('div', ['first', 'second'].map((surface) =>
        m(ChatView, { key: surface, state, send, voiceManager: null, uiActions: {}, surface }))) });
      await settle();
      const surfaces = [...root.querySelectorAll('.chat-view')];
      expect(surfaces.length).toBe(2);
      const lists = surfaces.map((surface) => /** @type {HTMLElement} */ (
        surface.querySelector('.message-list')
      ));
      for (const list of lists) {
        list.style.cssText = 'display:block;height:120px;overflow-y:auto;overflow-anchor:none';
        expect(list.clientHeight).toBeGreaterThan(0);
        expect(list.scrollHeight - list.clientHeight).toBeGreaterThan(300);
        list.scrollTop = 0;
        list.dispatchEvent(new Event('scroll'));
      }
      const [firstList, secondList] = lists;
      const submit = async (/** @type {Element} */ surface, /** @type {string} */ text) => {
        const textarea = surface.querySelector('textarea');
        const form = surface.querySelector('form.input-bar');
        if (!(textarea instanceof HTMLTextAreaElement) || !form) throw new Error('composer missing');
        textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        m.redraw.sync();
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await settle();
      };
      const visibleOwnBubble = (/** @type {HTMLElement} */ list, /** @type {string} */ text) => {
        expect(list.scrollHeight - list.scrollTop - list.clientHeight).toBeLessThan(2);
        const bubble = [...list.querySelectorAll('.message-user .bubble')]
          .find((node) => node.textContent === text);
        if (!bubble) throw new Error('submitted bubble missing');
        const bounds = list.getBoundingClientRect(), message = bubble.getBoundingClientRect();
        expect(message.top >= bounds.top - 1 && message.bottom <= bounds.bottom + 1).toBe(true);
      };

      await submit(surfaces[0], 'Send from the first surface');
      expect(sends.map((message) => message.text)).toEqual(['Send from the first surface']);
      visibleOwnBubble(firstList, 'Send from the first surface');
      expect(secondList.scrollTop).toBe(0);

      firstList.scrollTop = 0;
      firstList.dispatchEvent(new Event('scroll'));
      const firstReply = state.session.messages.at(-1);
      for (const text of ['First streamed sentence. ', 'Second streamed sentence.']) {
        firstReply.content += text;
        await settle();
        expect(state.streaming).toBe(true);
        expect(firstList.scrollTop).toBe(0);
        expect(secondList.scrollTop).toBe(0);
      }
      firstReply.streaming = false;
      firstReply.stopReason = 'end_turn';
      state.streaming = false;
      finishReplies[0]({ ok: true });
      await settle();
      expect(firstList.scrollTop).toBe(0);
      expect(secondList.scrollTop).toBe(0);

      await submit(surfaces[1], 'Send from the second surface');
      expect(sends.map((message) => message.text))
        .toEqual(['Send from the first surface', 'Send from the second surface']);
      visibleOwnBubble(secondList, 'Send from the second surface');
      expect(firstList.scrollTop).toBe(0);
      state.session.messages.at(-1).streaming = false;
      state.streaming = false;
      finishReplies[1]({ ok: true });
      await settle();
      secondList.scrollTop = 0;
      secondList.dispatchEvent(new Event('scroll'));
      state.composer = { ...state.composer, canSend: false, reason: 'controller-not-ready' };
      await settle();
      expect(localStorage.getItem(`peerd.unconfirmed-send.${sessionId}`)).toBe(null);
      expect(/** @type {HTMLButtonElement} */ (surfaces[0].querySelector('button.send-btn')).disabled).toBe(true);
      await submit(surfaces[0], 'Keep the blocked draft');
      expect(sends.length).toBe(2);
      expect(firstList.scrollTop).toBe(0);
      expect(secondList.scrollTop).toBe(0);
      expect(/** @type {HTMLTextAreaElement} */ (surfaces[0].querySelector('textarea')).value)
        .toBe('Keep the blocked draft');
    } finally {
      for (const finish of finishReplies) finish({ ok: true });
      await settle();
      m.mount(root, null);
      root.remove();
      for (const key of storageKeys) localStorage.removeItem(key);
    }
  });
});

describe('session-aware composer readiness', () => {
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
    const mounted = mountInput({
      session: { sessionId: 'composer-controller-startup', provider: 'openai' },
      providers: { current: 'openai', hasKey: true, model: 'gpt-5' },
      composer: {
        provider: 'openai', model: 'gpt-5', canSend: false, reason: 'controller-not-ready',
      },
      capabilities: {},
    });
    try {
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

  it('a confirmed composer send never comes back into the composer', async () => {
    const id = 'sent-text-returns';
    localStorage.removeItem(`peerd.draft.${id}`);
    localStorage.removeItem(`peerd.unconfirmed-send.${id}`);
    /** @type {(value?:any)=>void} */
    let finish = () => {};
    const reply = new Promise((resolve) => { finish = () => resolve({ ok: true }); });
    const mounted = mountInput({
      session: { sessionId: id, provider: 'ollama' },
      providers: { current: 'ollama', hasKey: false, model: 'local' },
      composer: { provider: 'ollama', model: 'local', canSend: true, reason: null },
      capabilities: {},
    }, { send: (/** @type {any} */ message) => message.type === 'agent/send' ? reply : { ok: true } });
    try {
      await settle();
      const textarea = mounted.root.querySelector('textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('textarea missing');
      textarea.value = 'send me once';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      m.redraw.sync?.();
      mounted.root.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await settle();
      expect(textarea.value).toBe('');
      finish();
      await settle();
      await settle();
      expect(textarea.value).toBe('');
      expect(localStorage.getItem(`peerd.draft.${id}`)).toBe(null);
    } finally {
      finish();
      mounted.unmount();
      localStorage.removeItem(`peerd.draft.${id}`);
      localStorage.removeItem(`peerd.unconfirmed-send.${id}`);
    }
  });

  it('a first send whose session id arrives before the reply never comes back', async () => {
    const created = 'created-session';
    const keys = ['new', created].flatMap((id) => [`peerd.draft.${id}`, `peerd.unconfirmed-send.${id}`]);
    for (const key of keys) localStorage.removeItem(key);
    /** @type {(value?:any)=>void} */
    let finish = () => {};
    const reply = new Promise((resolve) => { finish = () => resolve({ ok: true }); });
    const state = {
      session: /** @type {{ sessionId: string, provider: string } | null} */ (null),
      providers: { current: 'ollama', hasKey: false, model: 'local' },
      composer: { provider: 'ollama', model: 'local', canSend: true, reason: null },
      capabilities: {},
    };
    const mounted = mountInput(state, { send: (/** @type {any} */ message) => message.type === 'agent/send' ? reply : { ok: true } });
    try {
      await settle();
      const textarea = mounted.root.querySelector('textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('textarea missing');
      textarea.value = 'first message once';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      m.redraw.sync?.();
      mounted.root.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await settle();
      expect(textarea.value).toBe('');
      state.session = { sessionId: created, provider: 'ollama' };
      await settle();
      expect(textarea.value).toBe('');
      expect(mounted.root.textContent?.includes('Check delivery')).toBe(false);
      finish();
      await settle();
      await settle();
      expect(textarea.value).toBe('');
      expect(localStorage.getItem(`peerd.draft.${created}`)).toBe(null);
      expect(localStorage.getItem(`peerd.unconfirmed-send.${created}`)).toBe(null);
    } finally {
      finish();
      mounted.unmount();
      for (const key of keys) localStorage.removeItem(key);
    }
  });

  /** @param {string} id */
  const otherSurfaceSend = (id) => ({
    operationId: `send.other-surface.${id}`, text: 'sent from another window', goal: false,
    sessionId: id, hadAttachments: false, source: 'composer',
  });
  /** @param {string} id */
  const readyState = (id) => ({
    session: { sessionId: id, provider: 'ollama' },
    providers: { current: 'ollama', hasKey: false, model: 'local' },
    composer: { provider: 'ollama', model: 'local', canSend: true, reason: null },
    capabilities: {},
  });

  // A fresh chat's send is persisted under `new` until its session id lands.
  for (const from of ['this chat', 'a fresh chat']) {
    it(`an unconfirmed send from another surface on ${from} never replaces this composer draft`, async () => {
      const id = `other-surface-draft-${from.replace(/ /g, '-')}`;
      const key = `peerd.unconfirmed-send.${id}`;
      const seedKey = from === 'a fresh chat' ? 'peerd.unconfirmed-send.new' : key;
      localStorage.removeItem(`peerd.draft.${id}`);
      localStorage.removeItem(key);
      localStorage.removeItem(seedKey);
      const pending = { ...otherSurfaceSend(id), sessionId: seedKey === key ? id : null };
      const mounted = mountInput(readyState(id));
      try {
        await settle();
        const textarea = mounted.root.querySelector('textarea');
        if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('textarea missing');
        textarea.value = 'Keep my own draft';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        m.redraw.sync?.();
        localStorage.setItem(seedKey, JSON.stringify(pending));
        await settle();
        expect(textarea.value).toBe('Keep my own draft');
        expect(localStorage.getItem(`peerd.draft.${id}`)).toBe('Keep my own draft');
        expect(mounted.root.textContent).toContain('Check delivery');
        localStorage.removeItem(key);
        await settle();
        expect(textarea.value).toBe('Keep my own draft');
        expect(localStorage.getItem(`peerd.draft.${id}`)).toBe('Keep my own draft');
        expect(mounted.root.textContent?.includes('Check delivery')).toBe(false);
        expect(/** @type {HTMLButtonElement|null} */ (mounted.root.querySelector('button.send-btn'))?.disabled).toBe(false);
      } finally {
        mounted.unmount();
        localStorage.removeItem(`peerd.draft.${id}`);
        localStorage.removeItem(key);
        localStorage.removeItem(seedKey);
      }
    });
  }

  for (const adoptedOn of ['redraw', 'mount', 'fresh-chat redraw']) {
    it(`a copy adopted on ${adoptedOn} clears when the other surface settles its send`, async () => {
      const id = `other-surface-${adoptedOn.replace(/ /g, '-')}`;
      const key = `peerd.unconfirmed-send.${id}`;
      const seedKey = adoptedOn === 'fresh-chat redraw' ? 'peerd.unconfirmed-send.new' : key;
      localStorage.removeItem(`peerd.draft.${id}`);
      localStorage.removeItem(key);
      localStorage.removeItem(seedKey);
      const pending = { ...otherSurfaceSend(id), sessionId: seedKey === key ? id : null };
      if (adoptedOn === 'mount') localStorage.setItem(key, JSON.stringify(pending));
      const mounted = mountInput(readyState(id));
      try {
        await settle();
        if (adoptedOn !== 'mount') {
          localStorage.setItem(seedKey, JSON.stringify(pending));
          await settle();
        }
        const textarea = mounted.root.querySelector('textarea');
        if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('textarea missing');
        expect(textarea.value).toBe(pending.text);
        expect(mounted.root.textContent).toContain('Check delivery');
        localStorage.removeItem(key);
        await settle();
        expect(textarea.value).toBe('');
        expect(localStorage.getItem(`peerd.draft.${id}`)).toBe(null);
        expect(mounted.root.textContent?.includes('Check delivery')).toBe(false);
      } finally {
        mounted.unmount();
        localStorage.removeItem(`peerd.draft.${id}`);
        localStorage.removeItem(key);
        localStorage.removeItem(seedKey);
      }
    });
  }
});
