// @ts-check
// Settings → Learned sites: the un-learn surface for the origins peerd decided
// the user has an account on.
//
// Why these claims and not the rendering: the list is the ONLY way to see or undo
// a guess that silently decides which sites a roaming helper is refused on, so
// what has to hold is (1) nothing destructive happens on a single click — both
// Remove and Forget all arm a confirm first, (2) confirming sends the route the
// SW actually implements, with the origin the row showed, and (3) a failed
// mutation says so instead of appearing to succeed.
//
// Deterministic on purpose: driven by a fake `send` rather than through CDP, so
// the arm→confirm sequence is not racing Mithril's async redraws.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { LearnedOriginsView } from '/sidepanel/components/learned-origins-view.js';

const ORIGINS = [
  { origin: 'https://acme.test', reason: 'password-field' },
  { origin: 'https://globex.test', reason: 'confirmed-write' },
];

/**
 * Mount with a scripted `send`. Returns the root plus the message log so a test
 * can assert exactly which routes were dispatched, in order.
 * @param {(msg: any) => any} [reply]
 */
const mount = (reply = () => ({ ok: true, origins: ORIGINS })) => {
  /** @type {any[]} */
  const sent = [];
  const root = document.createElement('div');
  document.body.appendChild(root);
  const send = (/** @type {any} */ msg) => {
    sent.push(msg);
    return Promise.resolve(reply(msg));
  };
  m.mount(root, { view: () => m(LearnedOriginsView, { send }) });
  return { root, sent, unmount: () => { m.mount(root, null); root.remove(); } };
};

/** Let the mounted component's pending promise + redraw settle. */
const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => m.redraw.sync?.() ?? m.redraw());

/** @param {HTMLElement} root @param {string} label */
const buttons = (root, label) => [...root.querySelectorAll('button')]
  .filter((b) => (b.textContent ?? '').trim() === label);

