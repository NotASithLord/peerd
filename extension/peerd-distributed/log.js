// @ts-check
// peerd-distributed/log.js — loud, obvious dweb logging for troubleshooting.
//
// The live peer-to-peer path can't be unit-tested (the honest Bun
// boundary), so when something goes wrong in a real browser these logs
// are the diagnostic. They wear a magenta "DWEB" badge (the d-module
// brand color) so they stand out in a busy console, and a per-area tag so
// you can see the flow: rendezvous → mesh → gossip.
//
// Preview/research-grade module — verbose by default. Flip DWEB_LOG to
// false (or set globalThis.__DWEB_LOG__ = false at runtime) to silence.

export const DWEB_LOG = true;

// Loud ONLY in a real browser page (app-tab / offscreen / the commons
// iframe — all have `window`). Silent under Bun (the test suite and the
// signaling-node shells, which do their own plain console.log), so the
// `%c`-styled badge never spams terminal output. Runtime kill switch:
// globalThis.__DWEB_LOG__ = false.
const on = () =>
  DWEB_LOG
  && typeof window !== 'undefined'
  && /** @type {Record<string, unknown>} */ (globalThis).__DWEB_LOG__ !== false;

const BADGE = 'background:#c4319b;color:#fff;font-weight:bold;border-radius:3px;padding:0 4px';
const TAG = 'color:#c4319b;font-weight:bold';

/**
 * dlog('rendezvous', 'connecting to', url) → ` DWEB  rendezvous  connecting to <url>`
 * @param {string} tag
 * @param {...unknown} args
 */
export const dlog = (tag, ...args) => {
  if (!on()) return;
  try { console.log(`%c DWEB %c ${tag} `, BADGE, TAG, ...args); }
  catch { /* console unavailable (some worker contexts) — never throw from a log */ }
};

/**
 * Loud failure variant — red, for things the user should notice.
 * @param {string} tag
 * @param {...unknown} args
 */
export const dwarn = (tag, ...args) => {
  if (!on()) return;
  try { console.warn(`%c DWEB %c ${tag} `, 'background:#d04545;color:#fff;font-weight:bold;border-radius:3px;padding:0 4px', 'color:#d04545;font-weight:bold', ...args); }
  catch { /* ignore */ }
};
