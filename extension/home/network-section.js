// @ts-check
// home/network-section.js — THE AGENT WEB view (dweb, preview-only).
//
// The network view, promoted into the whole picture: YOU at the hub, your
// ACTORS (WebVM / Notebook / App instances, dwapp actors marked, the dweb
// agent) orbiting INSIDE the dashed magenta dweb boundary in their module
// colors, and the mesh PEERS beyond it — all magenta, because magenta is the
// wire. Still honest about a browser mesh: peer nodes are dids/names, NOT IPs
// (WebRTC hides peer IPs), and each boundary-crossing edge shows its TRUE ICE
// path (direct IPv6 / IPv4-STUN / relay). Actor rows arrive from the SW's
// actors/graph route (engine registries + tab trackers); peers from
// dweb/distributed/info — merged here, rendered as one living graph.
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

// --- the agent-web color law (owner direction, 2026-07-10) -------------------
// MAGENTA IS RESERVED for what lives over the wire: mesh peers, the dweb
// boundary, the dweb actor. Everything INSIDE the boundary wears its own
// module's color. This supersedes the old random-brand-per-peer rule on THIS
// graph (peers all magenta = unmistakably "beyond the boundary"); the commons
// participant rail keeps its rainbow. Hexes mirror peerd-runtime's actor-graph
// KIND_COLOR (the canonical mapping) — inlined because this page is a pure
// client and never imports runtime modules (same precedent as the old inline
// BRAND row). p·cyan e·red e·amber r·green d·magenta.
const MAGENTA = '#D946EF';
/** @type {Record<string, string>} */
const KIND_HEX = {
  web: '#00B7EB', webvm: '#F59E0B', notebook: '#22C55E', app: '#F59E0B',
  integration: '#00B7EB', tab: '#22C55E', dweb: MAGENTA,
};
/** @param {string} kind */
const kindColor = (kind) => KIND_HEX[kind] ?? '#E8E6E1';
// The bootstrap rendezvous is INFRASTRUCTURE, not an agent — neutral, never
// magenta, so the "magenta = a peer's agent" read stays exact.
const BOOTSTRAP_COLOR = 'rgba(232,230,225,0.5)';
/** @param {Peer} p */
const peerColor = (p) => (p.kind === 'bootstrap' ? BOOTSTRAP_COLOR : MAGENTA);

// did short form — the codebase-canonical last 8 chars (rooms.js short()).
/** @param {string} did */
const short = (did) => (typeof did === 'string' ? did.slice(-8) : '????????');
/** @param {Peer} p */
const labelOf = (p) => (p.name && p.name.trim() ? p.name.trim().slice(0, 18) : short(p.did));
/** @param {string} s */
const label20 = (s) => (s.length <= 20 ? s : `${s.slice(0, 19)}…`);

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

// --- the animated AGENT-WEB graph --------------------------------------------
// One living picture of your whole agent world: YOU at the hub; your ACTORS
// (WebVMs, Notebooks, Apps — dwapp actors marked) on an inner ring INSIDE the
// dashed magenta dweb boundary, each in its module color with a soft halo;
// mesh PEERS beyond the boundary on the outer ring, all magenta — edges that
// cross the boundary ARE the wire, still labeled with their true ICE path.
// Mithril owns the SVG SHELL (the <svg>, the boundary, the static "You" hub);
// this component owns the node LAYER imperatively (createElementNS into
// <g.pn-layer>) and a requestAnimationFrame loop that springs each node to its
// slot — the two rings counter-rotate slowly, so the picture breathes with
// depth instead of spinning as one plate. Mithril never declares children for
// .pn-layer, so its diff leaves our imperative nodes (and their rAF-written
// geometry) untouched. prefers-reduced-motion → static rings, no rAF.
/**
 * @typedef {object} NodeRef
 * @property {SVGGElement} g
 * @property {SVGLineElement} line
 * @property {SVGCircleElement} dot
 * @property {SVGTextElement} label
 * @property {number} intro
 * @property {string | null} via
 * @property {SVGLineElement | null} introEdge
 * @property {SVGCircleElement | null} [halo]
 * @property {SVGCircleElement | null} [badge]
 */
/** @typedef {{ x: number, y: number, vx: number, vy: number }} Phys */
/** @typedef {{ type: string, handle: string, name?: string, live?: boolean, isActor?: boolean }} ActorRow */

