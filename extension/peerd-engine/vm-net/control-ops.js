// @ts-check
// control-ops — the host-side orchestration behind the VM's `peerd://` ops.
//
// The VM can't resolve a dependency tree, probe a default branch, or stage
// downloaded bytes — so it emits a control request (peerd://git-clone,
// npm-install, pip-install, gem-install) and the HOST runs the flow here using
// the tested planners (git-archive / npm|pip|gem-resolver), fetching through
// the cached, denylist-gated egress and staging files into the VM.
//
// PURE + IO-injected so the clone/install flows are unit-testable without
// CheerpX. The caller (vm-tab.js handleControlOp) provides:
//   io.fetchJson(url, { auth })  → parsed JSON, or null on a non-200/empty
//   io.fetchBytes(url, { auth }) → Uint8Array, or null
//   io.stage(name, bytes)        → the VM path the staged file landed at
// `auth:'git'` is set ONLY here, on URLs the host derived — never from VM input.
//
// Returns { bodyBytes, meta } (success) or { errMsg } (failure).

import { parseRepoUrl, archiveCandidates, defaultBranchProbe } from './git-archive.js';
import { resolveTree as npmResolveTree } from './npm-resolver.js';
import { resolveTree as pipResolveTree } from './pip-resolver.js';
import { resolveTree as gemResolveTree } from './gem-resolver.js';

/** @param {string} s */
/**
 * Injected IO (see module header). Auth is host-set only.
 * @typedef {Object} ControlOpIo
 * @property {(url: string, opts?: { auth?: string }) => Promise<any>} fetchJson  parsed JSON, or null
 * @property {(url: string, opts?: { auth?: string }) => Promise<Uint8Array|null>} fetchBytes  bytes, or null
 * @property {(name: string, bytes: Uint8Array) => Promise<string>} stage  → the staged VM path
 */

/** @param {string} s */
const SAFE = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
// Download concurrency / peak-memory bound: stage each batch before fetching the
// next, so a large dep tree doesn't pull hundreds of tarballs at once.
const DOWNLOAD_BATCH = 8;

/**
 * A resolved package from any of the three planners. Fields are a union of the
 * npm/pip/gem resolved shapes; a given manager's urlOf/fnameOf reads only the
 * ones its planner populates.
 * @typedef {{ name: string, version: string, tarball?: string, url?: string, filename?: string }} ResolvedPackage
 */
/**
 * @typedef {Object} PkgManager
 * @property {string} tool
 * @property {string} label
 * @property {(n: string) => string} registryUrl
 * @property {(p: ResolvedPackage) => string} urlOf
 * @property {(p: ResolvedPackage) => string} fnameOf
 * @property {(specs: string[], getDoc: (name: string) => Promise<any>, params: any) => Promise<ResolvedPackage[]>} resolve
 */

/**
 * Per-manager config — only the registry URL, label, download URL, staged
 * filename, and resolver differ. `resolve(specs, getDoc, params)` returns the
 * flat plan; `params` carries pip's pyTags.
 * @type {Record<string, PkgManager>}
 */
const PKG_MANAGERS = {
  'npm-install': {
    tool: 'peerd-npm', label: 'registry',
    registryUrl: (n) => `https://registry.npmjs.org/${n.replaceAll('/', '%2f')}`,
    // why: tarball/url/filename are optional on the union shape but the manager's
    // own planner always populates the field it reads — cast, no value change.
    urlOf: (p) => /** @type {string} */ (p.tarball),
    fnameOf: (p) => `${SAFE(p.name)}-${SAFE(p.version)}.tgz`,
    resolve: (specs, getDoc) => npmResolveTree(specs, getDoc),
  },
  'pip-install': {
    tool: 'peerd-pip', label: 'pypi',
    registryUrl: (n) => `https://pypi.org/pypi/${n}/json`,
    urlOf: (p) => /** @type {string} */ (p.url),
    fnameOf: (p) => SAFE(/** @type {string} */ (p.filename)),
    resolve: (specs, getDoc, params) => pipResolveTree(specs, getDoc, { pyTags: Array.isArray(params.pyTags) ? params.pyTags : [] }),
  },
  'gem-install': {
    tool: 'peerd-gem', label: 'rubygems',
    registryUrl: (n) => `https://rubygems.org/api/v1/gems/${n}.json`,
    urlOf: (p) => /** @type {string} */ (p.url),
    fnameOf: (p) => SAFE(/** @type {string} */ (p.filename)),
    resolve: (specs, getDoc) => gemResolveTree(specs, getDoc),
  },
};

/**
 * Extract the op name from a peerd:// URL (hostname, or first path segment).
 * @param {string} url @returns {string}
 */
export const parseControlOp = (url) => {
  try { const u = new URL(url); return u.hostname || u.pathname.replace(/^\/+/, ''); }
  catch { return ''; }
};

/**
 * @param {{ body: string|null }} request
 * @returns {any} why: parsed JSON from the VM's base64 body — untyped wire payload
 */
