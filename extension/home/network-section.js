// @ts-check
// home/network-section.js — the peers + network-info view (dweb, preview-only).
//
// A live window onto the always-on base network: one status line, the list of
// people on the network, and the lobby/DHT facts in Technical details.
// Honest about a browser mesh: people are dids/names, NOT IPs (WebRTC hides
// peer IPs), and each one shows its TRUE ICE path (direct IPv6 / IPv4-STUN /
// relay).
//
// Data arrives over ONE SW round-trip (dweb/distributed/info → the offscreen
// base host's info()); this page is a pure CLIENT — it never imports the dweb
// module (the boundary forbids it), so the brand palette + colorOf are inlined.
// Mounted only when DWEB_ENABLED (home.js): on the store build DWEB_ENABLED is
// false, so this never mounts — it ships INERT (the dweb MODULE is pruned, but
// this chassis file isn't), names no dweb path, so the store verifier stays
// clean. Same ship-gated-and-inert pattern as home.js's own seedDwebApps code.

import m from '/vendor/mithril/mithril.js';

/** @typedef {import('../options/sections/reset-row.js').Send} Send */
/**
 * @typedef {object} Peer
 * @property {string} did
 * @property {string} [name]
 * @property {boolean | string} [linked]
 * @property {string} [path]
 * @property {string} [kind]
 * @property {number} [lastSeen]
 * @property {string} [host]
 */

// --- brand color per peer (random per did, cached for the session) -----------
// Mirrors the commons participant rail (owner direction 2026-06-12: every dweb
// peer gets a peerd brand color, chosen at random client-side — the sanctioned
// exception to "one accent on monochrome", because the peers ARE the content).
// Cached in a module Map so a peer keeps its color across the 3s refresh.
// p·cyan e·red e·amber r·green d·magenta.
const BRAND = ['#00B7EB', '#EF4444', '#F59E0B', '#22C55E', '#D946EF'];
/** @type {Map<string, string>} */
const colorByDid = new Map();
/** @param {string} did */
const colorOf = (did) => {
  if (!colorByDid.has(did)) {
    // ponytail: hard cap, just clear — the colors are cosmetic random, so
    // re-rolling on the rare overflow is invisible, and the Map can't grow
    // unbounded across a long session with peer churn.
    if (colorByDid.size >= 512) colorByDid.clear();
    colorByDid.set(did, BRAND[Math.floor(Math.random() * BRAND.length)]);
  }
  // why the cast: the key was just ensured present above, so this is
  // always a string — Map.get's `| undefined` is unreachable here.
  return /** @type {string} */ (colorByDid.get(did));
};

// did short form — the codebase-canonical last 8 chars (rooms.js short()).
/** @param {string} did */
const short = (did) => (typeof did === 'string' ? did.slice(-8) : '????????');
const NO_NAME = 'No name yet';
/** @param {Peer} p */
const labelOf = (p) => (p.name && p.name.trim() ? p.name.trim() : NO_NAME);
// why a copy: peerCountLabel lives in the Discover model, and an import of it
// would push the Home static graph over its ceiling (cold-entry-graphs test).
/** @param {number} n */
const connectedLabel = (n) => `Connected to ${n} ${n === 1 ? 'person' : 'people'}`;

// The honest connectivity label + a kind (for color). Never fabricates a path:
// link-less peers are "heard via gossip"; a linked peer whose ICE stats haven't
// settled is "connecting…", not a fake address. The bootstrap node is a peer
// like any other, tagged honestly: it does introductions (signaling), not data.
/** @param {Peer} p */
const pathInfo = (p) => {
  if (p.kind === 'bootstrap') return p.linked
    ? { label: 'bootstrap · signaling', kind: 'bootstrap', plain: 'Connected' }
    : { label: 'bootstrap · connecting…', kind: 'connecting', plain: 'Connecting…' };
  if (!p.linked) return { label: 'heard · gossip', kind: 'gossip', plain: 'Not connected' };
  const path = p.path;
  if (!path || path === 'unknown') return { label: 'connecting…', kind: 'connecting', plain: 'Connecting…' };
  const plain = path.includes('relay') ? 'Connected through a relay' : 'Connected';
  if (path === 'direct-ipv6') return { label: 'direct · IPv6', kind: 'direct', plain };
  if (path === 'direct-ipv4') return { label: 'direct · IPv4', kind: 'direct', plain };
  if (path.includes('srflx')) return { label: 'direct · STUN', kind: 'stun', plain };
  if (path.includes('relay')) return { label: 'relay · TURN', kind: 'relay', plain };
  return { label: path, kind: 'stun', plain };
};

