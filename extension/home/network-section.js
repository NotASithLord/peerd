// @ts-check
// home/network-section.js — the peers + network-info view (dweb, preview-only).
//
// A live window onto the always-on base network: who you're connected to, by
// what real path (the IPv6 bet, on screen), and the lobby/DHT facts. The
// centerpiece is an animated radial peer graph in the WebTorrent spirit — YOU
// at the hub, peers orbiting, each in its own peerd brand color — but honest
// about a browser mesh: nodes are dids/names, NOT IPs (WebRTC hides peer IPs),
// and each edge shows its TRUE ICE path (direct IPv6 / IPv4-STUN / relay).
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
 * @property {string} [via]
 * @property {number} [lastSeen]
 */

const SVGNS = 'http://www.w3.org/2000/svg';

// --- brand color per peer (random per did, cached for the session) -----------
// Mirrors the commons participant rail (owner direction 2026-06-12: every dweb
// peer gets a peerd brand color, chosen at random client-side — the sanctioned
// exception to "one accent on monochrome", because the peers ARE the content).
// Cached in a module Map so a peer keeps its color across the 3s refresh and any
// graph rebuild. p·cyan e·red e·amber r·green d·magenta.
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
/** @param {Peer} p */
const labelOf = (p) => (p.name && p.name.trim() ? p.name.trim().slice(0, 18) : short(p.did));

// The honest connectivity label + a kind (for color). Never fabricates a path:
// link-less peers are "heard via gossip"; a linked peer whose ICE stats haven't
// settled is "connecting…", not a fake address. The bootstrap node is a peer
// like any other, tagged honestly: it does introductions (signaling), not data.
/** @param {Peer} p */
const pathInfo = (p) => {
  if (p.kind === 'bootstrap') return p.linked
    ? { label: 'bootstrap · signaling', kind: 'bootstrap' }
    : { label: 'bootstrap · connecting…', kind: 'connecting' };
  if (!p.linked) return { label: 'heard · gossip', kind: 'gossip' };
  const path = p.path;
  if (!path || path === 'unknown') return { label: 'connecting…', kind: 'connecting' };
  if (path === 'direct-ipv6') return { label: 'direct · IPv6', kind: 'direct' };
  if (path === 'direct-ipv4') return { label: 'direct · IPv4', kind: 'direct' };
  if (path.includes('srflx')) return { label: 'direct · IPv4 (STUN)', kind: 'stun' };
  if (path.includes('relay')) return { label: 'relay · TURN', kind: 'relay' };
  return { label: path, kind: 'stun' };
};

// The bootstrap (rendezvous) node is shown in the graph as a normal node,
// labelled by its domain — no special status badge. It has no did (it's a
// signaling server, not a mesh peer), so we synthesize one. linked === 'up'.
const BOOTSTRAP_DID = '__bootstrap__';
/** @param {string} url */
const domainOf = (url) => { try { return new URL(url).hostname; } catch { return 'bootstrap'; } };
/** @param {any} info */
const bootstrapPeer = (info) => (info.bootstrapUrl && info.rendezvous !== 'none'
  ? { did: BOOTSTRAP_DID, name: domainOf(info.bootstrapUrl), linked: info.rendezvous === 'up', kind: 'bootstrap' }
  : null);

// --- the animated radial peer graph ------------------------------------------
// Mithril owns the SVG SHELL (the <svg>, the static "You" hub); this component
// owns the peer LAYER imperatively (createElementNS into <g.pn-layer>) and a
// requestAnimationFrame loop that springs each peer to its slot on a slowly
// rotating ring, with light mutual repulsion + damping so it breathes like the
// WebTorrent graph. Mithril never declares children for .pn-layer, so its
// diff leaves our imperative nodes (and their rAF-written geometry) untouched.
// prefers-reduced-motion → a static ring, no rAF.
/**
 * @typedef {object} NodeRef
 * @property {SVGGElement} g
 * @property {SVGLineElement} line
 * @property {SVGCircleElement} dot
 * @property {SVGTextElement} label
 * @property {number} intro
 * @property {string | null} via
 * @property {SVGLineElement | null} introEdge
 */
/** @typedef {{ x: number, y: number, vx: number, vy: number }} Phys */

