// @ts-check
/** @param {string} host @returns {string} */
const canonicalHost = (host) =>
  String(host).toLowerCase().replace(/:\d+$/, '').replace(/\.+$/, '');

/**
 * @param {string} hostname
 * @param {readonly string[]} patterns
 * @returns {string | null}
 */
export const findDenylistMatch = (hostname, patterns) => {
  const h = canonicalHost(hostname);
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
    return hostname.endsWith(`.${base}`);
  }
  return hostname === pattern;
};

/**
 * @param {{ categories?: Record<string, string[]> } | null | undefined} categorised
 * @returns {string[]}
 */
export const flattenCategorisedDenylist = (categorised) => {
  if (!categorised?.categories) return [];
  return Object.values(categorised.categories).flat();
};

/** @param {unknown} input @returns {string | null} */
export const normalizeDenylistPattern = (input) => {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.replace(/[/?#].*$/, '');
  s = s.replace(/:\d+$/, '');
  const glob = s.startsWith('*.');
  const host = glob ? s.slice(2) : s;
  if (!host.includes('.')) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
  return glob ? `*.${host}` : host;
};
