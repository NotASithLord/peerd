// @ts-check
// Denylist editor helpers — pure values-in/values-out, so they live on
// the bun test surface (the Mithril component itself is covered by the
// in-browser tests at extension/tests/unit/sidepanel/). The pure/component
// split keeps this module import-free so `bun test ./tests` can exercise the
// filter/provenance logic without a browser.

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

/**
 * Display names for the seed's own category keys. The seed ships curated and
 * categorised (peerd-egress/denylist/default.json); this only makes those keys
 * readable — it never invents a taxonomy, and an unknown key still renders
 * (humanized) rather than dropping its patterns out of the list.
 * @type {Record<string, string>}
 */
const CATEGORY_LABELS = {
  banks_us: 'Banks (US)',
  brokers: 'Brokers',
  crypto_exchanges: 'Crypto exchanges',
  wallets: 'Wallets',
  health_us: 'Health (US)',
  government: 'Government',
  password_managers: 'Password managers',
  identity: 'Identity & SSO',
};

/** @param {string} key */
export const categoryLabel = (key) => CATEGORY_LABELS[key]
  ?? key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * Group the enforced rows for display: the user's own patterns first, then the
 * seed's categories.
 *
 * why grouped: the seed is 164 patterns. Flat, that is a wall nobody reads, and
 * it buried everything else on the page. Grouped, the page answers "what am I
 * protected from" at a glance and still opens to the individual pattern.
 *
 * Two rules that matter:
 *  - COUNTS COME FROM THE DATA. `total` is the category's real size, `shown` is
 *    how many survive the search. Nothing is hardcoded, so a seed edit can never
 *    leave the UI quietly lying about how many patterns are enforced.
 *  - A GROUP NEVER DISAPPEARS. A category with zero search hits stays listed at
 *    `0 of N`, because a list that silently drops empty groups reads as "these
 *    protections don't exist" — the opposite of the truth.
 *
 * A seed pattern the user DISABLED is not in `active`, so it appears in its
 * category's `shown` count only once re-enabled; the disabled section below the
 * groups is where it lives meanwhile.
 *
 * @param {{ pattern: string, user: boolean }[]} active  rows surviving the filter
 * @param {Record<string, string[]>} categories  the seed's own map
 * @param {readonly string[]} allPatterns  the UNFILTERED effective list, for totals
 * @returns {{ key: string, label: string, rows: { pattern: string, user: boolean }[], shown: number, total: number, user: boolean }[]}
 */
export const groupDenylist = (active, categories = {}, allPatterns = []) => {
  const shownByPattern = new Map(active.map((r) => [r.pattern, r]));
  const claimed = new Set();
  /** @type {ReturnType<typeof groupDenylist>} */
  const groups = [];

  for (const [key, patterns] of Object.entries(categories ?? {})) {
    const list = Array.isArray(patterns) ? patterns : [];
    const rows = [];
    for (const p of list) {
      claimed.add(p);
      const hit = shownByPattern.get(p);
      if (hit) rows.push(hit);
    }
    groups.push({
      key,
      label: categoryLabel(key),
      rows,
      shown: rows.length,
      // The category's real size, from the seed — not the number currently
      // enforced, so disabling one does not make the category look smaller.
      total: list.length,
      user: false,
    });
  }

  // Everything the seed did not claim: the user's own patterns, plus any seed
  // pattern whose category we could not resolve (a taxonomy gap must still be
  // reachable — it is enforced either way).
  const ownRows = active.filter((r) => !claimed.has(r.pattern));
  const ownTotal = allPatterns.filter((p) => !claimed.has(p)).length;
  if (ownTotal > 0 || ownRows.length > 0) {
    groups.unshift({
      key: '__user', label: 'Your patterns', rows: ownRows, shown: ownRows.length, total: ownTotal, user: true,
    });
  }
  return groups;
};
