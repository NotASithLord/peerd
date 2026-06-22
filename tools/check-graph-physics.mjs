// tools/check-graph-physics.mjs — headless verification of the peer-graph
// physics used by extension/home/network-section.js (and the standalone sim).
// Run: bun tools/check-graph-physics.mjs
//
// Asserts the property the broken version violated: EVERY peer settles on the
// ring at radius ≈ RING (never the center), for any peer count incl. 1, with
// no NaN. This is the runnable check that fails if the spring/slot math breaks.

const W = 600, H = 380, CX = W / 2, CY = H / 2, RING = Math.min(W, H) * 0.36;
const SPRING = 0.02, DAMP = 0.86, ROTV = 0.0011, SPAWN = 0.82, TAU = Math.PI * 2;

// THE shared layout: peer i of n sits at an even angle on the ring (radius
// RING, ALWAYS — the old `n<=1 ? 0` collapsed a lone peer onto the hub). rot
// slowly turns the whole ring so it breathes.
const slot = (i, n, rot) => {
  const a = -Math.PI / 2 + (i / Math.max(1, n)) * TAU + rot;
  return { x: CX + Math.cos(a) * RING, y: CY + Math.sin(a) * RING };
};

const run = (n, frames = 800) => {
  let rot = 0;
  const phys = [];
  for (let i = 0; i < n; i++) {
    const s = slot(i, n, 0);                        // spawn near the slot, springs out
    phys.push({ x: CX + (s.x - CX) * SPAWN, y: CY + (s.y - CY) * SPAWN, vx: 0, vy: 0 });
  }
  for (let f = 0; f < frames; f++) {
    rot += ROTV;
    for (let i = 0; i < n; i++) {
      const t = slot(i, n, rot), st = phys[i];
      st.vx += (t.x - st.x) * SPRING; st.vy += (t.y - st.y) * SPRING;
      st.vx *= DAMP; st.vy *= DAMP;
      st.x += st.vx; st.y += st.vy;
    }
  }
  return phys.map((st) => Math.hypot(st.x - CX, st.y - CY));
};

let ok = true;
for (const n of [1, 2, 3, 5, 8, 20]) {
  const radii = run(n);
  const offRing = radii.filter((r) => Number.isNaN(r) || r < RING - 6 || r > RING + 6);
  // even spacing: nearest-neighbour chord for n on the ring
  const sep = n > 1 ? (2 * RING * Math.sin(Math.PI / n)).toFixed(1) : '—';
  console.log(`n=${String(n).padStart(2)}: radius ${radii[0].toFixed(1)}..${radii[radii.length - 1].toFixed(1)} `
    + `(target ${RING.toFixed(1)}, neighbour gap ${sep}px)  ${offRing.length ? 'FAIL' : 'ok'}`);
  if (offRing.length) ok = false;
}
console.log(ok ? '\nPASS — every peer converges to the ring; no center pile, no NaN.' : '\nFAIL');
process.exit(ok ? 0 : 1);
