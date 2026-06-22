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
  session: null,
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
  textarea.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: dt, bubbles: true, cancelable: true,
  }));
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
