// web/peer-host.js — page-side host for peerd's dweb peer.
//
// Symmetric with notebook-host.js: the transport (peerd-distributed) is vendored
// UNMODIFIED; this is the thin web adapter + the vanilla radial-graph (a port of
// the site's peers widget, itself a port of the extension's PeerGraph — UI, not
// protocol). Joins the SAME live lobby the extension + peerd.ai use, OBSERVE-ONLY
// (kind:'website', its own cap pool; never publishes/announces/sends). Started
// explicitly on tab activation (no IntersectionObserver — robust in a tab shell).

import { generateIdentity } from '/p2p/peerd-distributed/identity/keypair.js';
import { joinRoom } from '/p2p/peerd-distributed/transport/rooms.js';
import { createGossip } from '/p2p/peerd-distributed/gossip/topic.js';
import { createPresence } from '/p2p/peerd-distributed/gossip/presence.js';

const BASE_TOPIC = 'peerd/base/1';                          // the lobby the extension joins
const RENDEZVOUS = 'wss://bootstrap.peerd.ai/rendezvous';   // introductions only, never in the data path
const SVGNS = 'http://www.w3.org/2000/svg';

const BRAND = ['#00B7EB', '#EF4444', '#F59E0B', '#22C55E', '#D946EF'];
const colorByDid = new Map();
const colorOf = (did) => { if (!colorByDid.has(did)) colorByDid.set(did, BRAND[Math.floor(Math.random() * BRAND.length)]); return colorByDid.get(did); };
const kindOf = (p) => (p.kind === 'extension' ? 'extension' : p.kind === 'website' ? 'website' : 'peer');
const labelOf = (p) => (kindOf(p) === 'extension' ? 'extension' : kindOf(p) === 'website' ? 'visitor' : 'peer');

const makeGraph = (mount, selfLabel) => {
  const W = 600, H = 380, CX = W / 2, CY = H / 2, RING = Math.min(W, H) * 0.36, MAX = 40;
  const phys = new Map(), nodes = new Map();
  let peers = [], raf = 0, rot = 0;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const mk = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, String(attrs[k])); return e; };
  mount.innerHTML = '';
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', class: 'pn-graph', role: 'img', 'aria-label': 'Live peer graph' });
  const layer = mk('g', { class: 'pn-layer' });
  svg.append(
    layer,
    mk('circle', { class: 'pn-self-ring', cx: CX, cy: CY, r: 17 }),
    mk('circle', { class: 'pn-self', cx: CX, cy: CY, r: 11 }),
    Object.assign(mk('text', { class: 'pn-self-label', x: CX, y: CY + 32, 'text-anchor': 'middle' }), { textContent: selfLabel }),
  );
  mount.append(svg);
  const slot = (i, n) => { const a = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2 + rot; return { x: CX + Math.cos(a) * RING, y: CY + Math.sin(a) * RING }; };
  const writeGeom = (ref, x, y) => { ref.dot.setAttribute('cx', x); ref.dot.setAttribute('cy', y); ref.line.setAttribute('x2', x); ref.line.setAttribute('y2', y); ref.label.setAttribute('x', x); ref.label.setAttribute('y', y + 18); };
  const setPeers = (list) => { peers = [...(list || [])].sort((a, b) => (a.did < b.did ? -1 : a.did > b.did ? 1 : 0)).slice(0, MAX); };
  const sync = () => {
    const live = new Set(peers.map((p) => p.did));
    for (const [did, n] of [...nodes]) if (!live.has(did)) { n.g.remove(); nodes.delete(did); phys.delete(did); }
    peers.forEach((p, i) => {
      let n = nodes.get(p.did);
      if (!n) {
        const s = slot(i, peers.length), sx = CX + (s.x - CX) * 0.6, sy = CY + (s.y - CY) * 0.6;
        phys.set(p.did, { x: sx, y: sy, vx: 0, vy: 0 });
        const g = mk('g', { class: 'pn' });
        const line = mk('line', { x1: CX, y1: CY, x2: sx, y2: sy });
        const dot = mk('circle', { r: 9, cx: sx, cy: sy });
        const label = mk('text', { class: 'pn-label', x: sx, y: sy });
        g.append(line, dot, label); layer.append(g);
        n = { g, line, dot, label }; nodes.set(p.did, n);
      }
      n.line.setAttribute('class', `pn-edge${p.linked ? '' : ' pn-edge--faint'}`);
      n.dot.setAttribute('class', `pn-dot pn-dot--${kindOf(p)}`);
      n.dot.setAttribute('fill', colorOf(p.did));
      n.label.textContent = labelOf(p);
    });
    if (reduced) place();
  };
  const place = () => peers.forEach((p, i) => { const st = phys.get(p.did), ref = nodes.get(p.did); if (!st || !ref) return; const s = slot(i, peers.length); st.x = s.x; st.y = s.y; writeGeom(ref, s.x, s.y); });
  const tick = () => {
    rot += 0.0011; const n = peers.length;
    peers.forEach((p, i) => {
      const st = phys.get(p.did), ref = nodes.get(p.did); if (!st || !ref) return;
      const t = slot(i, n);
      st.vx += (t.x - st.x) * 0.012; st.vy += (t.y - st.y) * 0.012;
      st.vx *= 0.88; st.vy *= 0.88; st.x += st.vx; st.y += st.vy;
      writeGeom(ref, st.x, st.y);
    });
    raf = requestAnimationFrame(tick);
  };
  return {
    update(list) { setPeers(list); sync(); },
    start() { if (reduced) place(); else if (!raf) raf = requestAnimationFrame(tick); },
    stop() { if (raf) cancelAnimationFrame(raf); raf = 0; },
  };
};

