// @ts-check
// gem-resolver — pure RubyGems planning for the VM's `gem install` shim.
//
// Same story as npm/pip: `gem install` fails in the sandbox at the socket
// layer, so resolution + download happen HOST-side (tested JS) and the VM runs
// the offline tail (`gem install --local`). This turns the RubyGems JSON API
// into a flat .gem-download plan.
//
// Deliberate scope: PURE-RUBY gems (platform "ruby"),
// transitive over runtime dependencies, latest version. No native-extension
// gems (no 32-bit build toolchain story), no Bundler/Gemfile resolution. A gem
// whose tree needs a native build fails loudly, naming it.

/** @typedef {{ name: string, version: string, url: string, filename: string }} ResolvedGem */

const HOST = 'https://rubygems.org';

/**
 * Parse "name", "name:1.2.3" → { name, version|null }.
 * @param {string} spec
 * @returns {{ name: string, version: string|null }}
 */
export const parseSpec = (spec) => {
  const s = String(spec).trim();
  const m = /^([A-Za-z0-9._-]+)(?::([A-Za-z0-9._-]+))?$/.exec(s);
  if (!m) return { name: s, version: null };
  return { name: m[1], version: m[2] || null };
};

/**
 * Resolve a gem's download from its RubyGems JSON
 * (`/api/v1/gems/<name>.json` → { name, version, platform }). Returns null
 * when the latest version is a NATIVE platform gem (won't run on i386).
 * @param {{ name?: string, version?: string, platform?: string }} gemJson
 * @returns {{ version: string, url: string, filename: string } | null}
 */
export const selectGem = (gemJson) => {
  if (!gemJson || !gemJson.version) return null;
  const platform = gemJson.platform || 'ruby';
  if (platform !== 'ruby') return null; // native (e.g. x86_64-linux) — unsupported
  const filename = `${gemJson.name}-${gemJson.version}.gem`;
  return { version: gemJson.version, url: `${HOST}/downloads/${filename}`, filename };
};

/**
 * The runtime dependency names from a gem's JSON. Drops development deps.
 * @param {{ dependencies?: { runtime?: Array<{ name?: string }> } }} gemJson
 * @returns {string[]}
 */
export const runtimeDeps = (gemJson) => {
  const runtime = gemJson?.dependencies?.runtime ?? [];
  return [...new Set(runtime.map((d) => d?.name).filter(/** @returns {n is string} */ (n) => Boolean(n)))];
};

/**
 * Build a flat, deduped .gem-download plan for the root specs, resolving
 * runtime deps transitively. `getGem(name)` returns the RubyGems JSON. Throws
 * (naming the gem) on a missing gem or a native-only latest version.
 *
 * @param {string[]} rootSpecs
 * @param {(name: string) => Promise<any>} getGem
 * @param {{ maxPackages?: number }} [opts]
 * @returns {Promise<ResolvedGem[]>}
 */
export const resolveTree = async (rootSpecs, getGem, opts = {}) => {
  const maxPackages = opts.maxPackages ?? 300;
  /** @type {Map<string, ResolvedGem>} */
  const chosen = new Map();
  const queue = rootSpecs.map(parseSpec);
  while (queue.length) {
    if (chosen.size > maxPackages) throw new Error(`gem: dependency graph exceeds ${maxPackages} gems`);
    const next = queue.shift();
    if (!next) break;
    const { name } = next;
    if (chosen.has(name)) continue;
    const gemJson = await getGem(name);
    if (!gemJson || !gemJson.version) throw new Error(`gem: not found: ${name}`);
    const sel = selectGem(gemJson);
    if (!sel) {
      throw new Error(`gem: ${name} ${gemJson.version} is a native (${gemJson.platform}) gem `
        + '— native builds are not supported in the sandbox');
    }
    chosen.set(name, { name, version: sel.version, url: sel.url, filename: sel.filename });
    for (const dep of runtimeDeps(gemJson)) {
      if (!chosen.has(dep)) queue.push({ name: dep, version: null });
    }
  }
  return [...chosen.values()];
};
