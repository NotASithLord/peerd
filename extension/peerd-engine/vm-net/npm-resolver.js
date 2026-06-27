// @ts-check
// npm-resolver — pure npm dependency planning for the VM's `npm install` shim.
//
// npm fails in the VM not because of HTTP but because it opens raw sockets the
// sandbox doesn't have. The fix mirrors the curl/git wrappers: do the network
// HOST-side, where the tested logic lives, and let the VM run the offline tail.
// This module is the brain — given a set of root specs and an injected
// registry-doc fetcher, it produces a flat, deduped install plan (name →
// version → tarball). IO is injected, so it's fully unit-testable.
//
// Deliberate scope: runtime `dependencies`
// only (no dev/peer/optional), no install scripts, no native builds. That
// covers the common "pull a JS library so I can read/run it" case; it is NOT a
// full npm. Correctness over coverage — an unsupported range fails loudly.

/** @typedef {{ name: string, version: string, tarball: string, dependencies: Record<string,string> }} ResolvedPkg */

// --- semver: a focused, correct subset of the range grammar -----------------
// Supports: exact, x-ranges (* / "" / 1.x / 1.2.x), ^, ~, comparators
// (>=,>,<=,<,=), AND (space) and OR (||). Pre-release tags are compared but a
// range never matches a prerelease unless it names that exact version.

/** @param {string} v @returns {[number,number,number,string]|null} */
export const parseVersion = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+](.+))?$/.exec(String(v).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ''];
};

/**
 * Compare two version strings. -1 / 0 / 1. Prerelease < release.
 * @param {string} a @param {string} b @returns {number}
 */
export const compareVersions = (a, b) => {
  const pa = parseVersion(a); const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1; }
  if (pa[3] === pb[3]) return 0;
  if (!pa[3]) return 1;       // a is release, b prerelease → a greater
  if (!pb[3]) return -1;
  return pa[3] < pb[3] ? -1 : 1;
};

/** @param {string} v */
const isPrerelease = (v) => { const p = parseVersion(v); return !!(p && p[3]); };

/**
 * Does a concrete version satisfy a single comparator set (AND of terms)?
 * @param {string} version @param {string} range @returns {boolean}
 */
const satisfiesSimple = (version, range) => {
  const r = range.trim();
  if (r === '' || r === '*' || r === 'x' || r === 'X' || r === 'latest') return !isPrerelease(version);
  // hyphen range: "1.2.3 - 2.3.4"
  const hy = /^(\S+)\s+-\s+(\S+)$/.exec(r);
  if (hy) return compareVersions(version, hy[1]) >= 0 && compareVersions(version, hy[2]) <= 0;
  // AND of space-separated comparators
  const terms = r.split(/\s+/).filter(Boolean);
  return terms.every((/** @type {string} */ t) => satisfiesTerm(version, t));
};

/** @param {string} version @param {string} term @returns {boolean} */
const satisfiesTerm = (version, term) => {
  const pv = parseVersion(version);
  if (!pv) return false;
  let m;
  if ((m = /^([~^]|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+](\S+))?$/.exec(term))) {
    const op = m[1] || '=';
    const major = Number(m[2]);
    const minorRaw = m[3]; const patchRaw = m[4];
    const minorX = minorRaw === undefined || minorRaw === 'x' || minorRaw === 'X' || minorRaw === '*';
    const patchX = patchRaw === undefined || patchRaw === 'x' || patchRaw === 'X' || patchRaw === '*';
    const minor = minorX ? 0 : Number(minorRaw);
    const patch = patchX ? 0 : Number(patchRaw);
    const pre = m[5] ? `-${m[5]}` : '';
    const base = `${major}.${minor}.${patch}${pre}`;
    // Standard semver: a prerelease version only satisfies a comparator that
    // names the SAME [major,minor,patch] tuple AND is itself a prerelease.
    // Otherwise `<3.0.0` etc. must not silently pull a `3.0.0-rc.1`.
    if (isPrerelease(version) && !(m[5] && pv[0] === major && pv[1] === minor && pv[2] === patch)) {
      return false;
    }
    if (op === '^') {
      const upper = major > 0 ? `${major + 1}.0.0` : minor > 0 ? `0.${minor + 1}.0` : `0.0.${patch + 1}`;
      return compareVersions(version, base) >= 0 && compareVersions(version, upper) < 0 && !isPrerelease(version);
    }
    if (op === '~') {
      const upper = minorX ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
      return compareVersions(version, base) >= 0 && compareVersions(version, upper) < 0 && !isPrerelease(version);
    }
    if (op === '>=') return compareVersions(version, base) >= 0;
    if (op === '>') return compareVersions(version, base) > 0;
    if (op === '<=') return compareVersions(version, base) <= 0;
    if (op === '<') return compareVersions(version, base) < 0;
    // '=' : x-ranges widen to a prefix match
    if (minorX) return pv[0] === major;
    if (patchX) return pv[0] === major && pv[1] === minor;
    return compareVersions(version, base) === 0;
  }
  return false;
};