const buildRoster = (room, presence, selfDid) => {
  const byDid = new Map();
  for (const l of room.mesh.peers()) byDid.set(l.did, { did: l.did, linked: true, path: l.info?.path ?? null, kind: null });
  for (const p of presence.list()) {
    if (p.did === selfDid) continue;
    const e = byDid.get(p.did) ?? { did: p.did, linked: false, path: null, kind: null };
    e.kind = p.meta?.kind ?? e.kind;
    byDid.set(p.did, e);
  }
  return [...byDid.values()];
};

/**
 * Start a real, observe-only dweb peer and render the live graph.
 * @param {{ rootEl: HTMLElement, mountEl: HTMLElement, statusEl: HTMLElement, countEl: HTMLElement }} els
 * @returns {Promise<{ stop: () => void }>}
 */
export async function startPeer({ rootEl, mountEl, statusEl, countEl }) {
  const setStatus = (cls, text) => { rootEl.classList.remove('is-connecting', 'is-live', 'is-failed'); rootEl.classList.add(cls); if (statusEl) statusEl.textContent = text; };
  const setCount = (n) => { if (countEl) countEl.textContent = n === 0 ? 'just you' : `${n} peer${n === 1 ? '' : 's'}`; };

  if (!window.crypto?.subtle || !window.RTCPeerConnection) { setStatus('is-failed', 'this browser can’t run the live peer'); return { stop() {} }; }

  const graph = makeGraph(mountEl, 'you · this page');
  graph.start();
  setStatus('is-connecting', 'joining the peerd network…');

  let identity, room, timer;
  try {
    identity = await generateIdentity();
    room = await joinRoom({ roomId: BASE_TOPIC, identity, url: RENDEZVOUS, kind: 'website' }); // observe-only
  } catch (e) {
    setStatus('is-failed', 'couldn’t reach the network right now');
    graph.stop();
    return { stop() {} };
  }
  const gossip = createGossip({ mesh: room.mesh });
  const presence = createPresence({ gossip, selfDid: identity.did, meta: () => ({ kind: 'website' }) });
  presence.start();
  setStatus('is-live', 'live on the peerd network');

  const refresh = () => { const roster = buildRoster(room, presence, identity.did); graph.update(roster); setCount(roster.length); };
  refresh();
  room.onPeer(refresh); room.onPeerGone(refresh); presence.onJoin(refresh); presence.onLeave(refresh);
  timer = setInterval(refresh, 4000);

  const stop = () => { try { clearInterval(timer); } catch {} try { graph.stop(); } catch {} try { room.leave(); } catch {} };
  window.addEventListener('pagehide', stop, { once: true });
  return { stop };
}
