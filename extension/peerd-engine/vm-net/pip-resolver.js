// @ts-check
// pip-resolver — pure pip planning for the VM's `pip install` shim.
//
// Like npm, pip fails in the sandbox at the socket layer, not HTTP. Same fix:
// resolve + download HOST-side (tested JS), then `pip install --no-index` the
// staged wheels in the VM. This module turns PyPI JSON (injected fetcher) into
// a flat wheel-download plan.
//
// Deliberate scope (VM-NETWORKING.md): PURE-PYTHON wheels (py3-none-any),
// transitive over Requires-Dist, latest compatible release. No sdists, no
// native/C-extension builds (no toolchain for the 32-bit image), no extras,
// markers evaluated only enough to drop `extra ==` deps. A package whose tree
// needs a native wheel fails loudly, naming it.

/** @typedef {{ name: string, version: string, url: string, filename: string }} ResolvedWheel */

/**
 * Normalize a distribution name per PEP 503 (lowercase, runs of -_. → -).
 * @param {string} name @returns {string}
 */
export const normalizeName = (name) => String(name).trim().toLowerCase().replace(/[-_.]+/g, '-');

/**
 * Parse "pkg", "pkg==1.2.3", "pkg>=1.0" → { name, version|null }.
 * @param {string} spec
 * @returns {{ name: string, version: string|null }}
 */
export const parseSpec = (spec) => {
  const s = String(spec).trim();
  const m = /^([A-Za-z0-9._-]+)\s*(?:==\s*([A-Za-z0-9._-]+))?.*$/.exec(s);
  if (!m) return { name: normalizeName(s), version: null };
  return { name: normalizeName(m[1]), version: m[2] || null };
};

/**
 * Pick the best wheel from a PyPI release's file list. Prefers a pure-python
 * wheel (py3-none-any / py2.py3-none-any); else a wheel whose platform/abi tags
 * intersect the VM's supported tags. Returns null when nothing fits (e.g. only
 * an sdist, or only cp3x-manylinux for the wrong arch).
 *
 * @param {Array<{ filename?: string, url?: string, packagetype?: string, yanked?: boolean }>} files
 * @param {{ pyTags?: string[] }} [opts]  extra acceptable "<abi>-<platform>" fragments
 * @returns {{ url: string, filename: string } | null}
 */
export const selectWheel = (files, opts = {}) => {
  const pyTags = opts.pyTags ?? [];
  const wheels = (files || []).filter((f) =>
    !f.yanked && (f.packagetype === 'bdist_wheel' || /\.whl$/.test(f.filename || '')));
  // 1. pure-python wheels — run anywhere
  const pure = wheels.find((f) => /-(?:py2\.)?py3-none-any\.whl$/.test(f.filename || '')
    || /-py3-none-any\.whl$/.test(f.filename || ''));
  // why: url/filename are optional on the input shape but a matched PyPI file
  // (selected via its .whl filename) always carries both — cast to the concrete
  // return shape. Runtime-identical (no value change, annotation only).
  if (pure) return /** @type {{ url: string, filename: string }} */ ({ url: pure.url, filename: pure.filename });
  // 2. a wheel matching one of the VM's platform tags
  if (pyTags.length) {
    const match = wheels.find((f) => pyTags.some((/** @type {string} */ t) => (f.filename || '').includes(t)));
    if (match) return /** @type {{ url: string, filename: string }} */ ({ url: match.url, filename: match.filename });
  }
  return null;
};

/**
 * Parse a Requires-Dist list into the runtime dependency NAMES to pull.
 * Drops entries gated on an extra (`; extra == "..."`) and keeps the rest,
 * stripping version specifiers + environment markers. Conservative but honest:
 * it pulls a package's mandatory deps, not its optional extras.
 *
 * @param {string[]} requiresDist
 * @returns {string[]} normalized dependency names
 */
export const parseRequiresDist = (requiresDist) => {
  /** @type {string[]} */
  const out = [];
  for (const raw of requiresDist || []) {
    const [reqPart, markerPart] = String(raw).split(';');
    if (markerPart && /\bextra\s*==/.test(markerPart)) continue; // optional extra → skip
    const nameMatch = /^\s*([A-Za-z0-9._-]+)/.exec(reqPart);
    if (nameMatch) out.push(normalizeName(nameMatch[1]));
  }
  return [...new Set(out)];
};

/**
 * Build a flat, deduped wheel-download plan for the root specs, resolving
 * Requires-Dist transitively. `getJson(name)` returns the package's PyPI JSON
 * ({ info:{ version, requires_dist }, urls:[files] }). Throws (naming the
 * package) when a node has no installable pure/compatible wheel.
 *
 * @param {string[]} rootSpecs
 * @param {(name: string) => Promise<any>} getJson
 * @param {{ pyTags?: string[], maxPackages?: number }} [opts]
 * @returns {Promise<ResolvedWheel[]>}
 */
export const resolveTree = async (rootSpecs, getJson, opts = {}) => {
  const maxPackages = opts.maxPackages ?? 300;
  /** @type {Map<string, ResolvedWheel>} */
  const chosen = new Map();
  const queue = rootSpecs.map(parseSpec);
  while (queue.length) {
    if (chosen.size > maxPackages) throw new Error(`pip: dependency graph exceeds ${maxPackages} packages`);
    const next = queue.shift();
    if (!next) break;
    const { name } = next;
    if (chosen.has(name)) continue;
    const json = await getJson(name);
    if (!json || !json.info) throw new Error(`pip: package not found: ${name}`);
    const version = json.info.version;
    const wheel = selectWheel(json.urls || [], opts);
    if (!wheel) {
      throw new Error(`pip: no pure-python/compatible wheel for ${name}==${version} `
        + '(native builds are not supported in the sandbox)');
    }
    chosen.set(name, { name, version, url: wheel.url, filename: wheel.filename });
    for (const dep of parseRequiresDist(json.info.requires_dist)) {
      if (!chosen.has(dep)) queue.push({ name: dep, version: null });
    }
  }
  return [...chosen.values()];
};