/**
 * Full range with || (OR).
 * @param {string} version @param {string} range @returns {boolean}
 */
export const satisfies = (version, range) =>
  String(range).split('||').some((part) => satisfiesSimple(version, part));

/**
 * Highest version in `versions` satisfying `range` (null if none).
 * @param {string[]} versions @param {string} range @returns {string|null}
 */
export const maxSatisfying = (versions, range) => {
  /** @type {string|null} */
  let best = null;
  for (const v of versions) {
    if (satisfies(v, range) && (best === null || compareVersions(v, best) > 0)) best = v;
  }
  return best;
};

/**
 * Resolve a version from a registry doc + a range/dist-tag.
 * @param {{ versions: Record<string, any>, 'dist-tags'?: Record<string,string> }} doc
 * @param {string} range
 * @returns {string|null}
 */
export const resolveVersion = (doc, range) => {
  const tags = doc['dist-tags'] || {};
  const spec = (range || 'latest').trim();
  if (tags[spec]) return tags[spec];                  // a dist-tag (e.g. latest, next)
  if (spec === '' || spec === '*') return tags.latest ?? maxSatisfying(Object.keys(doc.versions || {}), '*');
  if (doc.versions && doc.versions[spec]) return spec; // exact pin
  return maxSatisfying(Object.keys(doc.versions || {}), spec);
};

/**
 * Parse "name@range" / "@scope/name@range" → { name, range }.
 * @param {string} spec
 * @returns {{ name: string, range: string }}
 */
export const parseSpec = (spec) => {
  const s = String(spec).trim();
  const at = s.lastIndexOf('@');
  if (at <= 0) return { name: s, range: 'latest' };   // no range, or leading @ of a scope
  return { name: s.slice(0, at), range: s.slice(at + 1) || 'latest' };
};

/**
 * Build a flat, deduped install plan for the given root specs, resolving
 * runtime dependencies transitively. `getDoc(name)` returns the registry doc.
 * Throws a descriptive Error when a name/range can't be resolved.
 *
 * @param {string[]} rootSpecs e.g. ['express', 'lodash@^4']
 * @param {(name: string) => Promise<any>} getDoc
 * @param {{ maxPackages?: number }} [opts]
 * @returns {Promise<ResolvedPkg[]>}
 */
export const resolveTree = async (rootSpecs, getDoc, opts = {}) => {
  const maxPackages = opts.maxPackages ?? 500;
  /** @type {Map<string, ResolvedPkg>} */
  const chosen = new Map();   // name → resolved (first-wins, dedup by name)
  const queue = rootSpecs.map(parseSpec);
  while (queue.length) {
    if (chosen.size > maxPackages) throw new Error(`npm: dependency graph exceeds ${maxPackages} packages`);
    const next = queue.shift();
    if (!next) break;
    const { name, range } = next;
    if (chosen.has(name)) continue;   // already resolved a version; keep it (flat dedup)
    const doc = await getDoc(name);
    if (!doc || !doc.versions) throw new Error(`npm: package not found: ${name}`);
    const version = resolveVersion(doc, range);
    if (!version || !doc.versions[version]) throw new Error(`npm: no version of ${name} satisfies "${range}"`);
    const v = doc.versions[version];
    const tarball = v?.dist?.tarball;
    if (!tarball) throw new Error(`npm: ${name}@${version} has no tarball`);
    const dependencies = v.dependencies || {};
    chosen.set(name, { name, version, tarball, dependencies });
    for (const [dep, depRange] of Object.entries(dependencies)) {
      if (!chosen.has(dep)) queue.push({ name: dep, range: depRange });
    }
  }
  return [...chosen.values()];
};
