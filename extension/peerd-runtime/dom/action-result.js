// @ts-check
// peerd-runtime/dom — action-result attribution formatter (DOM nav Phase 2).
//
// Pure: turn the page-side mutation capture (added/removed/attr + counts,
// produced by the CDP click/type observers in background/debugger-pool.js)
// into a short, model-readable "what changed" line. The agent learns the
// page's reaction to its action without a full re-snapshot.
//
// PURE (values in, values out) → unit-testable without a browser.

/**
 * @param {null | undefined | { added?: string[], removed?: string[], attr?: string[],
 *   counts?: { added: number, removed: number, attr: number } }} m
 *   undefined is tolerated defensively (the `!m` guard maps null and
 *   undefined alike to null); shipped callers normalize missing captures
 *   to null before this point (debugger-pool's `mutations ?? null`), so
 *   undefined arrives only from direct callers and tests.
 * @returns {string|null}  a summary line, or null if no capture happened
 */
export const summarizeMutations = (m) => {
  if (!m || typeof m !== 'object') return null;
  const c = m.counts ?? { added: 0, removed: 0, attr: 0 };
  const total = (c.added || 0) + (c.removed || 0) + (c.attr || 0);
  if (total === 0) return 'no DOM change detected';
  /** @param {string[] | undefined} arr */
  const list = (arr) => (Array.isArray(arr) && arr.length ? ` (${arr.join(', ')})` : '');
  const parts = [];
  if (c.added) parts.push(`+${c.added} added${list(m.added)}`);
  if (c.removed) parts.push(`−${c.removed} removed${list(m.removed)}`);
  if (c.attr) parts.push(`${c.attr} attr${list(m.attr)}`);
  return parts.join('; ');
};