const PeerGraph = () => {
  const W = 600, H = 380, CX = W / 2, CY = H / 2;
  const RING = Math.min(W, H) * 0.36;
  const MAX = 40;                 // graph node cap (the list shows the rest)
  const INTRO_FRAMES = 165;       // the introduction handoff window (~2.75s @ 60fps) — long enough to read
  /** @type {Map<string, Phys>} */
  const phys = new Map();         // did -> { x, y, vx, vy }
  /** @type {Map<string, NodeRef>} */
  const nodes = new Map();        // did -> { g, line, dot, label, intro, via, introEdge }
  /** @type {Peer[]} */
  let peers = [];
  /** @type {Element | null} */
  let layer = null;
  let raf = 0;
  let rot = 0;
  let reduced = false;
  /** @type {MediaQueryList | null} */
  let mq = null;          // the prefers-reduced-motion query (re-checked live)
  // Park join animations until the graph is actually on screen. It sits BELOW
  // Library + Discover, so a peer can join while it's scrolled out of view; we
  // queue those intros and replay them when it scrolls in (the user can only
  // appreciate the handoff if they're looking at it).
  /** @type {IntersectionObserver | null} */
  let io = null;          // viewport observer
  let visible = false;    // is the graph ≥40% in view?
  /** @type {Map<string, string>} */
  const pendingIntro = new Map(); // did -> introId, for joins that happened off-screen

  // Peer i of n sits at an even angle on the ring (radius RING, ALWAYS — a lone
  // peer still orbits; the old `n<=1 ? 0` collapsed it onto the hub). rot turns
  // the whole ring slowly so it breathes. Verified in tools/check-graph-physics.mjs.
  /**
   * @param {number} i
   * @param {number} n
   */
  const slot = (i, n) => {
    const ang = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2 + rot;
    return { x: CX + Math.cos(ang) * RING, y: CY + Math.sin(ang) * RING };
  };

  /**
   * @param {string} tag
   * @param {Record<string, any>} attrs
   * @returns {SVGElement}
   */
  const mk = (tag, attrs) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    return e;
  };

  // Sort by did so each peer keeps a stable slot as others join/leave (the
  // snapshot order isn't stable); cap to MAX (the roster list shows the rest).
  /** @param {Peer[]} list */
  const setPeers = (list) => {
    peers = [...(list || [])].sort((a, b) => (a.did < b.did ? -1 : a.did > b.did ? 1 : 0)).slice(0, MAX);
  };

  /**
   * @param {NodeRef} ref
   * @param {number} x
   * @param {number} y
   */
  const writeGeom = (ref, x, y) => {
    ref.dot.setAttribute('cx', String(x)); ref.dot.setAttribute('cy', String(y));
    ref.line.setAttribute('x2', String(x)); ref.line.setAttribute('y2', String(y));
    ref.label.setAttribute('x', String(x)); ref.label.setAttribute('y', String(y + 20));
  };

  // Arm the introduction handoff for `n`: snap its dot back to the introducer and
  // (re)create the trailing intro edge, so the spring + crossfade play from there.
  // Used for a live join (graph on screen) and a replayed one (scrolled into view).
  /**
   * @param {NodeRef} n
   * @param {string} did
   * @param {string} introId
   */
  const armIntro = (n, did, introId) => {
    const st = phys.get(did), via = phys.get(introId);
    if (!st || !via) return;                       // introducer left → skip the handoff
    st.x = via.x; st.y = via.y; st.vx = 0; st.vy = 0;
    writeGeom(n, st.x, st.y);
    n.intro = INTRO_FRAMES; n.via = introId;
    if (n.introEdge) { n.introEdge.remove(); n.introEdge = null; }
    const vp = peers.find((x) => x.did === introId);
    n.introEdge = /** @type {SVGLineElement} */ (mk('line', { class: 'pn-intro-edge', x1: st.x, y1: st.y, x2: st.x, y2: st.y, stroke: colorOf((vp && vp.did) || introId) }));
    n.g.insertBefore(n.introEdge, n.g.firstChild);  // in the node's group → removed with it
  };

  // The graph scrolled into view: play the intros we parked while it was off-screen.
  const replayPending = () => {
    for (const [did, introId] of pendingIntro) {
      const n = nodes.get(did);
      if (n) armIntro(n, did, introId);
    }
    pendingIntro.clear();
  };

  // Reconcile the SVG peer layer + physics with the latest peers list.
  const sync = () => {
    // local const so TS keeps the non-null narrowing inside the forEach below
    const lyr = layer;
    if (!lyr) return;
    const live = new Set(peers.map((p) => p.did));
    for (const [did, n] of [...nodes]) {
      if (!live.has(did)) { n.g.remove(); nodes.delete(did); phys.delete(did); }
    }
    peers.forEach((p, i) => {
      const info = pathInfo(p);
      const faint = info.kind === 'gossip' || info.kind === 'connecting';
      let n = nodes.get(p.did);
      if (!n) {
        const s = slot(i, peers.length);
        // Introduction handoff: if we know WHO introduced this peer (p.via — the
        // bootstrap, or another peer in the mesh-assisted case), spawn AT the
        // introducer and trail an intro edge as the peer springs out to its slot.
        // Otherwise spawn just inside the ring slot (springs the last bit out).
        const introId = p.via === 'rendezvous' ? BOOTSTRAP_DID : p.via;
        const hasVia = introId && phys.get(introId);
        const sx = CX + (s.x - CX) * 0.82;
        const sy = CY + (s.y - CY) * 0.82;
        phys.set(p.did, { x: sx, y: sy, vx: 0, vy: 0 });
        const g = /** @type {SVGGElement} */ (mk('g', { class: 'pn' }));
        const line = /** @type {SVGLineElement} */ (mk('line', { x1: CX, y1: CY, x2: sx, y2: sy }));
        const dot = /** @type {SVGCircleElement} */ (mk('circle', { r: 9, cx: sx, cy: sy }));
        const label = /** @type {SVGTextElement} */ (mk('text', { class: 'pn-label', x: sx, y: sy }));
        g.append(line, dot, label);
        lyr.append(g);
        n = { g, line, dot, label, intro: 0, via: null, introEdge: null };
        nodes.set(p.did, n);
        // The handoff animates FROM the introducer — now if the graph is on
        // screen, else parked until it scrolls into view (so it isn't burned
        // down unseen below the fold). reduced-motion users opt out entirely.
        if (hasVia && introId && !reduced) {
          if (visible) armIntro(n, p.did, introId);
          else pendingIntro.set(p.did, introId);
        }
      }
      n.line.setAttribute('class', `pn-edge pn-edge--${info.kind}`);
      n.dot.setAttribute('class', `pn-dot${faint ? ' pn-dot--faint' : ''}`);
      n.dot.setAttribute('fill', colorOf(p.did));
      n.label.textContent = labelOf(p);
    });
    if (reduced) place();
  };

  const place = () => {
    peers.forEach((p, i) => {
      const st = phys.get(p.did), ref = nodes.get(p.did);
      if (!st || !ref) return;
      const s = slot(i, peers.length);
      st.x = s.x; st.y = s.y;
      writeGeom(ref, s.x, s.y);
    });
  };

  // Spring each peer toward its (slowly rotating) ring slot, with damping. No
  // mutual repulsion: the slots are already evenly spaced, so repulsion only
  // fired during transit and wasn't worth the O(n²) sweep. Constants verified
  // in tools/check-graph-physics.mjs (all counts converge to the ring, no NaN).
  const tick = () => {
    rot += 0.0011;
    const n = peers.length;
    peers.forEach((p, i) => {
      const st = phys.get(p.did), ref = nodes.get(p.did);
      if (!st || !ref) return;
      const t = slot(i, n);
      // Softer pull + a touch more damping so the dot's TRAVEL fills the intro
      // window (~1.1s to settle) instead of snapping to the ring in ~0.85s and
      // leaving the eye to read "done" while only the edge crossfade runs.
      st.vx += (t.x - st.x) * 0.012;
      st.vy += (t.y - st.y) * 0.012;
      st.vx *= 0.88; st.vy *= 0.88;
      st.x += st.vx; st.y += st.vy;
      writeGeom(ref, st.x, st.y);
      // The handoff: the intro edge (introducer→peer) fades out as the direct
      // edge (You→peer) fades in; then the introducer steps out of the path.
      if (ref.intro > 0) {
        ref.intro -= 1;
        const prog = ref.intro / INTRO_FRAMES;           // 1 → 0
        const via = ref.via ? phys.get(ref.via) : undefined;
        if (ref.introEdge && via) {
          ref.introEdge.setAttribute('x1', String(via.x)); ref.introEdge.setAttribute('y1', String(via.y));
          ref.introEdge.setAttribute('x2', String(st.x)); ref.introEdge.setAttribute('y2', String(st.y));
          ref.introEdge.setAttribute('opacity', (prog * 0.9).toFixed(3));
        }
        ref.line.setAttribute('opacity', ((1 - prog) * 0.6).toFixed(3));
        if (ref.intro === 0) {
          if (ref.introEdge) { ref.introEdge.remove(); ref.introEdge = null; }
          ref.line.removeAttribute('opacity');           // back to the CSS default
        }
      }
    });
    raf = requestAnimationFrame(tick);
  };

  // Start the rAF or fall to a static ring, honoring prefers-reduced-motion —
  // re-evaluated live so a mid-session OS toggle takes effect (not just at mount).
  const applyMotion = () => {
    reduced = mq?.matches ?? false;
    if (reduced) { if (raf) { cancelAnimationFrame(raf); raf = 0; } place(); }
    else if (!raf) raf = requestAnimationFrame(tick);
  };

  return {
    /** @param {{ dom: Element, attrs: { peers: Peer[] } }} vnode */
    oncreate(vnode) {
      layer = vnode.dom.querySelector('.pn-layer');
      setPeers(vnode.attrs.peers);
      sync();
      mq = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
      mq?.addEventListener?.('change', applyMotion);
      applyMotion();        // sets `reduced` + starts rAF or places statically
      // Track whether the graph is ≥40% in view; when it scrolls in, replay any
      // joins that arrived while it was below the fold (the parking gate).
      io = new IntersectionObserver((entries) => {
        const onScreen = entries.some((e) => e.intersectionRatio >= 0.4);
        if (onScreen && !visible) { visible = true; if (!reduced) replayPending(); }
        else if (!onScreen) visible = false;
      }, { threshold: [0, 0.4] });
      io.observe(vnode.dom);
    },
    /** @param {{ attrs: { peers: Peer[] } }} vnode */
    onupdate(vnode) {
      setPeers(vnode.attrs.peers);
      sync();
    },
    onremove() {
      mq?.removeEventListener?.('change', applyMotion);
      io?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      raf = 0; nodes.clear(); phys.clear(); pendingIntro.clear();
    },
    /** @param {{ attrs: { selfLabel?: string, peers?: Peer[] } }} vnode */
    view(vnode) {
      const selfLabel = vnode.attrs.selfLabel || 'You';
      const count = (vnode.attrs.peers || []).length;
      return m('svg.peerd-net-graph', {
        viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet',
        role: 'img', 'aria-label': `Network graph: you and ${count} peer${count === 1 ? '' : 's'}`,
      }, [
        m('g.pn-layer'),                                              // imperatively managed
        m('circle.pn-self-ring', { cx: CX, cy: CY, r: 17 }),
        m('circle.pn-self', { cx: CX, cy: CY, r: 11 }),
        m('text.pn-self-label', { x: CX, y: CY + 32, 'text-anchor': 'middle' }, selfLabel),
      ]);
    },
  };
};

