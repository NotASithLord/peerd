// @ts-check
// File attachments — composer staging + send payload + message chips.
//
// Real InputBar/MessageList mounted against a fake SW send(). Covers:
//   - the attach button is Anthropic-gated (hidden elsewhere — a
//     control that silently fails is a lie)
//   - paste-an-image stages a removable chip (real FileReader → base64)
//   - agent/send carries attachments:[{name, mediaType, size, data}]
//     and the staging clears on a successful send
//   - user messages with stripped attachment records render name+size
//     chips (send-once-then-strip keeps exactly this metadata)

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { InputBar } from '/sidepanel/components/input-bar.js';
import { MessageList } from '/sidepanel/components/message-list.js';

/** @typedef {{ type: string } & Record<string, any>} Msg */
/** @typedef {(msg: Msg) => Promise<any>} Send */

// Query that asserts presence — a null here is a real test failure. The
// optional ctor drives the return type so .value/etc. resolve.
/**
 * @template {HTMLElement} [T=HTMLElement]
 * @param {ParentNode} root
 * @param {string} sel
 * @param {new () => T} [_ctor]
 * @returns {T}
 */
const need = (root, sel, _ctor) => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return /** @type {T} */ (el);
};

/** @param {string} [provider] */
const baseState = (provider = 'anthropic') => ({
  streaming: false,
  session: /** @type {{ sessionId: string } | null} */ (null),
  providers: { hasKey: true, current: provider },
  cost: null,
});

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  m.redraw.sync();
};

// FileReader staging is async — poll until the predicate holds.
/**
 * @param {() => unknown} fn
 * @param {number} [ms]
 */
const until = async (fn, ms = 1500) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('until(): timed out');
    await new Promise((r) => setTimeout(r, 20));
    m.redraw.sync();
  }
};

/**
 * @param {ReturnType<typeof baseState>} state
 * @param {Send} send
 */
const mountInputBar = async (state, send) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(InputBar, { state, send, voiceManager: null }) });
  await flush();
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

/**
 * @param {HTMLElement} textarea
 * @param {string} [bytes]
 * @param {string} [name]
 */
const pasteImage = (textarea, bytes = 'imgbytes', name = 'shot.png') => {
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], name, { type: 'image/png' }));
  // why: Firefox ignores clipboardData passed to the ClipboardEvent
  // constructor. Define the same read-only event field explicitly so this
  // exercises InputBar's paste path in both browser engines.
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: dt });
  textarea.dispatchEvent(event);
};

