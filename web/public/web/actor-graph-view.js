// web/actor-graph-view.js — render the ACTOR GRAPH model as a living radial SVG.
//
// The view half of peerd-runtime/actor/actor-graph.js (the pure model): the
// orchestrator at the center, LOCAL actors inside the magenta dweb boundary,
// REMOTE agents beyond it — one picture of "your agent web". Not a flat
// diagram: nodes float on slow offsets, wires curve and (when live) crawl,
// and faint orbit rings drift — the network reads as something ALIVE (owner
// direction). Motion is pure CSS keyed off stable per-node phases, and the
// whole render is SKIPPED when the model hasn't changed, so animations never
// reset mid-breath. prefers-reduced-motion turns it all off (host CSS).

import { buildActorGraph } from '/peerd-runtime/actor/actor-graph.js';

// model color names → the page's brand CSS vars
const FILL = { paper: 'var(--paper)', cyan: 'var(--cyan)', red: 'var(--red)', amber: 'var(--amber)', green: 'var(--green)', magenta: 'var(--magenta)' };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A stable little phase per node id, so floating offsets survive re-renders
// (same id → same bob timing; no jump when the graph updates).
const phaseOf = (id) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
};

/**
 * Build + render in one step. `input` is buildActorGraph's input
 * ({ selfLabel, actors, edges, peers }); the model does the shaping (dedupe,
 * dangling-edge drops, kind colors), this only places and draws. Re-rendering
 * with an unchanged model is a no-op (keeps CSS motion continuous).
 * @param {HTMLElement} el @param {object} input
 */
export function renderActorGraph(el, input) {
  const { nodes, edges } = buildActorGraph(input);
  const key = JSON.stringify({ nodes, edges });
  if (el._agKey === key) return;
  el._agKey = key;

  // Fixed compact viewBox (CSS scales + centers it).
  const W = 560, H = 260;
  const cx = W / 2, cy = H / 2 + 4;
  const locals = nodes.filter((n) => !n.remote && n.id !== 'self');
  const remotes = nodes.filter((n) => n.remote);

  /** @type {Map<string, [number, number]>} */
  const pos = new Map([['self', [cx, cy]]]);
  // why the per-ring phase stagger: with one node per ring, identical start
  // angles put everything on one vertical line, labels colliding.
  const place = (list, r, phase) => list.forEach((n, i) => {
    const a = (i / list.length) * 2 * Math.PI - Math.PI / 2 + phase;
    pos.set(n.id, [cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  });
  place(locals, 36, 0);
  place(remotes, 104, Math.PI / 3);

  // THE DWEB BOUNDARY (owner direction): a magenta bubble encloses YOUR peerd
  // — self + every local actor, each in its own module color — and magenta
  // dots live only OUTSIDE it (real p2p peers). Edges crossing the bubble ARE
  // the wire. The second, fainter ring is the remotes' orbit; both are dashed
  // and slowly CRAWL (stroke-dashoffset) — the drift that keeps the picture
  // from reading flat.
  const BUBBLE_R = 56;
  const rings = `<circle class="ag-bubble ag-crawl-slow" cx="${cx}" cy="${cy}" r="${BUBBLE_R}"/>`
    + `<circle class="ag-orbit ag-crawl-slower" cx="${cx}" cy="${cy}" r="104"/>`
    + `<text class="pn-label ag-bubble-label" x="${cx + BUBBLE_R * 0.72}" y="${(cy - BUBBLE_R * 0.72).toFixed(1)}">d</text>`;

  // Curved wires: a quadratic arc bows each edge off the straight line —
  // alternate sides per index so a busy graph weaves instead of starring.
  const line = (e, i) => {
    const f = pos.get(e.from), t = pos.get(e.to);
    const mx = (f[0] + t[0]) / 2, my = (f[1] + t[1]) / 2;
    const dx = t[0] - f[0], dy = t[1] - f[1];
    const len = Math.hypot(dx, dy) || 1;
    const bow = (i % 2 ? 1 : -1) * Math.min(14, len * 0.16);
    const qx = mx + (-dy / len) * bow, qy = my + (dx / len) * bow;
    return `<path class="pn-edge${e.live ? '' : ' pn-edge--faint'}" d="M ${f[0].toFixed(1)} ${f[1].toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${t[0].toFixed(1)} ${t[1].toFixed(1)}" fill="none"/>`;
  };

  // A node: soft color halo under the dot (the depth cue), label beneath,
  // the whole group floating on its own stable phase.
  const dot = (n) => {
    const [x, y] = pos.get(n.id);
    const r = n.id === 'self' ? 8 : 6;
    const fill = FILL[n.color] ?? FILL.paper;
    const ph = phaseOf(n.id);
    const style = `--bob-dur:${(3.2 + (ph % 5) * 0.45).toFixed(2)}s;animation-delay:-${(ph % 37) / 10}s`;
    return `<g class="ag-float" style="${style}"${n.live ? '' : ' opacity="0.45"'}>`
      + `<circle cx="${x}" cy="${y}" r="${r + (n.remote ? 9 : 7)}" fill="${fill}" opacity="0.10"/>`
      + `<circle cx="${x}" cy="${y}" r="${r + 3.5}" fill="${fill}" opacity="0.18"/>${
       n.id === 'self' ? `<circle class="pn-self-ring" cx="${x}" cy="${y}" r="${r + 5}"/>` : ''
       }<circle class="pn-dot" cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`
      + `<text class="pn-label" x="${x}" y="${(y + r + 14).toFixed(1)}">${esc(n.label)}${n.remote ? ' ◈' : ''}</text>`
      + `</g>`;
  };

  // rings under edges under nodes; self drawn last so its ring sits on top
  const ordered = [...nodes].sort((a) => (a.id === 'self' ? 1 : -1));
  el.innerHTML = `<svg class="pn-graph ag-graph" viewBox="0 0 ${W} ${H}" role="img" aria-label="your agent web">${
     rings
     }${edges.map(line).join('')
     }${ordered.map(dot).join('')
     }</svg>`;
}
