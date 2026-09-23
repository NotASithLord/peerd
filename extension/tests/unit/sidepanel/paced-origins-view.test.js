// @ts-check
// Settings → Paced sites: the only surface that can forget a pacing rule (#234).
//
// Why these claims and not the rendering: forgetting a rule makes peerd act
// FASTER on a site that already asked it to slow down, so this page is the one
// place that direction is reachable at all. What has to hold is (1) nothing
// destructive happens on a single click - both Forget and Forget all arm a
// confirm first, (2) confirming sends the route the SW actually implements with
// the origin the row showed, (3) a failed mutation says so instead of appearing
// to succeed, and (4) an unreadable record explains itself and still offers the
// recovery control, because otherwise a fail-closed turn has no visible cause.
//
// Deterministic on purpose: driven by a fake `send` rather than through CDP, so
// the arm-then-confirm sequence is not racing Mithril's async redraws.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { PacedOriginsView, formatPaceDuration } from '/sidepanel/components/paced-origins-view.js';

const ROWS = [
  {
    origin: 'https://acme.test',
    minIntervalMs: 4_000,
    notBeforeMs: 0,
    notBeforeSource: 'retry-after-seconds',
    observations: 2,
  },
  {
    origin: 'https://globex.test',
    minIntervalMs: 0,
    notBeforeMs: 0,
    notBeforeSource: 'status-backoff',
    observations: 1,
  },
];

/**
 * Mount with a scripted `send`. Returns the root plus the message log so a test
 * can assert exactly which routes were dispatched, in order.
 * @param {(msg: any) => any} [reply]
 */
const mount = (reply = () => ({ ok: true, origins: ROWS, state: { ready: true, ok: true } })) => {
  /** @type {any[]} */
  const sent = [];
  const root = document.createElement('div');
  document.body.appendChild(root);
  const send = (/** @type {any} */ msg) => {
    sent.push(msg);
    return Promise.resolve(reply(msg));
  };
  m.mount(root, { view: () => m(PacedOriginsView, { send }) });
  return { root, sent, unmount: () => { m.mount(root, null); root.remove(); } };
};

/** Let the mounted component's pending promise + redraw settle. */
const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => m.redraw.sync?.() ?? m.redraw());

/** @param {HTMLElement} root @param {string} label */
const buttons = (root, label) => [...root.querySelectorAll('button')]
  .filter((b) => (b.textContent ?? '').trim() === label);