const AgentWebGraph = () => {
  const W = 600, H = 380, CX = W / 2, CY = H / 2;
  const RING = Math.min(W, H) * 0.36;          // peers — beyond the boundary
  const BOUNDARY_R = 96;                        // the dweb membrane
  const ACTOR_RING = 58;                        // your actors — inside it
  const MAX = 40;                 // graph node cap (the list shows the rest)
  const INTRO_FRAMES = 165;       // the introduction handoff window (~2.75s @ 60fps) — long enough to read
  /** @type {Map<string, Phys>} */
  const phys = new Map();         // did -> { x, y, vx, vy }
  /** @type {Map<string, NodeRef>} */
  const nodes = new Map();        // did -> { g, line, dot, label, intro, via, introEdge }
  /** @type {Peer[]} */
  let peers = [];
  /** @type {ActorRow[]} */
  let actors = [];
  /** @type {Element | null} */
  let layer = null;
  let raf = 0;
  let rot = 0;      // outer (peer) ring rotation
  let rot2 = 0;     // inner (actor) ring — counter-rotates for depth
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

  // Node i of n sits at an even angle on its ring (ALWAYS at full radius — a
  // lone node still orbits; the old `n<=1 ? 0` collapsed it onto the hub). The
  // ring's own rotation turns it slowly so it breathes. Spring constants
  // verified in tools/check-graph-physics.mjs.
  /**
   * @param {number} i
   * @param {number} n
   * @param {number} radius
   * @param {number} spin
   */
  const slotAt = (i, n, radius, spin) => {
    const ang = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2 + spin;
    return { x: CX + Math.cos(ang) * radius, y: CY + Math.sin(ang) * radius };
  };
  /** @param {number} i @param {number} n */
  const slot = (i, n) => slotAt(i, n, RING, rot);
  /** @param {number} i @param {number} n */
  const actorSlot = (i, n) => slotAt(i, n, ACTOR_RING, rot2);

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
  // Actor node ids share the physics/nodes maps with peer dids — prefix them so
  // a handle can never collide with a did.
  /** @param {ActorRow} a */
  const actorId = (a) => `a:${a.handle}`;
  /** @param {ActorRow[]} list */
  const setActors = (list) => {
    actors = [...(list || [])].sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
  };

  /**
   * @param {NodeRef} ref
   * @param {number} x
   * @param {number} y
   * @param {number} [labelDy]
   */
  const writeGeom = (ref, x, y, labelDy = 20) => {
    ref.dot.setAttribute('cx', String(x)); ref.dot.setAttribute('cy', String(y));
    ref.line.setAttribute('x2', String(x)); ref.line.setAttribute('y2', String(y));
    ref.label.setAttribute('x', String(x)); ref.label.setAttribute('y', String(y + labelDy));
    if (ref.halo) { ref.halo.setAttribute('cx', String(x)); ref.halo.setAttribute('cy', String(y)); }
    if (ref.badge) { ref.badge.setAttribute('cx', String(x)); ref.badge.setAttribute('cy', String(y)); }
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
    n.introEdge = /** @type {SVGLineElement} */ (mk('line', { class: 'pn-intro-edge', x1: st.x, y1: st.y, x2: st.x, y2: st.y, stroke: vp ? peerColor(vp) : MAGENTA }));
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

  // Reconcile the SVG node layer + physics with the latest peers + actors.
  const sync = () => {
    // local const so TS keeps the non-null narrowing inside the forEach below
    const lyr = layer;
    if (!lyr) return;
    const live = new Set([...peers.map((p) => p.did), ...actors.map(actorId)]);
    for (const [id, n] of [...nodes]) {
      if (!live.has(id)) { n.g.remove(); nodes.delete(id); phys.delete(id); }
    }
    syncActors(lyr);
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
      n.dot.setAttribute('fill', peerColor(p));
      n.label.textContent = labelOf(p);
    });
    if (reduced) place();
  };

  // Reconcile the ACTOR ring: your instances, each in its module color with a
  // soft halo; a dwapp actor wears a dashed badge ring (it is an agent persona,
  // not just a sandbox). New actors spring OUT FROM THE HUB — born from you.
  /** @param {Element} lyr */
  const syncActors = (lyr) => {
    actors.forEach((a, i) => {
      const id = actorId(a);
      const color = kindColor(a.type);
      let n = nodes.get(id);
      if (!n) {
        phys.set(id, { x: CX, y: CY, vx: 0, vy: 0 });
        const g = /** @type {SVGGElement} */ (mk('g', { class: 'pn pn-actor' }));
        const line = /** @type {SVGLineElement} */ (mk('line', { x1: CX, y1: CY, x2: CX, y2: CY }));
        const halo = /** @type {SVGCircleElement} */ (mk('circle', { class: 'pn-halo', r: 13, cx: CX, cy: CY }));
        const dot = /** @type {SVGCircleElement} */ (mk('circle', { r: 7, cx: CX, cy: CY }));
        const badge = a.isActor
          ? /** @type {SVGCircleElement} */ (mk('circle', { class: 'pn-actor-badge', r: 10.5, cx: CX, cy: CY }))
          : null;
        const label = /** @type {SVGTextElement} */ (mk('text', { class: 'pn-label', x: CX, y: CY }));
        g.append(line, halo, ...(badge ? [badge] : []), dot, label);
        lyr.append(g);
        n = { g, line, dot, label, intro: 0, via: null, introEdge: null, halo, badge };
        nodes.set(id, n);
        if (reduced) { const s = actorSlot(i, actors.length); const st = phys.get(id); if (st) { st.x = s.x; st.y = s.y; } }
      }
      // a sleeping actor (no tab open) recedes as a WHOLE — halo, badge, edge
      // and label together, not just the dot
      n.g.setAttribute('class', `pn pn-actor${a.live ? '' : ' pn-actor--off'}`);
      n.dot.setAttribute('class', 'pn-dot pn-actor-dot');
      n.dot.setAttribute('fill', color);
      n.halo?.setAttribute('fill', color);
      n.badge?.setAttribute('stroke', color);
      n.line.setAttribute('class', `pn-edge pn-edge--actor${a.live ? ' pn-edge--alive' : ''}`);
      n.line.setAttribute('stroke', color);
      // A crowded ring keeps labels only on LIVE actors (the Library lists all).
      n.label.textContent = (actors.length > 8 && !a.live) ? '' : label20(a.name || String(a.handle));
    });
  };

  const place = () => {
    peers.forEach((p, i) => {
      const st = phys.get(p.did), ref = nodes.get(p.did);
      if (!st || !ref) return;
      const s = slot(i, peers.length);
      st.x = s.x; st.y = s.y;
      writeGeom(ref, s.x, s.y);
    });
    actors.forEach((a, i) => {
      const id = actorId(a);
      const st = phys.get(id), ref = nodes.get(id);
      if (!st || !ref) return;
      const s = actorSlot(i, actors.length);
      st.x = s.x; st.y = s.y;
      writeGeom(ref, s.x, s.y, 18);
    });
  };

  // Spring each peer toward its (slowly rotating) ring slot, with damping. No
  // mutual repulsion: the slots are already evenly spaced, so repulsion only
  // fired during transit and wasn't worth the O(n²) sweep. Constants verified
  // in tools/check-graph-physics.mjs (all counts converge to the ring, no NaN).
  const tick = () => {
    rot += 0.0011;
    rot2 -= 0.00065;   // inner ring counter-rotates, slower — parallax depth
    actors.forEach((a, i) => {
      const id = actorId(a);
      const st = phys.get(id), ref = nodes.get(id);
      if (!st || !ref) return;
      const t = actorSlot(i, actors.length);
      st.vx += (t.x - st.x) * 0.012;
      st.vy += (t.y - st.y) * 0.012;
      st.vx *= 0.88; st.vy *= 0.88;
      st.x += st.vx; st.y += st.vy;
      writeGeom(ref, st.x, st.y, 18);
    });
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
    /** @param {{ dom: Element, attrs: { peers: Peer[], actors?: ActorRow[] } }} vnode */
    oncreate(vnode) {
      layer = vnode.dom.querySelector('.pn-layer');
      setPeers(vnode.attrs.peers);
      setActors(vnode.attrs.actors ?? []);
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
    /** @param {{ attrs: { peers: Peer[], actors?: ActorRow[] } }} vnode */
    onupdate(vnode) {
      setPeers(vnode.attrs.peers);
      setActors(vnode.attrs.actors ?? []);
      sync();
    },
    onremove() {
      mq?.removeEventListener?.('change', applyMotion);
      io?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      raf = 0; nodes.clear(); phys.clear(); pendingIntro.clear();
    },
    /** @param {{ attrs: { selfLabel?: string, peers?: Peer[], actors?: ActorRow[] } }} vnode */
    view(vnode) {
      const selfLabel = vnode.attrs.selfLabel || 'You';
      const count = (vnode.attrs.peers || []).length;
      const actorCount = (vnode.attrs.actors || []).length;
      // THE DWEB BOUNDARY: your peerd lives inside the dashed magenta membrane
      // (a faint counter-crawling orbit guides the peer ring); edges that cross
      // it are the wire. Static shell — Mithril never touches .pn-layer.
      return m('svg.peerd-net-graph', {
        viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet',
        role: 'img',
        'aria-label': `The agent web: you, ${actorCount} actor${actorCount === 1 ? '' : 's'} inside the dweb boundary, ${count} peer${count === 1 ? '' : 's'} beyond it`,
      }, [
        m('circle.pn-boundary.pn-crawl', { cx: CX, cy: CY, r: BOUNDARY_R }),
        m('circle.pn-orbit.pn-crawl-rev', { cx: CX, cy: CY, r: RING }),
        m('text.pn-boundary-label', {
          x: CX + BOUNDARY_R * 0.74, y: CY - BOUNDARY_R * 0.72, 'text-anchor': 'middle',
        }, 'd'),
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
 * The AGENT WEB section, mounted on the home page (DWEB_ENABLED only) — the
 * network view promoted into the full picture: your actors inside the dweb
 * boundary, the mesh beyond it.
 * @returns {object} a Mithril component; attrs: { send }
 */
export const NetworkSection = () => {
  /** @type {any} */
  let info = null;       // last dweb/distributed/info reply
  /** @type {ActorRow[]} */
  let actors = [];       // last actors/graph reply (empty while vault-locked)
  let loading = true;
  /** @type {string | null} */
  let error = null;
  let starting = false;
  let stopping = false;
  /** @type {ReturnType<typeof setInterval> | number} */
  let timer = 0;
  let dead = false;      // set on unmount — an in-flight poll must not redraw

  /** @param {Send} send */
  const refresh = async (send) => {
    try {
      // one poll, both halves of the picture: the mesh (peers + paths) and
      // your actors (engine instances + the dweb agent). The actor half fails
      // SOFT — vault locked / route error just means a peers-only graph.
      const [r, a] = await Promise.all([
        send({ type: 'dweb/distributed/info' }),
        send({ type: 'actors/graph' }).catch(() => null),
      ]);
      if (r && r.ok === false) { error = r.error || 'unavailable'; info = null; }
      else { info = r; error = null; }
      actors = (a && a.ok && Array.isArray(a.actors)) ? a.actors : [];
    } catch (e) {
      error = /** @type {{ message?: string }} */ (e)?.message || String(e);
    }
    loading = false;
    if (!dead) m.redraw();
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
      if (r && r.ok === false) startErr = r.error || 'start failed';
    } catch (e) { startErr = /** @type {{ message?: string }} */ (e)?.message || String(e); }
    starting = false;
    await refresh(send);
    if (startErr) { error = startErr; if (!dead) m.redraw(); }
  };

  /** The kill switch: shut down ALL dweb networking + persist it off. @param {Send} send */
  const stop = async (send) => {
    // Destructive — drops every live connection — so confirm before the kill.
    if (typeof confirm === 'function'
      && !confirm('Shut down all peer-to-peer networking? This drops every live connection and keeps it off (it won’t come back on unlock) until you start it again.')) return;
    stopping = true; error = null; if (!dead) m.redraw();
    /** @type {string | null} */
    let stopErr = null;
    try {
      const r = await send({ type: 'dweb/base/stop' });
      if (r && r.ok === false) stopErr = r.error || 'stop failed';
    } catch (e) { stopErr = /** @type {{ message?: string }} */ (e)?.message || String(e); }
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
          fact('Actors', String(actors.length)),
          fact('Lobby', info.lobby || '—'),
          fact('Peers', `${info.peerCount} · ${info.linkedCount} direct`),
          fact('DHT', String(info.dhtSize ?? 0)),
        ]),
        m(AgentWebGraph, { peers: graphPeers, actors, selfLabel: 'You' }),   // no wrapper — sits on the page bg
        // the one-line legend: how to read the picture
        m('.peerd-net-legend', 'your actors live inside the magenta boundary, each in its module color — '
          + 'everything beyond it is the wire, and every crossing edge shows its true path'),
        peers.length === 0 && !boot
          ? m('.peerd-net-empty', 'You’re the first one here. The network is live and listening, '
              + 'and peers appear as they come online, each link showing its true path.')
          : m('ul.peerd-net-list', graphPeers.map((p) => {
            const pi = pathInfo(p);
            const isBoot = p.kind === 'bootstrap';
            return m('li.peerd-net-row', { key: p.did }, [
              m('span.peerd-net-swatch', { style: `background:${peerColor(p)}` }),
              m('span.peerd-net-name', labelOf(p)),
              m('span.peerd-net-did', isBoot ? '' : short(p.did)),
              m('span.peerd-net-path', { class: `peerd-net-path--${pi.kind}` }, pi.label),
            ]);
          })),
        // Kill switch — symmetric to "Start the network" in the offline view.
        // Drops every live connection and persists dweb off (won't auto-restart
        // on unlock) — docs/specs/FEATURE-FIRST-CLASS-MESSAGING.md §2.
        m('button.peerd-net-btn', {
          disabled: stopping,
          style: 'margin-top:10px; font-size:12px; opacity:.75;',
          onclick: () => stop(send),
        }, stopping ? 'Stopping…' : 'Stop the network'),
      ]);
    },
  };
};
