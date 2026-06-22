// @ts-check
// Origin denylist matcher (§4.2).
//
// The denylist is a flat array of glob patterns. Only allowed wildcard
// is a leading `*.`, meaning "any subdomain of". This is intentional:
//   - regex is too easy to write wrong
//   - mid-pattern wildcards invite "evilchase.com matches *chase*" bugs
//
// The matcher MUST be careful about hostname boundaries. The key tests
// to pass — and the bugs we're guarding against:
//
//   '*.proton.me'  should match 'mail.proton.me'    YES
//   '*.proton.me'  should NOT  match 'protonmail.com'   ← substring/endsWith bug
//   '*.chase.com'  should NOT  match 'evilchase.com'    ← boundary bug
//   '*.chase.com'  should NOT  match 'chase.com'        ← apex (separately listed)
//   'chase.com'    should NOT  match 'evilchase.com'    ← exact match
//
// The seed denylist (§15) lists apex AND subdomain wildcard separately
// for each bank/etc. so that all forms are covered without the matcher
// having to decide policy.

/**
 * Find which pattern (if any) a hostname matches.
 *
 * @param {string} hostname        a fully-qualified hostname (no scheme, no port)
 * @param {readonly string[]} patterns
 * @returns {string | null}        the matched pattern, or null
 */
export const findDenylistMatch = (hostname, patterns) => {
  const h = hostname.toLowerCase();
  for (const p of patterns) {
    if (matchPattern(h, p.toLowerCase())) return p;
  }
  return null;
};

/**
 * @param {string} hostname        normalized hostname (lowercase)
 * @param {readonly string[]} patterns
 */
export const matchesDenylist = (hostname, patterns) =>
  findDenylistMatch(hostname, patterns) !== null;

/** @param {string} hostname @param {string} pattern */
const matchPattern = (hostname, pattern) => {
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    if (!base) return false;
    // The wildcard requires at least one subdomain label. We enforce by
    // checking the hostname ends with `.${base}` — that requires at
    // least one char before the dot. `protonmail.com` ends with `.com`
    // but NOT with `.proton.me`, so `*.proton.me` won't match it.
    return hostname.endsWith(`.${base}`);
  }
  // No wildcard: exact match.
  return hostname === pattern;
};

/**
 * Flatten the categorised default denylist JSON shape into a flat
 * pattern array. The JSON groups patterns by category (banks_us,
 * health_us, etc.) for human readability; the matcher just wants the
 * full list.
 *
 * @param {{ categories?: Record<string, string[]> } | null | undefined} categorised
 *        e.g. { categories: { banks_us: [...] } }
 * @returns {string[]}
 */
export const flattenCategorisedDenylist = (categorised) => {
  if (!categorised?.categories) return [];
  return Object.values(categorised.categories).flat();
};

/**
 * Normalize + validate a user-entered denylist pattern. Returns the
 * canonical lowercase pattern, or null when the input isn't a pattern
 * the matcher above can honor — fail closed on anything fancy rather
 * than store a pattern that silently never matches.
 *
 * Accepted: an exact hostname (`chase.com`) or a leading-`*.` glob
 * (`*.chase.com`). A pasted URL is tolerated by stripping the scheme /
 * path / port. Rejected: empty, no dot (would match nothing real), any
 * non-leading wildcard, spaces, or characters outside hostname syntax.
 *
 * @param {unknown} input
 * @returns {string | null}
 */
export const normalizeDenylistPattern = (input) => {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // strip scheme
  s = s.replace(/[/?#].*$/, '');                  // strip path/query/hash
  s = s.replace(/:\d+$/, '');                     // strip port
  const glob = s.startsWith('*.');
  const host = glob ? s.slice(2) : s;
  if (!host.includes('.')) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
  return glob ? `*.${host}` : host;
};
