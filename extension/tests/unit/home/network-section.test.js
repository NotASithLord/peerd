// @ts-check
import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { NetworkSection } from '/home/network-section.js';

// A "live" base-network info snapshot (shape mirrors offscreen/dweb-base.js
// info()). Only what the view reads.
const LIVE_INFO = {
  running: true, did: 'did:key:zSelfAbcdefgh', lobby: 'peerd/base/1',
  peers: [], peerCount: 0, linkedCount: 0, presentCount: 0, dhtSize: 0,
  rendezvous: 'up', bootstrapUrl: 'wss://bootstrap.peerd.ai/rendezvous',
};

/** @typedef {{ type: string } & Record<string, any>} Msg */
/** @typedef {Record<string, (msg: Msg) => any>} Overrides */
/** @typedef {((msg: Msg) => Promise<any>) & { calls: Msg[] }} FakeSend */

// Fake one-shot send(): records calls, answers dweb/distributed/info with a
// not-running snapshot by default, lets a test override any route. Mirrors the
// library-section test's makeSend.
/** @param {Overrides} [overrides] */
const makeSend = (overrides = {}) => {
  /** @type {Msg[]} */
  const calls = [];
  /** @type {FakeSend} */
  const send = Object.assign(
    /** @param {Msg} msg */
    async (msg) => {
      calls.push(msg);
      const override = overrides[msg.type];
      if (override) return override(msg);
      if (msg.type === 'dweb/distributed/info') return { running: false };
      return { ok: true };
    },
    { calls },
  );
  return send;
};

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  m.redraw.sync();
};

/** @param {FakeSend} send */
const mountView = async (send) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(NetworkSection, { send }) });
  await flush();
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

/**
 * @param {ParentNode} root
 * @param {string} sel
 * @param {string} text
 * @returns {HTMLElement | undefined}
 */
const byText = (root, sel, text) =>
  /** @type {HTMLElement[]} */ ([...root.querySelectorAll(sel)]).find((b) => b.textContent === text);

/**
 * @param {ParentNode} root
 * @param {string} sel
 * @param {string} text
 */
const clickText = (root, sel, text) => {
  const el = byText(root, sel, text);
  if (!el) throw new Error(`missing ${sel} with text: ${text}`);
  el.click();
};

describe('home.network', () => {
  it('offline: shows the Start the network button', async () => {
    const { root, unmount } = await mountView(makeSend());
    try {
      expect(byText(root, '.peerd-net-btn', 'Start the network')).toBeTruthy();
    } finally { unmount(); }
  });

  // The regression. The offscreen host answers a failed dweb/base/start with a
  // RESOLVED { ok:false, error } reply (not a rejection); a naive `await send()`
  // swallows it and the button silently snaps back to "Start the network" with
  // no feedback — the reported "Start the network does nothing" bug. The error
  // MUST reach the offline view, and must survive the post-start info refresh
  // (which clears error on a successful info reply).
  it('a failed start surfaces the error inline instead of doing nothing', async () => {
    const send = makeSend({
      'dweb/base/start': () => ({ ok: false, error: 'signaling: websocket error (wss://bootstrap.peerd.ai/rendezvous)' }),
      // info still reports not-running after the failed start (and resolves ok,
      // so refresh would clear `error` unless start re-applies it).
      'dweb/distributed/info': () => ({ running: false }),
    });
    const { root, unmount } = await mountView(send);
    try {
      clickText(root, '.peerd-net-btn', 'Start the network');
      await flush();
      // wiring fired
      expect(send.calls.some((c) => c.type === 'dweb/base/start')).toBe(true);
      // the failure is SURFACED, not swallowed
      expect(root.textContent).toContain('websocket error');
      // and the button is usable again (not stuck on "Starting…")
      expect(byText(root, '.peerd-net-btn', 'Starting…')).toBeFalsy();
      expect(byText(root, '.peerd-net-btn', 'Start the network')).toBeTruthy();
    } finally { unmount(); }
  });

  it('a successful start dispatches dweb/base/start and shows the live view', async () => {
    let started = false;
    const send = makeSend({
      'dweb/base/start': () => { started = true; return { ok: true }; },
      'dweb/distributed/info': () => (started ? LIVE_INFO : { running: false }),
    });
    const { root, unmount } = await mountView(send);
    try {
      clickText(root, '.peerd-net-btn', 'Start the network');
      await flush();
      expect(send.calls.some((c) => c.type === 'dweb/base/start')).toBe(true);
      // left the offline view for the live one (facts row present, no Start btn)
      expect(root.querySelector('.peerd-net-facts')).toBeTruthy();
      expect(root.textContent).toContain('Lobby');
      expect(byText(root, '.peerd-net-btn', 'Start the network')).toBeFalsy();
    } finally { unmount(); }
  });
});