// The bootstrap (rendezvous) node is a server, not a person. The list of
// people leaves it out. It shows as "Meeting point" in Technical details only.
// It has no did, so we synthesize one. linked === 'up'.
const BOOTSTRAP_DID = '__bootstrap__';
/** @param {string} url */
const domainOf = (url) => { try { return new URL(url).hostname; } catch { return 'bootstrap'; } };
/** @param {any} info */
const bootstrapPeer = (info) => (info.bootstrapUrl && info.rendezvous !== 'none'
  ? { did: BOOTSTRAP_DID, host: domainOf(info.bootstrapUrl), linked: info.rendezvous === 'up', kind: 'bootstrap' }
  : null);

// why the same dot as the row: two people with no name differ only by it,
// and a person who is not connected gets a faint one.
/** @param {Peer} p */
const swatch = (p) => m('span.peerd-net-swatch', {
  class: ['gossip', 'connecting'].includes(pathInfo(p).kind) ? 'peerd-net-swatch--faint' : undefined,
  style: `background:${colorOf(p.did)}`,
});

/**
 * @param {string} k
 * @param {string} v
 * @param {Peer} [person] the person of this fact, for the dot of their row
 */
const fact = (k, v, person) => m('.peerd-net-fact', [
  person ? swatch(person) : null,
  m('span.peerd-net-fact-k', k),
  m('span.peerd-net-fact-v', v),
]);

/** @param {unknown} result @param {'start'|'stop'} action */
const lifecycleFailure = (result, action) =>
  /** @type {{outcomeKnown?:boolean}} */ (result)?.outcomeKnown === false
    ? `Peerd could not confirm whether the network ${action} finished. Its current status was re-read; check it before trying again.`
    : `Peerd could not ${action} the network. Check your connection and try again.`;

/**
 * The Network section, mounted on the home page (DWEB_ENABLED only).
 * @returns {object} a Mithril component; attrs: { send }
 */