/**
 * @param {string} k
 * @param {string} v
 */
const fact = (k, v) => m('.peerd-net-fact', [
  m('span.peerd-net-fact-k', k),
  m('span.peerd-net-fact-v', v),
]);

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
  /** @type {ReturnType<typeof setInterval> | number} */
  let timer = 0;
  let dead = false;      // set on unmount — an in-flight poll must not redraw

  /** @param {Send} send */
  const refresh = async (send) => {
    try {
      const r = await send({ type: 'dweb/distributed/info' });
      if (r && r.ok === false) { error = r.error || 'unavailable'; info = null; }
      else { info = r; error = null; }
    } catch (e) {
      error = /** @type {{ message?: string }} */ (e)?.message || String(e);
    }
    loading = false;
    if (!dead) m.redraw();
  };

  /** @param {Send} send */
  const start = async (send) => {
    starting = true; if (!dead) m.redraw();
    try { await send({ type: 'dweb/base/start' }); } catch (e) { error = /** @type {{ message?: string }} */ (e)?.message || String(e); }
    starting = false;
    await refresh(send);
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
      if (!info || info.running === false) {
        return m('.peerd-net', m('.peerd-net-offline', [
          m('p', error && error !== 'unavailable'
            ? `The network isn’t live yet (${error}).`
            : 'The network isn’t live yet. It comes up on unlock and stays on in the background, '
              + 'so your apps keep their connections even with no tab open.'),
          m('button.peerd-net-btn', { disabled: starting, onclick: () => start(send) },
            starting ? 'Starting…' : 'Start the network'),
        ]));
      }
      // The bootstrap node rides the graph as a normal node (no status badge) —
      // prepend it so it's there whether or not other peers are.
      const boot = bootstrapPeer(info);
      /** @type {Peer[]} */
      const peers = info.peers || [];
      /** @type {Peer[]} */
      const graphPeers = boot ? [boot, ...peers] : peers;
      return m('.peerd-net', [
        m('.peerd-net-facts', [
          fact('You', short(info.did)),
          fact('Lobby', info.lobby || '—'),
          fact('Peers', `${info.peerCount} · ${info.linkedCount} direct`),
          fact('DHT', String(info.dhtSize ?? 0)),
        ]),
        m(PeerGraph, { peers: graphPeers, selfLabel: 'You' }),   // no wrapper — sits on the page bg
        peers.length === 0 && !boot
          ? m('.peerd-net-empty', 'You’re the first one here. The network is live and listening, '
              + 'and peers appear as they come online, each link showing its true path.')
          : m('ul.peerd-net-list', graphPeers.map((p) => {
            const pi = pathInfo(p);
            const isBoot = p.kind === 'bootstrap';
            return m('li.peerd-net-row', { key: p.did }, [
              m('span.peerd-net-swatch', { style: `background:${colorOf(p.did)}` }),
              m('span.peerd-net-name', labelOf(p)),
              m('span.peerd-net-did', isBoot ? '' : short(p.did)),
              m('span.peerd-net-path', { class: `peerd-net-path--${pi.kind}` }, pi.label),
            ]);
          })),
      ]);
    },
  };
};
