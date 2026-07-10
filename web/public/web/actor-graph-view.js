// web/actor-graph-view.js — render the ACTOR GRAPH model as a radial SVG.
//
// The view half of peerd-runtime/actor/actor-graph.js (the pure model): the
// orchestrator at the center, LOCAL actors on the inner ring, REMOTE agents
// (mesh peers) on the outer ring — one picture of "your agent web", mirroring
// the peers tab's p2p graph (same pn-* styling) so the two read as one visual
// language. Brand rule: one kind-color per node dot, monochrome everything
// else; a live edge is solid, a cold one faint.

import { buildActorGraph } from '/peerd-runtime/actor/actor-graph.js';

// model color names → the page's brand CSS vars
const FILL = { paper: 'var(--paper)', cyan: 'var(--cyan)', red: 'var(--red)', amber: 'var(--amber)', green: 'var(--green)', magenta: 'var(--magenta)' };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Build + render in one step. `input` is buildActorGraph's input
 * ({ selfLabel, actors, edges, peers }); the model does the shaping (dedupe,
 * dangling-edge drops, kind colors), this only places and draws.
 * @param {HTMLElement} el @param {object} input
 */
export function renderActorGraph(el, input) {
  const { nodes, edges } = buildActorGraph(input);
  // Fixed compact viewBox (CSS scales + centers it): sizing to the panel width
  // strands a small fixed-radius cluster in a wide empty box.
  const W = 560, H = 230;
  const cx = W / 2, cy = H / 2 + 6;
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
  place(locals, 58, 0);
  place(remotes, 96, Math.PI / 3);

  const line = (e) => {
    const f = pos.get(e.from), t = pos.get(e.to);
    return `<line class="pn-edge${e.live ? '' : ' pn-edge--faint'}" x1="${f[0].toFixed(1)}" y1="${f[1].toFixed(1)}" x2="${t[0].toFixed(1)}" y2="${t[1].toFixed(1)}"/>`;
  };
  const dot = (n) => {
    const [x, y] = pos.get(n.id);
    const r = n.id === 'self' ? 8 : 6;
    return `<g${n.live ? '' : ' opacity="0.45"'}>${
       n.id === 'self' ? `<circle class="pn-self-ring" cx="${x}" cy="${y}" r="${r + 4}"/>` : ''
       }<circle class="pn-dot" cx="${x}" cy="${y}" r="${r}" fill="${FILL[n.color] ?? FILL.paper}"/>`
      + `<text class="pn-label" x="${x}" y="${(y + r + 11).toFixed(1)}">${esc(n.label)}${n.remote ? ' ◈' : ''}</text>`
      + `</g>`;
  };

  // edges under nodes; self drawn last so its ring sits on top
  const ordered = [...nodes].sort((a) => (a.id === 'self' ? 1 : -1));
  el.innerHTML = `<svg class="pn-graph ag-graph" viewBox="0 0 ${W} ${H}" role="img" aria-label="your agent web">${
     edges.map(line).join('')
     }${ordered.map(dot).join('')
     }</svg>`;
}
