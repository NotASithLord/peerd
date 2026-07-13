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

  // The agent-web merge: actor rows (actors/graph) render INSIDE the boundary
  // in module colors; peers render MAGENTA (the wire's color — owner direction
  // 2026-07-10), never a random brand hue; a dwapp actor wears the badge ring.
  it('renders actors inside the dweb boundary and magenta peers beyond it', async () => {
    const send = makeSend({
      'dweb/distributed/info': () => ({
        ...LIVE_INFO,
        peers: [{ did: 'did:key:zPeerOne', name: 'ana', linked: true, path: 'direct-ipv6' }],
        peerCount: 1, linkedCount: 1,
      }),
      'actors/graph': () => ({
        ok: true,
        actors: [
          { type: 'notebook', handle: 'nb-1', name: 'scratch', live: true, isActor: false },
          { type: 'app', handle: 'app-1', name: 'Puzzle Race', live: false, isActor: true },
        ],
      }),
    });
    const { root, unmount } = await mountView(send);
    try {
      // the boundary + both rings' furniture
      expect(root.querySelector('.pn-boundary')).toBeTruthy();
      expect(root.querySelector('.pn-orbit')).toBeTruthy();
      // two actor nodes, module-colored (notebook green, app amber), one badge
      const actorDots = [...root.querySelectorAll('.pn-actor .pn-dot')];
      expect(actorDots.length).toBe(2);
      const fills = actorDots.map((d) => d.getAttribute('fill'));
      expect(fills).toContain('#22C55E');
      expect(fills).toContain('#F59E0B');
      expect(root.querySelectorAll('.pn-actor-badge').length).toBe(1);
      // the peer dot is magenta — not a random brand color
      const peerDot = [...root.querySelectorAll('.pn:not(.pn-actor) .pn-dot')]
        .find((d) => d.getAttribute('fill') === '#D946EF');
      expect(peerDot).toBeTruthy();
      // facts row counts the actors
      expect(root.textContent).toContain('Actors');
    } finally { unmount(); }
  });

  // The actor half fails SOFT: a locked vault (ok:false) must still render the
  // peers-only live view, never blank the section.
  it('vault-locked actors/graph degrades to a peers-only graph', async () => {
    const send = makeSend({
      'dweb/distributed/info': () => LIVE_INFO,
      'actors/graph': () => ({ ok: false, error: 'vault-locked' }),
    });
    const { root, unmount } = await mountView(send);
    try {
      expect(root.querySelector('.peerd-net-facts')).toBeTruthy();
      expect(root.querySelector('.pn-boundary')).toBeTruthy();
      expect(root.querySelectorAll('.pn-actor').length).toBe(0);
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
