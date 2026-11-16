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

// Three people and the meeting point: a named contact on a direct path, a
// person with no name on a relay path, and a person who is heard but not linked.
const ANA = 'did:key:zAnaAAAAhiPpn68X';
const RELAY = 'did:key:zRelayBBBBq7Tm2LdK';
const HEARD = 'did:key:zHeardCCCCw9Xc4NvB';
const PEOPLE_INFO = {
  ...LIVE_INFO, peerCount: 3, linkedCount: 2,
  peers: [
    { did: ANA, linked: true, path: 'direct-ipv4' },
    { did: RELAY, linked: true, path: 'direct-ipv6-relay' },
    { did: HEARD, linked: false },
  ],
};
const ANA_CONTACT = { ok: true, contacts: [{ did: ANA, name: 'Ana', saved: true }] };

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
      if (msg.type === 'contacts/list') return { ok: true, contacts: [] };
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

  it('status failure never masquerades as offline or enables Start', async () => {
    const send = makeSend({
      'dweb/distributed/info': () => ({ ok: false, error: 'raw status transport' }),
    });
    const { root, unmount } = await mountView(send);
    try {
      expect(root.textContent).toContain('could not refresh network status');
      expect(root.textContent.includes('raw status transport')).toBe(false);
      expect(byText(root, '.peerd-net-btn', 'Retry status')).toBeTruthy();
      expect(byText(root, '.peerd-net-btn', 'Start the network')).toBeFalsy();
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
      expect(root.textContent).toContain('could not start the network');
      expect(root.textContent.includes('websocket error')).toBe(false);
      // and the button is usable again (not stuck on "Starting…")
      expect(byText(root, '.peerd-net-btn', 'Starting…')).toBeFalsy();
      expect(byText(root, '.peerd-net-btn', 'Start the network')).toBeTruthy();
    } finally { unmount(); }
  });

  it('an unknown start stays fenced across a stale status read', async () => {
    const send = makeSend({
      'dweb/base/start': () => ({
        ok: false, error: 'raw private host failure', outcomeKnown: false,
        outcomeKind: 'unknown', retryable: false,
      }),
      'dweb/distributed/info': () => ({ running: false }),
    });
    const { root, unmount } = await mountView(send);
    try {
      clickText(root, '.peerd-net-btn', 'Start the network');
      await flush();
      expect(root.textContent).toContain('could not confirm whether the network start finished');
      expect(root.textContent.includes('raw private host failure')).toBe(false);
      expect(send.calls.filter((call) => call.type === 'dweb/base/start').length).toBe(1);
      expect(send.calls.some((call) => call.type === 'dweb/distributed/info')).toBe(true);
      expect(byText(root, '.peerd-net-btn', 'Recheck network status')).toBeTruthy();
      expect(byText(root, '.peerd-net-btn', 'Finish same start')).toBeTruthy();
      expect(byText(root, '.peerd-net-btn', 'Start the network')).toBeFalsy();
    } finally { unmount(); }
  });

  it('unknown start plus failed status permits only another status read', async () => {
    let infoCalls = 0;
    const send = makeSend({
      'dweb/base/start': () => ({ ok: false, outcomeKnown: false, retryable: false }),
      'dweb/distributed/info': () => {
        infoCalls += 1;
        return infoCalls === 1 ? { running: false } : { ok: false, error: 'gone' };
      },
    });
    const { root, unmount } = await mountView(send);
    try {
      clickText(root, '.peerd-net-btn', 'Start the network');
      await flush();
      expect(byText(root, '.peerd-net-btn', 'Recheck network status')).toBeTruthy();
      clickText(root, '.peerd-net-btn', 'Recheck network status');
      await flush();
      expect(send.calls.filter((call) => call.type === 'dweb/base/start').length).toBe(1);
      expect(send.calls.filter((call) => call.type === 'dweb/distributed/info').length).toBe(3);
      expect(byText(root, '.peerd-net-btn', 'Finish same start')).toBeTruthy();
    } finally { unmount(); }
  });

  it('repeats only the same idempotent start after an unknown receipt', async () => {
    let starts = 0;
    let running = false;
    const send = makeSend({
      'dweb/base/start': () => {
        starts += 1;
        if (starts === 1) return { ok: false, outcomeKnown: false, retryable: false };
        running = true;
        return { ok: true };
      },
      'dweb/distributed/info': () => ({ running }),
    });
    const { root, unmount } = await mountView(send);
    try {
      clickText(root, '.peerd-net-btn', 'Start the network');
      await flush();
      clickText(root, '.peerd-net-btn', 'Finish same start');
      await flush();
      expect(starts).toBe(2);
      expect(root.querySelector('.peerd-net-facts')).toBeTruthy();
      expect(byText(root, '.peerd-net-btn', 'Finish same start')).toBeFalsy();
    } finally { unmount(); }
  });

  it('keeps an unknown stop fenced and repeats only that same stop', async () => {
    let stops = 0;
    let running = true;
    const send = makeSend({
      'dweb/base/stop': () => {
        stops += 1;
        if (stops === 1) return { ok: false, outcomeKnown: false, retryable: false };
        running = false;
        return { ok: true };
      },
      'dweb/distributed/info': () => (running ? LIVE_INFO : { running: false }),
    });
    const priorConfirm = globalThis.confirm;
    globalThis.confirm = () => true;
    const { root, unmount } = await mountView(send);
    try {
      clickText(root, '.peerd-net-btn', 'Stop the network');
      await flush();
      expect(byText(root, '.peerd-net-btn', 'Recheck network status')).toBeTruthy();
      expect(byText(root, '.peerd-net-btn', 'Finish same stop')).toBeTruthy();
      expect(byText(root, '.peerd-net-btn', 'Stop the network')).toBeFalsy();
      clickText(root, '.peerd-net-btn', 'Finish same stop');
      await flush();
      expect(stops).toBe(2);
      expect(byText(root, '.peerd-net-btn', 'Start the network')).toBeTruthy();
    } finally {
      globalThis.confirm = priorConfirm;
      unmount();
    }
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

  /** @param {Overrides} [overrides] */
  const people = (overrides = {}) => makeSend({
    'dweb/distributed/info': () => PEOPLE_INFO,
    'contacts/list': () => ANA_CONTACT,
    ...overrides,
  });
  /** @param {ParentNode} root */
  const rowTexts = (root) => [...root.querySelectorAll('.peerd-net-row')].map((row) => row.textContent ?? '');
  /** @param {Element} root */
  const outsideTech = (root) => {
    const copy = /** @type {Element} */ (root.cloneNode(true));
    copy.querySelector('details.peerd-net-tech')?.remove();
    return copy.textContent ?? '';
  };

  it('the Stop button carries no inline style and follows the Find apps link', async () => {
    const { root, unmount } = await mountView(people());
    try {
      const stop = byText(root, '.peerd-net-btn', 'Stop the network');
      const link = byText(root, 'a.peerd-net-link', 'Find apps');
      expect(stop?.hasAttribute('style')).toBe(false);
      expect(link?.getAttribute('href')).toBe('#discover');
      expect(!!(link && stop && (link.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    } finally { unmount(); }
  });

  it('one status line comes first and says how many people are connected', async () => {
    const { root, unmount } = await mountView(people());
    try {
      const status = root.querySelector('.peerd-net [role=status]');
      const list = root.querySelector('ul.peerd-net-list');
      expect(status?.textContent).toBe('Connected to 2 people');
      expect(root.textContent).toContain('You can get apps from the people here, and they can get the apps you share.');
      expect(!!(status && list && (status.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
      expect(root.querySelector('svg')).toBeFalsy();
    } finally { unmount(); }
  });

  it('one connected person is singular', async () => {
    const send = people({ 'dweb/distributed/info': () => ({ ...PEOPLE_INFO, linkedCount: 1 }) });
    const { root, unmount } = await mountView(send);
    try {
      expect(root.querySelector('.peerd-net [role=status]')?.textContent).toBe('Connected to 1 person');
    } finally { unmount(); }
  });

  it('with nobody connected the status line says it looks for people', async () => {
    const { root, unmount } = await mountView(makeSend({ 'dweb/distributed/info': () => LIVE_INFO }));
    try {
      expect(root.querySelector('.peerd-net [role=status]')?.textContent).toBe('Looking for people who share apps…');
      expect(root.textContent.includes('You can get apps from the people here')).toBe(false);
      expect(root.querySelector('.peerd-net-empty')?.textContent)
        .toBe('Nobody else is here right now. People show up here when they come online.');
      expect(root.querySelector('ul.peerd-net-list')).toBeFalsy();
    } finally { unmount(); }
  });

  it('a person who is heard but not connected does not count as connected', async () => {
    const send = people({ 'dweb/distributed/info': () => ({ ...PEOPLE_INFO, peerCount: 1, linkedCount: 0, peers: [PEOPLE_INFO.peers[2]] }) });
    const { root, unmount } = await mountView(send);
    try {
      expect(root.querySelector('.peerd-net [role=status]')?.textContent).toBe('Looking for people who share apps…');
      expect(root.textContent.includes('You can get apps from the people here')).toBe(false);
      expect(rowTexts(root).length).toBe(1);
    } finally { unmount(); }
  });

  it('a person gets the name from Contacts in the row', async () => {
    const { root, unmount } = await mountView(people());
    try {
      await flush();
      const rows = rowTexts(root);
      expect(rows.some((text) => text.includes('Ana'))).toBe(true);
      expect(root.querySelector('.peerd-net-name bdi')?.textContent).toBe('Ana');
      expect(rows.filter((text) => text.includes('No name yet')).length).toBe(2);
      expect(root.textContent).toContain('To add a name for a person, open Contacts.');
      expect(byText(root, 'a.peerd-net-link', 'Contacts')?.getAttribute('href')).toBe('#contacts');
    } finally { unmount(); }
  });

  it('a contact that is not saved gives no name', async () => {
    const send = people({ 'contacts/list': () => ({ ok: true, contacts: [{ did: ANA, name: 'Ana', saved: false }] }) });
    const { root, unmount } = await mountView(send);
    try {
      await flush();
      expect(rowTexts(root).every((text) => text.includes('No name yet'))).toBe(true);
      expect(root.textContent.includes('Ana')).toBe(false);
    } finally { unmount(); }
  });

  it('with each person named and no meeting point, the hint stays away', async () => {
    const send = people({
      'dweb/distributed/info': () => ({ ...PEOPLE_INFO, rendezvous: 'none', peerCount: 1, linkedCount: 1, peers: [PEOPLE_INFO.peers[0]] }),
    });
    const { root, unmount } = await mountView(send);
    try {
      await flush();
      expect(rowTexts(root)[0]).toContain('Ana');
      expect(root.textContent.includes('To add a name for a person')).toBe(false);
      expect(root.querySelector('details.peerd-net-tech')?.textContent.includes('Meeting point')).toBe(false);
    } finally { unmount(); }
  });

  it('Technical details shows each person with the dot of their row, and a person not connected gets a faint dot', async () => {
    const { root, unmount } = await mountView(people());
    try {
      await flush();
      const rowDots = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('.peerd-net-row .peerd-net-swatch')]);
      const factDots = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('details.peerd-net-tech .peerd-net-fact .peerd-net-swatch')]);
      expect(rowDots.length).toBe(3);
      expect(factDots.map((dot) => dot.style.background)).toEqual(rowDots.map((dot) => dot.style.background));
      expect(factDots[1].parentElement?.textContent).toContain('q7Tm2LdK');
      const faint = (/** @type {HTMLElement} */ dot) => dot.classList.contains('peerd-net-swatch--faint');
      expect(rowDots.map(faint)).toEqual([false, false, true]);
      expect(factDots.map(faint)).toEqual([false, false, true]);
    } finally { unmount(); }
  });

  for (const [what, reply] of /** @type {const} */ ([
    ['a locked vault', () => ({ ok: false, error: 'vault-locked' })],
    ['a Contacts read that fails', () => { throw new Error('contacts-gone'); }],
  ])) {
    it(`${what} leaves the people without names and shows no error`, async () => {
      const send = people({ 'contacts/list': reply });
      const { root, unmount } = await mountView(send);
      try {
        await flush();
        expect(send.calls.some((call) => call.type === 'contacts/list')).toBe(true);
        expect(root.querySelector('.peerd-net [role=status]')?.textContent).toBe('Connected to 2 people');
        expect(rowTexts(root).length).toBe(3);
        expect(rowTexts(root).every((text) => text.includes('No name yet'))).toBe(true);
        expect(root.textContent.includes('could not')).toBe(false);
        expect(root.textContent.includes('vault-locked')).toBe(false);
        expect(root.textContent.includes('contacts-gone')).toBe(false);
        expect(byText(root, '.peerd-net-btn', 'Stop the network')).toBeTruthy();
      } finally { unmount(); }
    });
  }

  it('reads Contacts one time while the same people stay', async () => {
    const send = people();
    /** @type {(() => void) | null} */
    let poll = null;
    const priorInterval = globalThis.setInterval;
    globalThis.setInterval = /** @type {typeof setInterval} */ (/** @type {unknown} */ ((/** @type {() => void} */ fn) => { poll = fn; return 0; }));
    const { unmount } = await mountView(send);
    globalThis.setInterval = priorInterval;
    try {
      const again = /** @type {() => void} */ (/** @type {unknown} */ (poll));
      again(); await flush();
      again(); await flush();
      expect(send.calls.filter((call) => call.type === 'dweb/distributed/info').length).toBe(3);
      expect(send.calls.filter((call) => call.type === 'contacts/list').length).toBe(1);
    } finally { unmount(); }
  });

  it('reads Contacts again when the people change', async () => {
    let peers = [PEOPLE_INFO.peers[1]];
    let contacts = /** @type {{did:string,name:string,saved:boolean}[]} */ ([]);
    const send = people({
      'dweb/distributed/info': () => ({ ...PEOPLE_INFO, peers }),
      'contacts/list': () => ({ ok: true, contacts }),
    });
    /** @type {(() => void) | null} */
    let poll = null;
    const priorInterval = globalThis.setInterval;
    globalThis.setInterval = /** @type {typeof setInterval} */ (/** @type {unknown} */ ((/** @type {() => void} */ fn) => { poll = fn; return 0; }));
    const { root, unmount } = await mountView(send);
    globalThis.setInterval = priorInterval;
    try {
      await flush();
      expect(rowTexts(root).some((text) => text.includes('Ana'))).toBe(false);
      peers = [PEOPLE_INFO.peers[1], PEOPLE_INFO.peers[0]];
      contacts = ANA_CONTACT.contacts;
      /** @type {() => void} */ (/** @type {unknown} */ (poll))();
      await flush(); await flush();
      expect(send.calls.filter((call) => call.type === 'contacts/list').length).toBe(2);
      expect(rowTexts(root).some((text) => text.includes('Ana'))).toBe(true);
    } finally { unmount(); }
  });

  it('the meeting point is in Technical details only, not in the list of people', async () => {
    const send = people({ 'dweb/distributed/info': () => ({ ...PEOPLE_INFO, peerCount: 1, linkedCount: 1, peers: [PEOPLE_INFO.peers[0]] }) });
    const { root, unmount } = await mountView(send);
    try {
      await flush();
      expect(root.querySelectorAll('ul.peerd-net-list li').length).toBe(1);
      expect(rowTexts(root).some((text) => text.includes('bootstrap'))).toBe(false);
      expect(outsideTech(root).includes('bootstrap.peerd.ai')).toBe(false);
      expect(root.querySelector('details.peerd-net-tech')?.textContent).toContain('bootstrap.peerd.ai · bootstrap · signaling');
      expect(root.querySelector('details.peerd-net-tech')?.textContent).toContain('Meeting point');
      expect(outsideTech(root).includes('Meeting point')).toBe(false);
    } finally { unmount(); }
  });

  it('each row says its status in plain words, with no key and no path name', async () => {
    const send = people({
      'dweb/distributed/info': () => ({
        ...PEOPLE_INFO,
        peers: [...PEOPLE_INFO.peers, { did: 'did:key:zSoonDDDDk3Rf8HsY', linked: true, path: null }],
      }),
    });
    const { root, unmount } = await mountView(send);
    try {
      const chips = [...root.querySelectorAll('.peerd-net-row .peerd-net-path')].map((chip) => chip.textContent);
      expect(chips.join('|')).toBe('Connected|Connected through a relay|Not connected|Connecting…');
      expect(root.querySelector('.peerd-net-did')).toBeFalsy();
      const rows = rowTexts(root).join(' ');
      for (const hidden of ['hiPpn68X', 'q7Tm2LdK', 'w9Xc4NvB', 'k3Rf8HsY', 'IPv4', 'IPv6', 'TURN']) {
        expect(rows.includes(hidden)).toBe(false);
      }
    } finally { unmount(); }
  });

  it('Technical details is closed and holds the keys, the lobby and the path names', async () => {
    const { root, unmount } = await mountView(people());
    try {
      await flush();
      const tech = root.querySelector('details.peerd-net-tech');
      expect(tech?.hasAttribute('open')).toBe(false);
      expect(tech?.querySelector('summary')?.textContent).toBe('Technical details');
      expect(tech?.querySelector('.peerd-net-facts')).toBeTruthy();
      expect(root.querySelectorAll('.peerd-net-facts').length).toBe(1);
      const text = tech?.textContent ?? '';
      for (const shown of ['Lobby', 'peerd/base/1', '3 seen · 2 connected', 'DHT', 'hiPpn68X · direct · IPv4', 'q7Tm2LdK · relay · TURN', 'w9Xc4NvB · heard · gossip']) {
        expect(text).toContain(shown);
      }
      const open = outsideTech(root);
      for (const hidden of ['Lobby', 'DHT', 'hiPpn68X', 'q7Tm2LdK', 'w9Xc4NvB', 'Abcdefgh']) {
        expect(open.includes(hidden)).toBe(false);
      }
    } finally { unmount(); }
  });

  it('a path through STUN has no IP version in its technical label, and no lobby says Not set', async () => {
    const send = people({
      'dweb/distributed/info': () => ({
        ...PEOPLE_INFO, lobby: null, peers: [{ did: ANA, linked: true, path: 'srflx-ipv6' }],
      }),
    });
    const { root, unmount } = await mountView(send);
    try {
      const text = root.querySelector('details.peerd-net-tech')?.textContent ?? '';
      expect(text).toContain('hiPpn68X · direct · STUN');
      expect(text).toContain('LobbyNot set');
      expect(text.includes('IPv4')).toBe(false);
      expect(rowTexts(root)[0]).toContain('Connected');
    } finally { unmount(); }
  });

  it('Stop says what it does, and a No sends nothing', async () => {
    const send = people();
    /** @type {string[]} */
    const asked = [];
    const priorConfirm = globalThis.confirm;
    globalThis.confirm = (text) => { asked.push(String(text)); return false; };
    const { root, unmount } = await mountView(send);
    try {
      clickText(root, '.peerd-net-btn', 'Stop the network');
      await flush();
      expect(asked.length).toBe(1);
      expect(asked[0]).toBe('Stop the peer network? People cannot get apps from you, and you cannot get apps from them. An app that downloads now may not finish. Network and Contacts leave the menu. The network stays off until you turn it on again in Discover.');
      expect(send.calls.some((call) => call.type === 'dweb/base/stop')).toBe(false);
      expect(byText(root, '.peerd-net-btn', 'Stop the network')).toBeTruthy();
    } finally {
      globalThis.confirm = priorConfirm;
      unmount();
    }
  });
});
