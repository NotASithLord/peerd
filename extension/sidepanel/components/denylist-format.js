// @ts-check
// Denylist editor helpers — pure values-in/values-out, so they live on
// the bun test surface (the Mithril component itself is covered by the
// in-browser tests at extension/tests/unit/sidepanel/). Same split as
// ralph-format.js: keep this module import-free so `bun test ./tests`
// can exercise the filter/provenance logic without a browser.

/**
 * Case-insensitive substring filter over pattern text. Blank queries
 * pass everything through — the list is unfiltered by default.
 *
 * why substring, not glob/regex: the list is a few hundred hostnames;
 * typing any fragment ("chase", ".gov") should narrow it live. Anything
 * fancier invites the same writing-it-wrong bugs the matcher avoids.
 *
 * @param {readonly string[]} patterns
 * @param {string} query
 * @returns {string[]}
 */
export const filterPatterns = (patterns, query) => {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [...patterns];
  return patterns.filter((p) => p.toLowerCase().includes(q));
};

/**
 * Project the SW's denylist/list payload + the live search query into
 * what the editor renders: enforced rows tagged with provenance
 * (user-added vs built-in seed), the disabled-seed rows, and the n-of-N
 * counts so a filtered list is visibly filtered.
 *
 * @param {{ patterns?: string[], added?: string[], disabled?: string[] }} data
 *   patterns = the EFFECTIVE list ((seed − disabled) ∪ added);
 *   added/disabled = the user overlay.
 * @param {string} query
 */
export const denylistModel = ({ patterns = [], added = [], disabled = [] }, query = '') => {
  const addedSet = new Set(added);
  const active = filterPatterns(patterns, query)
    .map((p) => ({ pattern: p, user: addedSet.has(p) }));
  const disabledShown = filterPatterns(disabled, query);
  return {
    active,
    disabled: disabledShown,
    shown: active.length + disabledShown.length,
    total: patterns.length + disabled.length,
    filtered: String(query ?? '').trim().length > 0,
  };
};

/**
 * Copy for the remove-confirm step. Provenance decides what "remove"
 * honestly means: user-added patterns get a true delete; seed patterns
 * can only be DISABLED (the user overlay can't delete from the built-in
 * seed) — the verb and the consequence line say which one is about to
 * happen, and what it costs.
 *
 * @param {string} pattern
 * @param {boolean} isUser   true when the pattern is user-added
 * @returns {{ verb: 'Remove' | 'Disable', consequence: string }}
 */
export const removalCopy = (pattern, isUser) => ({
  verb: isUser ? 'Remove' : 'Disable',
  consequence: isUser
    ? `peerd will be able to act on ${pattern} again.`
    : `peerd will be able to act on ${pattern} again. Built-in patterns can't be deleted — this turns it off until you re-enable it.`,
});