export const NetworkSection = () => {
  /** @type {any} */
  let info = null;       // last dweb/distributed/info reply
  let loading = true;
  /** @type {string | null} */
  let error = null;
  let starting = false;
  let stopping = false;
  /** @type {'start'|'stop'|null} */
  let transitionUnknown = null;
  /** @type {Promise<boolean> | null} */
  let refreshInFlight = null;
  let refreshEpoch = 0;
  let appliedEpoch = 0;
  /** @type {ReturnType<typeof setInterval> | number} */
  let timer = 0;
  let dead = false;      // set on unmount — an in-flight poll must not redraw
  /** @type {Map<string, string>} */
  let names = new Map(); // did -> saved contact name
  /** @type {string | null} */
  let namesFor = null;   // the sorted peer dids of the last contacts read

  // Names are optional: a locked vault or a failed read leaves the page as it is.
  /** @param {Send} send */
  const readNames = async (send) => {
    try {
      const r = await send({ type: 'contacts/list' });
      if (r?.ok !== true || !Array.isArray(r.contacts)) return;
      /** @type {Map<string, string>} */
      const next = new Map();
      for (const row of r.contacts) {
        const name = typeof row?.name === 'string' ? row.name.trim() : '';
        if (row?.saved === true && typeof row.did === 'string' && name) next.set(row.did, name);
      }
      names = next;
      if (!dead) m.redraw();
    } catch (cause) {
      void cause;
    }
  };

  /** @param {Send} send */
  const refresh = (send) => {
    if (refreshInFlight) return refreshInFlight;
    const epoch = ++refreshEpoch;
    refreshInFlight = (async () => {
      try {
        const r = await send({ type: 'dweb/distributed/info' });
        if (r?.ok === false || typeof r?.running !== 'boolean') {
          throw new Error('network-status-unavailable');
        }
        if (epoch >= appliedEpoch) {
          appliedEpoch = epoch;
          info = r;
          error = null;
          if (r.running) {
            const dids = (Array.isArray(r.peers) ? r.peers : []).map((/** @type {Peer} */ p) => p.did).sort().join(' ');
            if (dids !== namesFor) { namesFor = dids; void readNames(send); }
          }
          const expected = transitionUnknown === 'start' ? true
            : transitionUnknown === 'stop' ? false : null;
          if (expected === null || r.running === expected) transitionUnknown = null;
        }
        return true;
      } catch (cause) {
        if (epoch >= appliedEpoch) {
          error = 'Peerd could not refresh network status. Retry the status check.';
        }
        void cause;
        return false;
      } finally {
        loading = false;
        refreshInFlight = null;
        if (!dead) m.redraw();
      }
    })();
    return refreshInFlight;
  };

  /** @param {Send} send */
  const start = async (send) => {
    starting = true; error = null; if (!dead) m.redraw();
    // Surface a FAILED start. The offscreen host answers a thrown handler with
    // a RESOLVED { ok:false, error } reply (not a rejection), so `await send()`
    // alone swallows it and the button silently snaps back to "Start the
    // network" — the "does nothing" bug. Capture both the ok:false reply and a
    // real throw, and re-apply it AFTER refresh (which pulls fresh info and
    // would otherwise clear error to null).
    /** @type {string | null} */
    let startErr = null;
    try {
      const r = await send({ type: 'dweb/base/start' });
      if (r && r.ok === false) {
        transitionUnknown = r.outcomeKnown === false ? 'start' : null;
        startErr = lifecycleFailure(r, 'start');
      }
    } catch (cause) {
      transitionUnknown = 'start';
      startErr = lifecycleFailure({ outcomeKnown: false }, 'start');
      void cause;
    }
    starting = false;
    await refresh(send);
    if (startErr) { error = startErr; if (!dead) m.redraw(); }
  };

  /** The kill switch: shut down ALL dweb networking + persist it off. @param {Send} send */
  const stop = async (send) => {
    // Destructive — drops every live connection — so confirm before the kill.
    if (typeof confirm === 'function'
      && !confirm('Stop the peer network? People cannot get apps from you, and you cannot get apps from them. An app that downloads now may not finish. Network and Contacts leave the menu. The network stays off until you turn it on again in Discover.')) return;
    stopping = true; error = null; if (!dead) m.redraw();
    /** @type {string | null} */
    let stopErr = null;
    try {
      const r = await send({ type: 'dweb/base/stop' });
      if (r && r.ok === false) {
        transitionUnknown = r.outcomeKnown === false ? 'stop' : null;
        stopErr = lifecycleFailure(r, 'stop');
      }
    } catch (cause) {
      transitionUnknown = 'stop';
      stopErr = lifecycleFailure({ outcomeKnown: false }, 'stop');
      void cause;
    }
    stopping = false;
    await refresh(send);
    if (stopErr) { error = stopErr; if (!dead) m.redraw(); }
  };

  return {
    /** @param {{ attrs: { send: Send } }} vnode */
    oninit(vnode) { refresh(vnode.attrs.send); },
    /** @param {{ attrs: { send: Send } }} vnode */
    oncreate(vnode) {
      // Poll while the tab is visible (the offscreen host keeps running when
      // hidden; we just stop asking). 3s feels live without hammering the SW.
      timer = setInterval(() => { if (!document.hidden) refresh(vnode.attrs.send); }, 3000);
    },
    onremove() { dead = true; if (timer) clearInterval(timer); },
    /** @param {{ attrs: { send: Send } }} vnode */
    view(vnode) {
      const send = vnode.attrs.send;
      if (loading && !info) {
        return m('.peerd-net', m('.peerd-net-empty', 'Finding your way into the network…'));
      }
      if (!info) {
        return m('.peerd-net', m('.peerd-net-offline', [
          m('p', error ?? 'Network status is unavailable.'),
          m('button.peerd-net-btn', {
            disabled: !!refreshInFlight,
            onclick: () => refresh(send),
          }, refreshInFlight ? 'Checking…' : 'Retry status'),
        ]));
      }
      if (info.running === false) {
        return m('.peerd-net', m('.peerd-net-offline', [
          m('p', error && error !== 'unavailable'
            ? `The network isn’t live yet (${error}).`
            : 'The network isn’t live yet. It comes up on unlock and stays on in the background, '
              + 'so your apps keep their connections even with no tab open.'),
          transitionUnknown === 'start' ? m.fragment({}, [
            m('button.peerd-net-btn', {
              disabled: starting || !!refreshInFlight,
              onclick: () => refresh(send),
            }, refreshInFlight ? 'Checking…' : 'Recheck network status'),
            m('button.peerd-net-btn.secondary', {
              disabled: starting || !!refreshInFlight,
              onclick: () => start(send),
            }, starting ? 'Finishing…' : 'Finish same start'),
          ]) : m('button.peerd-net-btn', {
            disabled: starting || !!refreshInFlight,
            onclick: () => start(send),
          }, starting ? 'Starting…' : 'Start the network'),
        ]));
      }
      // The meeting point is in Technical details only. The list shows people.
      const boot = bootstrapPeer(info);
      /** @type {Peer[]} */
      const peers = (info.peers || []).map((/** @type {Peer} */ p) => {
        const name = names.get(p.did);
        return name ? { ...p, name } : p;
      });
      const connected = info.linkedCount >= 1;
      return m('.peerd-net', [
        m('p.peerd-net-status[role=status]', connected
          ? connectedLabel(info.linkedCount) : 'Looking for people who share apps…'),
        connected ? m('p.peerd-net-sub',
          'You can get apps from the people here, and they can get the apps you share.') : null,
        peers.length === 0
          ? m('.peerd-net-empty', 'Nobody else is here right now. People show up here when they come online.')
          : m('ul.peerd-net-list', peers.map((p) => {
            const pi = pathInfo(p);
            return m('li.peerd-net-row', { key: p.did }, [
              swatch(p),
              m('span.peerd-net-name', m('bdi', labelOf(p))),
              m('span.peerd-net-path', { class: `peerd-net-path--${pi.kind}` }, pi.plain),
            ]);
          })),
        peers.some((p) => labelOf(p) === NO_NAME)
          ? m('p.peerd-net-sub', ['To add a name for a person, open ', m('a.peerd-net-link', { href: '#contacts' }, 'Contacts'), '.']) : null,
        m('details.peerd-net-tech', [
          m('summary', 'Technical details'),
          m('.peerd-net-facts', [
            fact('You', short(info.did)),
            fact('Lobby', info.lobby || 'Not set'),
            fact('People', `${info.peerCount} seen · ${info.linkedCount} connected`),
            fact('DHT', String(info.dhtSize ?? 0)),
            boot ? fact('Meeting point', `${boot.host} · ${pathInfo(boot).label}`) : null,
            ...peers.map((p) => fact(labelOf(p), `${short(p.did)} · ${pathInfo(p).label}`, p)),
          ]),
        ]),
        m('a.peerd-net-link', { href: '#discover' }, 'Find apps'),
        // Kill switch — symmetric to "Start the network" in the offline view.
        // Drops every live connection and persists dweb off (won't auto-restart
        // on unlock) — docs/specs/FEATURE-FIRST-CLASS-MESSAGING.md §2.
        transitionUnknown === 'stop' ? m.fragment({}, [
          m('button.peerd-net-btn', {
            disabled: stopping || !!refreshInFlight,
            onclick: () => refresh(send),
          }, refreshInFlight ? 'Checking…' : 'Recheck network status'),
          m('button.peerd-net-btn.secondary', {
            disabled: stopping || !!refreshInFlight,
            onclick: () => stop(send),
          }, stopping ? 'Finishing…' : 'Finish same stop'),
        ]) : m('button.peerd-net-btn', {
          disabled: stopping || !!refreshInFlight,
          onclick: () => stop(send),
        }, stopping ? 'Stopping…' : 'Stop the network'),
      ]);
    },
  };
};
