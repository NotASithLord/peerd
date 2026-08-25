// @ts-check
// The pacing bar (#234): the chat view's explanation for a turn that is
// deliberately doing nothing.
//
// Why these claims: an unexplained pause reads as a hang, and the reasonable
// response to a hang is to send again - which cancels the turn and starts over.
// So what has to hold is (1) the bar is invisible unless a wait is live,
// (2) it names the site and says a wait is what is happening, (3) the way out is
// in the same sentence as the explanation rather than at the far end of the
// panel, and (4) it is announced to assistive technology, not only drawn.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { PacingBar } from '/sidepanel/components/pacing-bar.js';

/** @param {any} pacing */
const mount = (pacing) => {
  /** @type {any[]} */
  const sent = [];
  const root = document.createElement('div');
  document.body.appendChild(root);
  const send = (/** @type {any} */ msg) => { sent.push(msg); return Promise.resolve({ ok: true }); };
  m.mount(root, { view: () => m(PacingBar, { pacing, send }) });
  return { root, sent, unmount: () => { m.mount(root, null); root.remove(); } };
};

describe('sidepanel.pacing-bar', () => {
  it('renders nothing when no wait is live', () => {
    const { root, unmount } = mount(null);
    try {
      expect(root.querySelector('.pacing-bar')).toBe(null);
    } finally { unmount(); }
  });

  it('names the site and the remaining wait', () => {
    const { root, unmount } = mount({
      origin: 'https://acme.test', untilMs: Date.now() + 5_000, reason: 'server-deadline',
    });
    try {
      const text = root.textContent ?? '';
      expect(text.includes('Waiting')).toBe(true);
      expect(text.includes('acme.test')).toBe(true);
      expect(text.includes('the site asked peerd to wait')).toBe(true);
      // The countdown lives in its own element: adjacent spans render with no
      // separator, so asserting on the whole string cannot tell "5s" from
      // "Waiting5s".
      const meta = root.querySelector('.goal-bar-meta');
      expect(/^[1-5]s$/.test((meta?.textContent ?? '').trim())).toBe(true);
    } finally { unmount(); }
  });

  it('distinguishes peerd keeping under a learned limit from a stated pause', () => {
    const { root, unmount } = mount({
      origin: 'https://acme.test', untilMs: Date.now() + 2_000, reason: 'learned-interval',
    });
    try {
      expect((root.textContent ?? '').includes('keeping under this site')).toBe(true);
    } finally { unmount(); }
  });

  it('shows only the host, never a path a page could choose', () => {
    const { root, unmount } = mount({
      origin: 'https://acme.test', untilMs: Date.now() + 2_000, reason: 'server-deadline',
    });
    try {
      const text = root.textContent ?? '';
      expect(text.includes('https://')).toBe(false);
    } finally { unmount(); }
  });

  it('says "resuming" once the deadline has passed rather than counting into the negative', () => {
    const { root, unmount } = mount({
      origin: 'https://acme.test', untilMs: Date.now() - 1_000, reason: 'server-deadline',
    });
    try {
      expect((root.textContent ?? '').includes('resuming')).toBe(true);
    } finally { unmount(); }
  });

  it('offers the way out next to the explanation, posting the same agent/stop', () => {
    const { root, sent, unmount } = mount({
      origin: 'https://acme.test', untilMs: Date.now() + 5_000, reason: 'server-deadline',
    });
    try {
      const stop = [...root.querySelectorAll('button')]
        .find((b) => (b.textContent ?? '').trim() === 'Stop');
      expect(stop).toBeTruthy();
      /** @type {HTMLButtonElement} */ (stop).click();
      expect(sent.length).toBe(1);
      expect(sent[0].type).toBe('agent/stop');
    } finally { unmount(); }
  });

  it('is announced politely to assistive technology', () => {
    const { root, unmount } = mount({
      origin: 'https://acme.test', untilMs: Date.now() + 5_000, reason: 'server-deadline',
    });
    try {
      const bar = root.querySelector('.pacing-bar');
      expect(bar?.getAttribute('role')).toBe('status');
      expect(bar?.getAttribute('aria-live')).toBe('polite');
    } finally { unmount(); }
  });

  it('leaves no timer behind when the wait ends', async () => {
    const { root, unmount } = mount({
      origin: 'https://acme.test', untilMs: Date.now() + 5_000, reason: 'server-deadline',
    });
    // Unmounting is the real end of a wait: the reducer clears `pacing` on the
    // next lifecycle message and the component is removed. A leaked interval
    // would keep redrawing a settled chat forever.
    unmount();
    await new Promise((r) => setTimeout(r, 1_100));
    expect(root.querySelector('.pacing-bar')).toBe(null);
  });
});