describe('sidepanel.attachments', () => {
  it('renders the attach button on Anthropic chats only', async () => {
    const send = async () => ({ ok: true });
    const a = await mountInputBar(baseState('anthropic'), send);
    try { expect(a.root.querySelector('.attach-btn')).toBeTruthy(); }
    finally { a.unmount(); }

    const b = await mountInputBar(baseState('ollama'), send);
    try { expect(b.root.querySelector('.attach-btn')).toBeFalsy(); }
    finally { b.unmount(); }
  });

  it('pasting an image stages a removable chip with name + size', async () => {
    const send = async () => ({ ok: true });
    const { root, unmount } = await mountInputBar(baseState(), send);
    try {
      pasteImage(need(root, 'textarea'));
      await until(() => root.querySelector('.attach-chip'));
      const chip = need(root, '.attach-chip');
      expect(need(chip, '.attach-chip-name').textContent).toBe('shot.png');
      expect(need(chip, '.attach-chip-size').textContent).toBe('8 B');
      // the × un-stages it
      need(chip, '.attach-chip-remove').click();
      m.redraw.sync();
      expect(root.querySelector('.attach-chip')).toBeFalsy();
    } finally { unmount(); }
  });

  it('refuses an office file before staging when document conversion is unavailable', async () => {
    const send = async () => ({ ok: true });
    const state = {
      ...baseState(),
      capabilities: { documentReader: { status: 'unsupported' } },
    };
    const { root, unmount } = await mountInputBar(/** @type {any} */ (state), send);
    try {
      const input = need(root, 'input.attach-input', HTMLInputElement);
      expect(input.accept.includes('.docx')).toBe(false);
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [new File(['office-bytes'], 'report.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        })],
      });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await until(() => root.querySelector('.attach-error'));
      expect(root.querySelector('.attach-chip')).toBeFalsy();
      expect(need(root, '.attach-error').textContent).toContain('PDF or plain-text export');
      expect(need(root, '.attach-error').getAttribute('role')).toBe('alert');
      expect(need(root, '.attach-error').getAttribute('aria-live')).toBe('assertive');
    } finally { unmount(); }
  });

  it('send carries the attachment payload shape and clears the staging', async () => {
    /** @type {Msg[]} */
    const sent = [];
    /** @param {Msg} msg */
    const send = async (msg) => { sent.push(msg); return { ok: true }; };
    const { root, unmount } = await mountInputBar(baseState(), send);
    try {
      pasteImage(need(root, 'textarea'));
      await until(() => root.querySelector('.attach-chip'));

      const ta = need(root, 'textarea', HTMLTextAreaElement);
      ta.value = 'what is this?';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      m.redraw.sync();
      need(root, 'form.input-bar')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await until(() => sent.length > 0);
      await flush();

      const msg = sent[0];
      expect(msg.type).toBe('agent/send');
      expect(msg.text).toBe('what is this?');
      expect(msg.attachments.length).toBe(1);
      // exactly the wire-entry shape agent/send validates: name, media
      // type, size, base64 data — and FileReader produced REAL base64.
      expect(msg.attachments[0].name).toBe('shot.png');
      expect(msg.attachments[0].mediaType).toBe('image/png');
      expect(msg.attachments[0].size).toBe(8);
      expect(msg.attachments[0].data).toBe(btoa('imgbytes'));
      // staging cleared on the successful send
      expect(root.querySelector('.attach-chip')).toBeFalsy();
    } finally { unmount(); }
  });

  it('worker loss restores the draft but fences replay behind exact delivery status', async () => {
    /** @type {(reason?: unknown) => void} */
    let rejectSend = () => {};
    let agentCalls = 0;
    /** @type {Msg[]} */
    const sent = [];
    /** @param {Msg} msg */
    const send = (msg) => {
      sent.push(msg);
      if (msg.type !== 'agent/send') return Promise.resolve({ ok: true });
      agentCalls += 1;
      if (agentCalls > 1) return Promise.resolve({ ok: true, duplicate: true });
      return new Promise((_, reject) => { rejectSend = reject; });
    };
    const { root, unmount } = await mountInputBar(baseState(), send);
    try {
      pasteImage(need(root, 'textarea'));
      await until(() => root.querySelector('.attach-chip'));

      const ta = need(root, 'textarea', HTMLTextAreaElement);
      ta.value = 'continue after the worker wakes';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      m.redraw.sync();
      need(root, 'form.input-bar')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await until(() => sent.some((msg) => msg.type === 'agent/send'));

      // The in-flight request owns the composer, but the human text and bytes
      // are retained in component state for a deterministic recovery.
      expect(ta.value).toBe('');
      expect(need(root, '.send-btn', HTMLButtonElement).disabled).toBe(true);
      rejectSend(new Error('service worker context invalidated'));

      await until(() => root.querySelector('.composer-readiness-note'));
      expect(need(root, 'textarea', HTMLTextAreaElement).value)
        .toBe('continue after the worker wakes');
      expect(need(root, '.attach-chip-name').textContent).toBe('shot.png');
      const note = need(root, '.composer-readiness-note');
      expect(note.getAttribute('role')).toBe('alert');
      expect(note.textContent).toContain('could not confirm whether the message started');
      expect(note.textContent).toContain('restored draft');
      expect(note.textContent?.includes('try again')).toBe(false);
      expect(need(root, '.send-btn', HTMLButtonElement).disabled).toBe(true);
      expect(need(root, '.attach-btn', HTMLButtonElement).disabled).toBe(true);
      expect(need(root, '.attach-chip-remove', HTMLButtonElement).disabled).toBe(true);
      const check = /** @type {HTMLButtonElement} */ (
        [...root.querySelectorAll('button')].find((entry) => entry.textContent === 'Check delivery')
      );
      expect(check).toBeTruthy();
      const persistedFence = localStorage.getItem('peerd.unconfirmed-send.new') ?? '';
      expect(persistedFence).toContain('"hadAttachments":true');
      expect(persistedFence.includes('attachments')).toBe(false);
      expect(persistedFence.includes('data')).toBe(false);
      expect(persistedFence.includes('imgbytes')).toBe(false);
      check.click();
      await until(() => sent.filter((msg) => msg.type === 'agent/send').length === 2);
      await until(() => !root.textContent?.includes('Check delivery'));
      const sends = sent.filter((msg) => msg.type === 'agent/send');
      expect(sends[1].operationId).toBe(sends[0].operationId);
      expect(sends[0].attachments?.[0]?.data).toBeTruthy();
      expect(sends[1].checkOnly).toBe(true);
      expect(sends[1].text).toBe(undefined);
      expect(sends[1].attachments).toBe(undefined);
      expect(need(root, 'textarea', HTMLTextAreaElement).value).toBe('');
    } finally { unmount(); }
  });

  it('a settling send cannot clear another chat delivery fence', async () => {
    for (const id of ['new', 'A', 'B']) {
      localStorage.removeItem(`peerd.draft.${id}`);
      localStorage.removeItem(`peerd.unconfirmed-send.${id}`);
    }
    let settleA = (/** @type {any} */ _reply) => {};
    const send = () => new Promise((resolve) => { settleA = resolve; });
    const state = baseState();
    state.session = { sessionId: 'A' };
    const { root, unmount } = await mountInputBar(state, send);
    try {
      const textarea = need(root, 'textarea', HTMLTextAreaElement);
      textarea.value = 'send from A';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      need(root, 'form.input-bar')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await until(() => localStorage.getItem('peerd.unconfirmed-send.A'));

      localStorage.setItem('peerd.unconfirmed-send.B', JSON.stringify({
        operationId: 'send.from-b', text: 'send from B', goal: false,
        sessionId: 'B', hadAttachments: false, source: 'composer',
      }));
      state.session = { sessionId: 'B' };
      m.redraw.sync();
      await flush();
      expect(root.textContent).toContain('Check delivery');

      settleA({ ok: true });
      await until(() => localStorage.getItem('peerd.unconfirmed-send.A') === null);
      await flush();
      expect(localStorage.getItem('peerd.unconfirmed-send.B')).toContain('send.from-b');
      expect(root.textContent).toContain('Check delivery');
      expect(need(root, '.send-btn', HTMLButtonElement).disabled).toBe(true);
    } finally {
      unmount();
      for (const id of ['new', 'A', 'B']) {
        localStorage.removeItem(`peerd.draft.${id}`);
        localStorage.removeItem(`peerd.unconfirmed-send.${id}`);
      }
    }
  });

  it('an unresolved delivery fence can be released only by an explicit bodyless acknowledgement', async () => {
    /** @type {(reason?: unknown) => void} */
    let rejectFirst = () => {};
    /** @type {Msg[]} */
    const sent = [];
    /** @param {Msg} msg */
    const send = (msg) => {
      sent.push(msg);
      if (msg.type !== 'agent/send') return Promise.resolve({ ok: true });
      if (sent.filter((entry) => entry.type === 'agent/send').length === 1) {
        return new Promise((_, reject) => { rejectFirst = reject; });
      }
      if (msg.checkOnly) return Promise.resolve({
        ok: false, outcomeKnown: false, error: 'agent-send-operation-expired',
      });
      return Promise.resolve({ ok: true });
    };
    const { root, unmount } = await mountInputBar(baseState(), send);
    try {
      const ta = need(root, 'textarea', HTMLTextAreaElement);
      ta.value = 'new intent after checking the transcript';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      m.redraw.sync();
      need(root, 'form.input-bar')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await until(() => sent.some((entry) => entry.type === 'agent/send'));
      const first = sent.find((entry) => entry.type === 'agent/send');
      rejectFirst(new Error('worker lost after dispatch'));
      await until(() => root.textContent?.includes('Check delivery'));

      const check = /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((entry) => entry.textContent === 'Check delivery'));
      check.click();
      await until(() => root.textContent?.includes('Delivery is still unconfirmed'));
      const beforeRelease = sent.length;
      const release = /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((entry) => entry.textContent === 'I checked; allow a new message'));
      release.click();
      await flush();
      expect(sent.length).toBe(beforeRelease);
      expect(root.textContent?.includes('Check delivery')).toBe(false);
      expect(need(root, 'textarea', HTMLTextAreaElement).value)
        .toBe('new intent after checking the transcript');
      expect(need(root, '.send-btn', HTMLButtonElement).disabled).toBe(false);

      need(root, 'form.input-bar')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await until(() => sent.filter((entry) => entry.type === 'agent/send').length === 3);
      const fresh = sent.filter((entry) => entry.type === 'agent/send').at(-1);
      if (!fresh) throw new Error('fresh agent/send missing');
      expect(fresh.operationId === first?.operationId).toBe(false);
      expect(fresh.checkOnly === true).toBe(false);
    } finally { unmount(); }
  });

  it('reload recovery says to reattach files whose bytes were not persisted', async () => {
    localStorage.setItem('peerd.unconfirmed-send.new', JSON.stringify({
      operationId: 'send.reloaded', text: 'review this document', goal: false,
      sessionId: null, hadAttachments: true, source: 'composer',
    }));
    const { root, unmount } = await mountInputBar(baseState(), async () => ({ ok: true }));
    try {
      expect(root.querySelector('.attach-chip')).toBeFalsy();
      const release = /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')]
        .find((entry) => entry.textContent === 'I checked; allow a new message'));
      release.click();
      await flush();
      expect(root.textContent).toContain('reattach the files before choosing Send');
      expect(root.textContent?.includes('restored text and files')).toBe(false);
    } finally {
      unmount();
      localStorage.removeItem('peerd.unconfirmed-send.new');
      localStorage.removeItem('peerd.draft.new');
    }
  });

  for (const order of ['rejection-first', 'state-first']) {
    it(`keeps a first-message draft when the new session arrives ${order}`, async () => {
      localStorage.removeItem('peerd.draft.new');
      localStorage.removeItem('peerd.draft.created-session');
      localStorage.removeItem('peerd.unconfirmed-send.new');
      localStorage.removeItem('peerd.unconfirmed-send.created-session');
      let rejectSend = (/** @type {unknown} */ _reason) => {};
      const sent = [];
      const send = (/** @type {Msg} */ msg) => {
        sent.push(msg);
        return new Promise((_, reject) => { rejectSend = reject; });
      };
      const state = baseState();
      const { root, unmount } = await mountInputBar(state, send);
      try {
        const textarea = need(root, 'textarea', HTMLTextAreaElement);
        textarea.value = 'first message survives';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        need(root, 'form.input-bar')
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(() => sent.length === 1);
        if (order === 'state-first') {
          state.session = { sessionId: 'created-session' };
          m.redraw.sync();
          await flush();
        }
        rejectSend(new Error('worker lost'));
        await until(() => root.textContent?.includes('Check delivery'));
        if (order === 'rejection-first') {
          state.session = { sessionId: 'created-session' };
          m.redraw.sync();
          await flush();
        }
        expect(need(root, 'textarea', HTMLTextAreaElement).value)
          .toBe('first message survives');
        expect(localStorage.getItem('peerd.draft.created-session'))
          .toBe('first message survives');
        expect(localStorage.getItem('peerd.unconfirmed-send.created-session'))
          .toContain('first message survives');
      } finally {
        unmount();
        localStorage.removeItem('peerd.draft.new');
        localStorage.removeItem('peerd.draft.created-session');
        localStorage.removeItem('peerd.unconfirmed-send.new');
        localStorage.removeItem('peerd.unconfirmed-send.created-session');
      }
    });
  }

  it('staged attachments do NOT bleed into another chat on switch', async () => {
    for (const id of ['new', 'A', 'B']) {
      localStorage.removeItem(`peerd.draft.${id}`);
      localStorage.removeItem(`peerd.unconfirmed-send.${id}`);
    }
    // Cross-session leak: a file staged in chat A must not ride chat B's send.
    /** @type {Msg[]} */
    const sent = [];
    /** @param {Msg} msg */
    const send = async (msg) => { sent.push(msg); return { ok: true }; };
    const state = baseState();
    state.session = { sessionId: 'A' };
    const { root, unmount } = await mountInputBar(state, send);
    try {
      pasteImage(need(root, 'textarea'));
      await until(() => root.querySelector('.attach-chip'));
      expect(root.querySelector('.attach-chip')).toBeTruthy();

      // Switch to chat B (InputBar is not remounted — same component instance).
      state.session = { sessionId: 'B' };
      m.redraw.sync();
      await flush();
      // The chip — and its bytes — must be gone in chat B.
      expect(root.querySelector('.attach-chip')).toBeFalsy();

      // And B's send carries no attachments inherited from A.
      const ta = need(root, 'textarea', HTMLTextAreaElement);
      ta.value = 'hi from B';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      m.redraw.sync();
      need(root, 'form.input-bar')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await until(() => sent.length > 0);
      expect(sent[0].text).toBe('hi from B');
      expect(sent[0].attachments).toBe(undefined);
    } finally {
      unmount();
      for (const id of ['new', 'A', 'B']) {
        localStorage.removeItem(`peerd.draft.${id}`);
        localStorage.removeItem(`peerd.unconfirmed-send.${id}`);
      }
    }
  });

  it('user messages render attachment chips from stripped records', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const messages = [{
      role: 'user',
      content: 'see attached',
      attachments: [
        { name: 'shot.png', mediaType: 'image/png', kind: 'image', size: 2048, stripped: true },
        { name: 'doc.pdf', mediaType: 'application/pdf', kind: 'pdf', size: 1024 * 1024, stripped: true },
      ],
      id: 'u1', when: 0,
    }];
    m.mount(root, { view: () => m(MessageList, { messages }) });
    try {
      await flush();
      const chips = [...root.querySelectorAll('.message-user .attachment-chip')];
      expect(chips.length).toBe(2);
      expect(chips[0].textContent).toBe('shot.png2.0 KB');
      expect(chips[1].textContent).toBe('doc.pdf1.0 MB');
    } finally { m.mount(root, null); root.remove(); }
  });
});