describe('sidepanel.learned-origins view', () => {
  it('lists every learned origin with a plain-language reason', async () => {
    const { root, sent, unmount } = mount();
    try {
      await settle();
      expect(sent[0].type).toBe('learned/list');
      const text = root.textContent ?? '';
      expect(text.includes('https://acme.test')).toBe(true);
      expect(text.includes('https://globex.test')).toBe(true);
      // The reason is why the site is treated as theirs — the raw enum would
      // leave a user with no way to judge whether the guess was wrong.
      expect(text.includes('a sign-in form was on a page peerd read')).toBe(true);
      expect(text.includes('you approved peerd sending data to it')).toBe(true);
    } finally { unmount(); }
  });

  it('says so plainly when nothing has been learned', async () => {
    const { root, unmount } = mount(() => ({ ok: true, origins: [] }));
    try {
      await settle();
      expect((root.textContent ?? '').includes('Nothing learned yet.')).toBe(true);
      // No Forget-all offer when there is nothing to forget.
      expect(buttons(root, 'Forget all').length).toBe(0);
    } finally { unmount(); }
  });

  it('a single Remove click ARMS a confirm and dispatches nothing', async () => {
    const { root, sent, unmount } = mount();
    try {
      await settle();
      buttons(root, 'Remove')[0].click();
      await settle();
      expect((root.textContent ?? '').includes('Stop treating this as yours?')).toBe(true);
      // Still only the initial list call: nothing was un-learned by arming.
      expect(sent.filter((s) => s.type === 'learned/forget').length).toBe(0);
    } finally { unmount(); }
  });

  it('confirming Remove sends learned/forget for THAT row’s origin', async () => {
    const { root, sent, unmount } = mount();
    try {
      await settle();
      buttons(root, 'Remove')[0].click();       // arm the first row
      await settle();
      buttons(root, 'Remove')[0].click();       // confirm (inside the armed row)
      await settle();
      const forget = sent.find((s) => s.type === 'learned/forget');
      expect(!!forget).toBe(true);
      expect(forget.origin).toBe('https://acme.test');
      // And it re-reads the list rather than trusting a local edit.
      expect(sent.filter((s) => s.type === 'learned/list').length).toBe(2);
    } finally { unmount(); }
  });

  it('Keep cancels the armed row without dispatching', async () => {
    const { root, sent, unmount } = mount();
    try {
      await settle();
      buttons(root, 'Remove')[0].click();
      await settle();
      buttons(root, 'Keep')[0].click();
      await settle();
      expect((root.textContent ?? '').includes('Stop treating this as yours?')).toBe(false);
      expect(sent.filter((s) => s.type === 'learned/forget').length).toBe(0);
    } finally { unmount(); }
  });

  it('Forget all arms its own confirm, then sends learned/clear', async () => {
    const { root, sent, unmount } = mount();
    try {
      await settle();
      buttons(root, 'Forget all')[0].click();   // arm
      await settle();
      expect((root.textContent ?? '').includes('learned sites?')).toBe(true);
      expect(sent.filter((s) => s.type === 'learned/clear').length).toBe(0);
      buttons(root, 'Forget all')[0].click();   // confirm
      await settle();
      expect(sent.filter((s) => s.type === 'learned/clear').length).toBe(1);
    } finally { unmount(); }
  });

  it('a stale row (not-learned) re-reads the list and disarms, instead of promising a reload it never does', async () => {
    // `not-learned` means another tab (or the panel) already removed it. The
    // first draft banner said "reloading" while refreshing only on success, so
    // the phantom row stayed on screen with its confirm still armed under a
    // message saying it was gone.
    /** @type {string[]} */
    const sentTypes = [];
    const { root, unmount } = mount((msg) => {
      sentTypes.push(msg.type);
      return msg.type === 'learned/list'
        ? { ok: true, origins: ORIGINS }
        : { ok: false, error: 'not-learned' };
    });
    try {
      await settle();
      buttons(root, 'Remove')[0].click();
      await settle();
      buttons(root, 'Remove')[0].click();
      await settle();
      const text = root.textContent ?? '';
      expect(text.includes('already removed somewhere else')).toBe(true);
      // It re-read the list (2 list calls: mount + after the stale reply)...
      expect(sentTypes.filter((t) => t === 'learned/list').length).toBe(2);
      // ...and the armed confirm is gone rather than left hanging.
      expect(text.includes('Stop treating this as yours?')).toBe(false);
    } finally { unmount(); }
  });

  it('an ordinary failure keeps the armed confirm and does NOT re-read', async () => {
    // The stale path is the only one that refreshes; a real failure must leave
    // the user where they were, with the action still available to retry.
    /** @type {string[]} */
    const sentTypes = [];
    const { root, unmount } = mount((msg) => {
      sentTypes.push(msg.type);
      return msg.type === 'learned/list'
        ? { ok: true, origins: ORIGINS }
        : { ok: false, error: 'invalid-origin' };
    });
    try {
      await settle();
      buttons(root, 'Remove')[0].click();
      await settle();
      buttons(root, 'Remove')[0].click();
      await settle();
      const text = root.textContent ?? '';
      expect(text.includes('invalid-origin')).toBe(true);
      expect(sentTypes.filter((t) => t === 'learned/list').length).toBe(1);
      expect(text.includes('Stop treating this as yours?')).toBe(true);
    } finally { unmount(); }
  });

  it('Forget all reports HOW MANY it forgot, not just that it ran', async () => {
    const { root, unmount } = mount((msg) => (msg.type === 'learned/clear'
      ? { ok: true, origins: [], forgotten: 2 }
      : { ok: true, origins: ORIGINS }));
    try {
      await settle();
      buttons(root, 'Forget all')[0].click();
      await settle();
      buttons(root, 'Forget all')[0].click();
      await settle();
      expect((root.textContent ?? '').includes('Forgot 2 learned sites.')).toBe(true);
    } finally { unmount(); }
  });

  it('a list failure surfaces rather than rendering a silent empty list', async () => {
    const { root, unmount } = mount(() => ({ ok: false, error: 'boom' }));
    try {
      await settle();
      expect((root.textContent ?? '').includes('boom')).toBe(true);
    } finally { unmount(); }
  });
});