describe('sidepanel.paced-origins view', () => {
  it('lists every paced origin with what the rule costs and why it exists', async () => {
    const { root, sent, unmount } = mount();
    try {
      await settle();
      expect(sent[0].type).toBe('paced/list');
      const text = root.textContent ?? '';
      expect(text.includes('acme.test')).toBe(true);
      expect(text.includes('globex.test')).toBe(true);
      expect(text.includes('waiting 4s between actions')).toBe(true);
      // A rule with no learned interval is still a rule; saying "0s" would read
      // as "does nothing" when a stated pause may still be pending.
      expect(text.includes('waiting only for the pause the site asked for')).toBe(true);
      expect(text.includes('the site stated how long to wait')).toBe(true);
    } finally { unmount(); }
  });

  it('shows a pause that is still running, which is why peerd is refusing right now', async () => {
    const live = [{ ...ROWS[0], notBeforeMs: Date.now() + 40_000 }];
    const { root, unmount } = mount(() => ({ ok: true, origins: live, state: { ready: true, ok: true } }));
    try {
      await settle();
      expect((root.textContent ?? '').includes('paused for another')).toBe(true);
    } finally { unmount(); }
  });

  it('does not claim a pause when none is running', async () => {
    const { root, unmount } = mount();
    try {
      await settle();
      expect((root.textContent ?? '').includes('paused for another')).toBe(false);
    } finally { unmount(); }
  });

  it('says peerd does not work around limits, so the page cannot be read as an evasion switch', async () => {
    const { root, unmount } = mount();
    try {
      await settle();
      const text = root.textContent ?? '';
      expect(text.includes('never tries to disguise itself')).toBe(true);
      expect(text.includes('learn the same rule again')).toBe(true);
    } finally { unmount(); }
  });

  it('says so plainly when no site has asked peerd to slow down', async () => {
    const { root, unmount } = mount(() => ({ ok: true, origins: [], state: { ready: true, ok: true } }));
    try {
      await settle();
      expect((root.textContent ?? '').includes('No site has asked peerd to slow down')).toBe(true);
    } finally { unmount(); }
  });

  it('never forgets a rule on one click - Forget arms a confirm first', async () => {
    const { root, sent, unmount } = mount();
    try {
      await settle();
      buttons(root, 'Forget')[0].click();
      await settle();
      // Still only the initial list: arming must not have sent a mutation.
      expect(sent.filter((msg) => msg.type === 'paced/forget').length).toBe(0);
      expect((root.textContent ?? '').includes('Go back to full speed on this site?')).toBe(true);
    } finally { unmount(); }
  });

  it('sends paced/forget with the exact origin the row showed', async () => {
    const { root, sent, unmount } = mount((msg) => (msg.type === 'paced/forget'
      ? { ok: true, origins: [ROWS[1]], state: { ready: true, ok: true } }
      : { ok: true, origins: ROWS, state: { ready: true, ok: true } }));
    try {
      await settle();
      buttons(root, 'Forget')[0].click();
      await settle();
      buttons(root, 'Forget')[0].click();      // the armed confirm
      await settle();
      const forget = sent.find((msg) => msg.type === 'paced/forget');
      expect(forget).toBeTruthy();
      expect(forget.origin).toBe('https://acme.test');
      expect((root.textContent ?? '').includes('Forgot the rule for https://acme.test')).toBe(true);
    } finally { unmount(); }
  });

  it('keeps the rule when the confirm is declined', async () => {
    const { root, sent, unmount } = mount();
    try {
      await settle();
      buttons(root, 'Forget')[0].click();
      await settle();
      buttons(root, 'Keep')[0].click();
      await settle();
      expect(sent.filter((msg) => msg.type === 'paced/forget').length).toBe(0);
      expect((root.textContent ?? '').includes('Go back to full speed on this site?')).toBe(false);
    } finally { unmount(); }
  });

  it('reports a failed forget instead of appearing to succeed', async () => {
    const { root, unmount } = mount((msg) => (msg.type === 'paced/forget'
      ? { ok: false, error: 'invalid-origin' }
      : { ok: true, origins: ROWS, state: { ready: true, ok: true } }));
    try {
      await settle();
      buttons(root, 'Forget')[0].click();
      await settle();
      buttons(root, 'Forget')[0].click();
      await settle();
      const alert = root.querySelector('p.key-msg.err');
      expect(alert).toBeTruthy();
      expect((alert?.textContent ?? '').includes('invalid-origin')).toBe(true);
    } finally { unmount(); }
  });

  it('re-fetches when a row was already forgotten somewhere else', async () => {
    let listed = ROWS;
    const { root, unmount } = mount((msg) => {
      if (msg.type === 'paced/forget') { listed = [ROWS[1]]; return { ok: false, error: 'not-paced' }; }
      return { ok: true, origins: listed, state: { ready: true, ok: true } };
    });
    try {
      await settle();
      buttons(root, 'Forget')[0].click();
      await settle();
      buttons(root, 'Forget')[0].click();
      await settle();
      const text = root.textContent ?? '';
      expect(text.includes('already back at full speed')).toBe(true);
      expect(text.includes('acme.test')).toBe(false);
    } finally { unmount(); }
  });

  it('Forget all arms its own confirm and reports how many it forgot', async () => {
    const { root, sent, unmount } = mount((msg) => (msg.type === 'paced/clear'
      ? { ok: true, origins: [], forgotten: 2, state: { ready: true, ok: true } }
      : { ok: true, origins: ROWS, state: { ready: true, ok: true } }));
    try {
      await settle();
      buttons(root, 'Forget all')[0].click();
      await settle();
      expect(sent.filter((msg) => msg.type === 'paced/clear').length).toBe(0);
      buttons(root, 'Forget all')[0].click();
      await settle();
      expect(sent.filter((msg) => msg.type === 'paced/clear').length).toBe(1);
      expect((root.textContent ?? '').includes('Forgot 2 pacing rules')).toBe(true);
    } finally { unmount(); }
  });

  it('explains an unreadable record and still offers the recovery control', async () => {
    // An empty list and a broken list look identical, and only one of them is
    // why a browser action just refused.
    const { root, unmount } = mount(() => ({ ok: true, origins: [], state: { ready: true, ok: false } }));
    try {
      await settle();
      const text = root.textContent ?? '';
      expect(text.includes('could not read its pacing record')).toBe(true);
      expect(text.includes('No site has asked peerd to slow down')).toBe(false);
      expect(buttons(root, 'Start a fresh record').length).toBe(1);
    } finally { unmount(); }
  });
});

describe('sidepanel.paced-origins duration copy', () => {
  it('reads in the largest unit that still tells the truth', () => {
    expect(formatPaceDuration(0)).toBe('no delay');
    expect(formatPaceDuration(900)).toBe('1s');
    expect(formatPaceDuration(4_000)).toBe('4s');
    expect(formatPaceDuration(90_000)).toBe('2m');
    expect(formatPaceDuration(3 * 60 * 60_000)).toBe('3h');
  });
});