const decodeParams = (request) => {
  // UTF-8-safe base64 decode (parity with http-bridge's b64decodeUtf8): bare
  // atob is Latin-1, so a non-ASCII pkg name or clone URL would corrupt. The
  // body is base64'd JSON emitted by the bash wrapper.
  try { return JSON.parse(request.body ? decodeURIComponent(escape(atob(request.body))) : '{}'); }
  catch { return null; }
};

/**
 * @param {string} op  one of the pkg-install op names (key of PKG_MANAGERS)
 * @param {any} params  decoded VM request params (untyped wire payload)
 * @param {ControlOpIo} io
 * @returns {Promise<{ bodyBytes: Uint8Array, meta: object } | { errMsg: string }>}
 */
const runPkgInstall = async (op, params, io) => {
  const mgr = PKG_MANAGERS[op];
  const specs = Array.isArray(params.packages) ? params.packages.filter(Boolean) : [];
  if (!specs.length) return { errMsg: 'peerd: no packages to install\n' };
  try {
    const getDoc = async (/** @type {string} */ name) => {
      const json = await io.fetchJson(mgr.registryUrl(name));
      if (!json) throw new Error(`${mgr.label} fetch failed for ${name}`);
      return json;
    };
    const plan = await mgr.resolve(specs, getDoc, params);
    const manifest = [];
    for (let i = 0; i < plan.length; i += DOWNLOAD_BATCH) {
      const fetched = await Promise.all(plan.slice(i, i + DOWNLOAD_BATCH).map(async (p) => {
        const bytes = await io.fetchBytes(mgr.urlOf(p));
        if (!bytes) throw new Error(`download failed for ${p.name}@${p.version}`);
        return { p, bytes };
      }));
      for (const { p, bytes } of fetched) {
        const file = await io.stage(mgr.fnameOf(p), bytes);
        manifest.push(`${p.name}\t${p.version}\t${file}`);
      }
    }
    // TSV (name\tversion\tpath) so the bash shim parses with read -r, no jq.
    return {
      bodyBytes: new TextEncoder().encode(`${manifest.join('\n')}\n`),
      meta: { status: 200, statusText: 'OK', headers: { 'x-peerd-op': op } },
    };
  } catch (e) {
    return { errMsg: `${mgr.tool}: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}\n` };
  }
};

/**
 * @param {any} params  decoded VM clone request (untyped wire payload)
 * @param {ControlOpIo} io
 * @returns {Promise<{ bodyBytes: Uint8Array, meta: object } | { errMsg: string }>}
 */
const runGitClone = async (params, io) => {
  const parsed = parseRepoUrl(params.url ?? '');
  if (!parsed) return { errMsg: `peerd-git: not a clone URL: ${params.url}\n` };

  // Resolve the ref: explicit wins; else probe the host's default-branch API;
  // else fall through to the main/master candidates. Auth rides every git fetch.
  let ref = params.ref || null;
  if (!ref) {
    const probe = defaultBranchProbe(parsed);
    if (probe) {
      try {
        const json = await io.fetchJson(probe.url, { auth: 'git' });
        const resolved = json ? probe.jsonPath.reduce((o, k) => o?.[k], json) : null;
        // Only trust a STRING branch name — a hostile/buggy forge could return
        // an object here, which must not flow into the archive URL builder.
        if (typeof resolved === 'string' && resolved) ref = resolved;
      } catch { /* fall through to main/master */ }
    }
  }
  for (const cand of archiveCandidates(parsed, ref)) {
    try {
      const bytes = await io.fetchBytes(cand.url, { auth: 'git' });
      if (bytes) {
        return {
          bodyBytes: bytes,
          meta: { status: 200, statusText: 'OK',
            headers: { 'x-peerd-clone-ref': ref || cand.note, 'x-peerd-clone-url': cand.url } },
        };
      }
    } catch { /* try the next candidate */ }
  }
  return { errMsg: `peerd-git: no archive found for ${parsed.path} (ref ${ref || 'main/master'})\n` };
};

/**
 * Run a peerd:// control op. IO injected (see module header).
 * @param {{ url: string, body: string|null }} request the decoded VM request
 * @param {ControlOpIo} io
 * @returns {Promise<{ bodyBytes: Uint8Array, meta: object } | { errMsg: string }>}
 */
export const runControlOp = async (request, io) => {
  const op = parseControlOp(request.url);
  if (op === 'npm-install' || op === 'pip-install' || op === 'gem-install') {
    const params = decodeParams(request);
    if (!params) return { errMsg: `peerd: malformed ${op} request\n` };
    return runPkgInstall(op, params, io);
  }
  if (op === 'git-clone') {
    const params = decodeParams(request);
    if (!params) return { errMsg: 'peerd-git: malformed clone request\n' };
    return runGitClone(params, io);
  }
  return { errMsg: `peerd: unknown control op '${op}'\n` };
};
