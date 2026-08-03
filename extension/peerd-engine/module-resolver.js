// @ts-check
// peerd-engine/module-resolver.js
//
// Notebook import graph resolver. Pure functions only -- the host
// page (notebook-tab.js) injects the file-read function so this module
// works the same in the browser, in tests, and anywhere else we
// want to exercise the resolver.
//
// Three transformations we apply BEFORE handing source to the worker:
//
//   1. Static `import ... from './x.js'`
//      → import path replaced with a blob: URL of the (recursively
//        transformed) module.
//
//   2. Static `export ... from './x.js'`  (re-exports + star)
//      → same path replacement.
//
//   3. `import('./x.js')` (string-literal dynamic import)
//      → path replaced with the blob URL. The worker can still use
//        dynamic import for non-literal paths via peerd.self.import(path).
//
// Remote (https:) specifiers do NOT ride the worker's native loader: their
// source is fetched HOST-SIDE via the injected `fetchRemote` (the host's
// audited sw/web-fetch relay — denylist + SSRF + audit), recursively
// transformed with the module's own URL as the base, and re-blobbed exactly
// like a local file — so no third-party byte ever bypasses peerd-egress.
// Bare specifiers (`lodash`) still pass through untouched and fail in the
// worker's loader: a script wanting a library names a full URL and owns
// that choice, or the dependency gets vendored.

import {
  RemoteImportBlockedError,
  RemoteModuleCapError,
  RemoteModuleIntegrityError,
} from './errors.js';

/**
 * @typedef {{
 *   readFile: (path: string) => Promise<string>,
 *   makeBlobUrl: (source: string) => string,
 *   fetchRemote?: (url: string) => Promise<string>,
 *   log?: (entry: { type: string, path: string, blobUrl?: string, error?: string }) => void,
 *   builtins?: Record<string, string>,
 *   readToolboxModule?: (name: string) => Promise<string>,
 * }} ResolverDeps
 *
 * `builtins` maps a bare specifier to a URL the worker can import natively —
 * e.g. { 'peerd:std': 'chrome-extension://…/notebook-std.js' }. A matching
 * STATIC import is rewritten to that URL (so `import { table } from 'peerd:std'`
 * loads the real module); other bare specifiers still pass through untouched.
 *
 * `fetchRemote` fetches one remote module's SOURCE. Hosts must inject their
 * audited fetch (the sw/web-fetch relay) — and only in lanes that hold the
 * egress capability; when absent, an https import fails with
 * RemoteImportBlockedError ("this run has no network").
 *
 * `readToolboxModule` reads the body of a stored `peerd:toolbox/<name>` module
 * (design js-superpower/06). Deliberately OPTIONAL: the host injects it only on
 * the lanes allowed to resolve toolbox modules (script + notebook — the
 * own-compute lanes); its absence IS the lane refusal, so a job whose
 * capability profile promises "this code and nothing else" (a2a / site-client /
 * page_code) can never reach a stored module through the resolver.
 */

// The toolbox specifier family. A matched module resolves via the injected
// readToolboxModule and then transforms/blobs EXACTLY like a local OPFS module,
// so a toolbox module may itself import peerd:std or other toolbox modules
// (cycle detection below covers toolbox→toolbox loops too).
export const TOOLBOX_SPECIFIER_PREFIX = 'peerd:toolbox/';

/** @typedef {{ blobUrl: string, source: string }} ModuleEntry */

/**
 * True for an absolute http(s) specifier. why http too: routing it through
 * the audited fetch means egress POLICY refuses a cleartext load, instead of
 * the worker's native loader silently attempting it. why /i: URL schemes are
 * case-insensitive — `import 'HTTPS://…'` must ride the same audited path,
 * never slip through to the native loader as an unrecognized specifier.
 * @param {string} specifier
 */
export const isRemoteSpecifier = (specifier) => /^https?:\/\//i.test(specifier);

/**
 * Refuse a protocol-relative specifier ('//cdn.example/x.js'). why fail
 * closed: it is not matched by isRemoteSpecifier, so it would pass through
 * untouched and reach the worker's native loader — an unaudited near-miss of
 * the remote path. The author names the full https:// URL (and gets the
 * audited fetch), or nothing loads.
 * @param {string} specifier
 */
const rejectProtocolRelative = (specifier) => {
  if (specifier.startsWith('//')) {
    throw new RemoteImportBlockedError(specifier,
      'protocol-relative specifiers are not supported — name the full https:// URL');
  }
};

// Hostile-input rails for remote module source (third-party bytes by
// definition). why these numbers: the per-module ceiling matches the order of
// js_write_file's per-file cap (tools/defs/js-write-file.js MAX_CONTENT_CHARS)
// — "a module the agent could have written to OPFS" is the unit of scale; the
// per-run fetch count stays single-digit because a legitimate notebook
// dependency graph is shallow — a wider fan-out is an amplification vector
// and the dependency should be vendored instead.
export const REMOTE_MODULE_MAX_CHARS = 500_000;
export const REMOTE_MODULES_MAX_PER_RUN = 8;

// '…#sha256-<base64|base64url>' — an optional integrity pin on a remote
// specifier: hash the fetched source, refuse on mismatch. Makes a notebook
// reproducible (a silently-changed CDN file fails loud instead of running).
const REMOTE_PIN_RE = /^([^#]+)#sha256-([A-Za-z0-9+/_-]+=*)$/;

// Per-run remote-fetch counter, keyed by the run's cache map — the ONE object
// with per-run identity through both buildEntry and the hosts' compose-module
// (dynamic import) path. why not count cache keys: a deep remote chain fetches
// parents before they land in the cache, which would undercount in-flight
// modules and let a hostile graph overshoot the rail.
/** @type {WeakMap<Map<string, ModuleEntry>, number>} */
const remoteFetchCounts = new WeakMap();

/**
 * Resolve a relative path against a base file's directory.
 * 'utils.js' + './nested.js' → 'nested.js'
 * 'lib/foo.js' + './bar.js'  → 'lib/bar.js'
 * 'lib/foo.js' + '../baz.js' → 'baz.js'
 * A remote base resolves by URL: 'https://x/a/b.js' + './c.js' → 'https://x/a/c.js'
 *
 * @param {string} basePath
 * @param {string} relPath
 */
export const resolveRelativePath = (basePath, relPath) => {
  if (!relPath.startsWith('.')) return relPath;
  if (isRemoteSpecifier(basePath)) {
    // why URL resolution: a remote module's relative imports resolve against
    // ITS url (scheme/host/query semantics the path splitter below can't
    // model). new URL() also drops the base's fragment, so a #sha256 pin
    // never inherits into siblings — each remote module pins itself or not.
    return new URL(relPath, basePath).href;
  }
  const baseDir = basePath.includes('/')
    ? basePath.slice(0, basePath.lastIndexOf('/'))
    : '';
  const parts = (baseDir ? baseDir.split('/') : []).concat(
    relPath.split('/').filter((p) => p !== '.'),
  );
  const resolved = [];
  for (const p of parts) {
    if (p === '..') resolved.pop();
    else if (p) resolved.push(p);
  }
  return resolved.join('/');
};

// Path-in-statement matchers.
//   STATIC matches `import ... from '...'` and `export ... from '...'`
//     → path replaced with a host-realm blob URL.
//   DYNAMIC matches string-literal `import('./x.js')` calls
//     → ENTIRE call rewritten to __peerd_dynamic_import('<resolved>').
//   Why two passes: blob URLs are realm-scoped. Static imports of
//   host-realm blobs work from the worker (the worker was spawned
//   from one). Dynamic import() of a host-realm blob URL fails to
//   fetch -- it has to be re-blobbed in the worker realm. The runtime
//   helper does that.
//   NB (pre-existing): on the PACKAGED MV3 extension the worker realm's final
//   in-realm import() of its own worker-created blob is CSP-blocked today —
//   static blob imports work, dynamic ones do not. Not changed here.
const STATIC_IMPORT_RE =
  /(import\s+(?:[\w$,*{}\s\n]+?\s+from\s+)?|export\s+(?:\*|\{[\s\S]*?\})\s+from\s+)(['"])([^'"]+)\2/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

/**
 * Fetch (and integrity-check) one remote module's source through the
 * host-injected audited fetch, enforcing the per-run count and per-module
 * size rails. The pure module stays pure — all IO is `deps.fetchRemote`.
 *
 * @param {string} specifier  full import specifier (may carry a #sha256 pin)
 * @param {ResolverDeps} deps
 * @param {Map<string, ModuleEntry>} cache  the run's cache (its identity keys the fetch-count rail)
 * @returns {Promise<string>}
 */
const fetchRemoteSource = async (specifier, deps, cache) => {
  if (typeof deps.fetchRemote !== 'function') throw new RemoteImportBlockedError(specifier);
  const pin = REMOTE_PIN_RE.exec(specifier);
  // Fail CLOSED on a near-miss pin: any '#' fragment that isn't a well-formed
  // '#sha256-<base64>' would otherwise silently fetch UNPINNED — the exact
  // code the author believed was pinned. A fragment never reaches the server,
  // so there is no legitimate non-pin fragment to preserve. Checked before
  // the count rail: a refused specifier never fetches, so it spends no budget.
  if (!pin && specifier.includes('#')) {
    throw new RemoteImportBlockedError(specifier,
      "its '#' fragment is not a valid '#sha256-<base64>' integrity pin — fix the pin or drop the fragment");
  }
  const fetched = remoteFetchCounts.get(cache) ?? 0;
  if (fetched >= REMOTE_MODULES_MAX_PER_RUN) {
    throw new RemoteModuleCapError(specifier,
      `this run already fetched ${REMOTE_MODULES_MAX_PER_RUN} remote modules (the per-run cap) — vendor the dependency instead of widening the graph`);
  }
  remoteFetchCounts.set(cache, fetched + 1);
  const url = pin ? pin[1] : specifier;
  let source;
  try { source = await deps.fetchRemote(url); }
  catch (e) {
    const msg = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
    // generic wrap on purpose — same convention debt as the local-file
    // 'cannot resolve' branch; the named errors cover the policy refusals.
    throw new Error(`cannot fetch remote module '${url}': ${msg}`);
  }
  if (source.length > REMOTE_MODULE_MAX_CHARS) {
    throw new RemoteModuleCapError(specifier,
      `module is ${source.length} chars — over the ${REMOTE_MODULE_MAX_CHARS}-char per-module cap`);
  }
  if (pin) await verifyRemotePin(source, pin[2], url);
  return source;
};

/**
 * @param {string} source
 * @param {string} pin  the specifier's #sha256-<…> value (base64 or base64url)
 * @param {string} url
 */
const verifyRemotePin = async (source, pin, url) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  const actual = btoa(String.fromCharCode(...new Uint8Array(digest)));
  // why normalize: URL fragments often carry base64url; compare in standard
  // base64 with padding so both alphabets pin the same bytes.
  const stripped = pin.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const expected = stripped + '='.repeat((4 - (stripped.length % 4)) % 4);
  if (actual !== expected) throw new RemoteModuleIntegrityError(url, expected, actual);
};

/**
 * Build a host's `fetchRemote` from its sw/web-fetch transport. ONE decode +
 * error-shaping path for both hosts (notebook tab, offscreen job runner) so
 * the egress-critical surface can't diverge — the same reason worker-source.js
 * is shared. `noCache` rides every module fetch: the design forbids a
 * persistent module cache (stale third-party code silently pinned in IDB),
 * and a warm IDB hit would skip the denylist re-check + audit that the
 * audited-every-time story promises (vm-net/vm-http-fetch.js honors the flag).
 *
 * @param {(req: { url: string, method: 'GET', noCache: true }) => Promise<{ ok?: boolean, status?: number, error?: string, bodyB64?: string | null } | undefined>} sendWebFetch
 *   the host's transport to the SW sw/web-fetch route (denylist + SSRF + audit)
 * @returns {(url: string) => Promise<string>}
 */
export const makeFetchRemote = (sendWebFetch) => async (url) => {
  const resp = await sendWebFetch({ url, method: 'GET', noCache: true });
  if (!resp?.ok) throw new Error(resp?.error ?? `HTTP ${resp?.status ?? 0}`);
  const bytes = resp.bodyB64
    ? Uint8Array.from(atob(resp.bodyB64), (c) => c.charCodeAt(0))
    : new Uint8Array();
  return new TextDecoder().decode(bytes);
};

/**
 * Recursively builds the module graph rooted at `path`. Returns a
 * cache map (path → { blobUrl, source }) so the caller can revoke
 * the blob URLs after the worker is done.
 *
 * @param {string} path
 * @param {ResolverDeps} deps
 * @param {Map<string, ModuleEntry>} [cache]
 * @param {Set<string>} [visited]
 * @returns {Promise<ModuleEntry>}
 */
export const buildModule = async (path, deps, cache = new Map(), visited = new Set()) => {
  // Covers the runtime compose-module path too (a worker-supplied specifier).
  rejectProtocolRelative(path);
  // why cast: cache.has() guards presence but doesn't narrow get()'s return.
  if (cache.has(path)) return /** @type {ModuleEntry} */ (cache.get(path));
  if (visited.has(path)) {
    // We're inside a cycle and the module hasn't finished resolving
    // yet. Return null source -- the partial fix-up below stops the
    // worker from receiving a half-baked blob.
    throw new Error(`circular import: ${path}`);
  }
  visited.add(path);

  const isToolbox = path.startsWith(TOOLBOX_SPECIFIER_PREFIX);
  let source;
  if (isRemoteSpecifier(path)) {
    // Remote source rides the host's audited fetch and re-enters as a blob —
    // the worker's native loader never sees a third-party URL.
    try { source = await fetchRemoteSource(path, deps, cache); }
    catch (e) {
      const msg = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
      deps.log?.({ type: 'resolve-failed', path, error: msg });
      throw e;  // named errors carry their own actionable message — don't rewrap
    }
  } else {
    try {
      if (isToolbox) {
        // why the branch lives HERE (not in the callers): buildModule is the one
        // funnel every lane shares — entry statics, nested imports, AND the
        // runtime compose-module (dynamic import) path — so gating on the
        // injected dep covers all three at once.
        if (!deps.readToolboxModule) throw new Error('toolbox modules are not available in this run');
        source = await deps.readToolboxModule(path.slice(TOOLBOX_SPECIFIER_PREFIX.length));
      } else {
        source = await deps.readFile(path);
      }
    }
    catch (e) {
      const msg = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
      deps.log?.({ type: 'resolve-failed', path, error: msg });
      throw new Error(`cannot resolve '${isToolbox ? path : `./${path}`}': ${msg}`);
    }
  }

  // Recursively rewrite every relative path in this module's source.
  const transformed = await rewriteModuleSource(source, path, deps, cache, visited);
  const blobUrl = deps.makeBlobUrl(transformed);
  const entry = { blobUrl, source: transformed };
  cache.set(path, entry);
  deps.log?.({ type: 'resolved', path, blobUrl });
  return entry;
};

/**
 * Replace relative paths in `code` with blob URLs of recursively
 * resolved modules. Pure source transformation -- no IIFE wrapping,
 * no export stripping, just paths in statements.
 *
 * @param {string} code
 * @param {string} fromPath
 * @param {ResolverDeps} deps
 * @param {Map<string, ModuleEntry>} cache
 * @param {Set<string>} visited
 * @returns {Promise<string>}
 */
const rewriteModuleSource = async (code, fromPath, deps, cache, visited) => {
  // --- Phase 1: static imports + re-exports → host-realm blob URL ---
  /** @type {Array<{ pathStart: number, pathEnd: number, path: string }>} */
  const staticMatches = [];
  let m;
  STATIC_IMPORT_RE.lastIndex = 0;
  while ((m = STATIC_IMPORT_RE.exec(code)) !== null) {
    const pathStart = m.index + m[1].length + 1;     // +1 for opening quote
    staticMatches.push({ pathStart, pathEnd: pathStart + m[3].length, path: m[3] });
  }
  const staticReplacements = [];
  for (const match of staticMatches) {
    rejectProtocolRelative(match.path);
    if (match.path.startsWith('.')) {
      const resolved = resolveRelativePath(fromPath, match.path);
      const sub = await buildModule(resolved, deps, cache, new Set(visited));
      staticReplacements.push({ match, blobUrl: sub.blobUrl });
    } else if (deps.builtins?.[match.path]) {
      // bare builtin (peerd:std) → its native URL; nested modules can import it too.
      staticReplacements.push({ match, blobUrl: deps.builtins[match.path] });
    } else if (isRemoteSpecifier(match.path)) {
      // remote module → fetched host-side (audited), re-blobbed like a local file.
      const sub = await buildModule(match.path, deps, cache, new Set(visited));
      staticReplacements.push({ match, blobUrl: sub.blobUrl });
    } else if (match.path.startsWith(TOOLBOX_SPECIFIER_PREFIX)) {
      // toolbox module → resolved like a local file (recursion + cycle
      // detection), keyed in the cache by its full specifier.
      const sub = await buildModule(match.path, deps, cache, new Set(visited));
      staticReplacements.push({ match, blobUrl: sub.blobUrl });
    }
  }
  staticReplacements.sort((a, b) => b.match.pathStart - a.match.pathStart);
  let result = code;
  for (const { match, blobUrl } of staticReplacements) {
    result = result.slice(0, match.pathStart) + blobUrl + result.slice(match.pathEnd);
  }

  // --- Phase 2: dynamic import() → __peerd_dynamic_import('<resolved>') ---
  // Rescan because phase 1 changed substring positions.
  /** @type {Array<{ start: number, end: number, path: string }>} */
  const dynMatches = [];
  DYNAMIC_IMPORT_RE.lastIndex = 0;
  while ((m = DYNAMIC_IMPORT_RE.exec(result)) !== null) {
    dynMatches.push({ start: m.index, end: m.index + m[0].length, path: m[2] });
  }
  const dynReplacements = [];
  for (const match of dynMatches) {
    rejectProtocolRelative(match.path);
    if (deps.builtins?.[match.path]) {
      // builtin (peerd:std) → a NATIVE dynamic import of its URL, mirroring the
      // static path. import() of a same-origin URL works in the sealed worker
      // realm (the seal doesn't touch the module loader); routing it through
      // __peerd_dynamic_import would wrongly try to read it from OPFS.
      dynReplacements.push({
        match,
        replacement: `import(${JSON.stringify(deps.builtins[match.path])})`,
      });
      continue;
    }
    // relative → resolve against fromPath (URL-based when fromPath is remote);
    // bare/CDN → unchanged. The host helper composes OPFS files AND remote
    // (https:) modules alike — compose-module calls buildModule, which routes a
    // remote path through the audited fetchRemote — and the worker re-blobs the
    // returned source in its own realm. (A bare/CDN dynamic import still routes
    // through the helper and only works if it names an OPFS file — a pre-existing
    // limitation, separate from builtins. A toolbox specifier rides the same
    // helper: compose-module funnels back into buildModule, whose toolbox branch
    // resolves it.)
    const resolved = match.path.startsWith('.')
      ? resolveRelativePath(fromPath, match.path)
      : match.path;
    dynReplacements.push({
      match,
      replacement: `__peerd_dynamic_import(${JSON.stringify(resolved)})`,
    });
  }
  dynReplacements.sort((a, b) => b.match.start - a.match.start);
  for (const { match, replacement } of dynReplacements) {
    result = result.slice(0, match.start) + replacement + result.slice(match.end);
  }
  return result;
};

// ---------------------------------------------------------------------------
// Entry transformation (the file that's actually Run)
// ---------------------------------------------------------------------------
//
// Entry code goes inside an async IIFE the host adds for capturing the
// return value. ES modules forbid `import`/`export` inside function
// bodies, so we:
//   (a) extract top-level static imports/re-exports to module top
//   (b) STRIP `export` keywords (the entry is nobody's import target)
//   (c) rewrite static + dynamic import paths so the IIFE body still
//       has its inline `import('./...')` calls resolving correctly.

/**
 * @param {string} userCode
 * @param {string} entryPath
 * @param {ResolverDeps} deps
 */
export const buildEntry = async (userCode, entryPath, deps) => {
  const cache = new Map();

  // Pass 1: strip `export` keywords (entry-only — imported modules
  // keep their exports).
  const entry = stripExports(userCode);

  // Pass 2: extract top-level static imports + re-exports. Returns
  // the path-rewritten import block AND the entry body with those
  // statements excised.
  const { imports, body } = await extractTopLevelImports(entry, entryPath, deps, cache);

  // Pass 3: rewrite remaining import paths in the body. This catches
  // `import('./literal.js')` dynamic imports that didn't get pulled
  // out by the top-level extractor.
  const transformedBody = await rewriteModuleSource(body, entryPath, deps, cache, new Set());

  return { imports, body: transformedBody, cache };
};

/**
 * Strip `export` keywords from declarations. The entry runs inside
 * an async IIFE; `export` is only valid at module top level, so we
 * collapse `export const x = ...` → `const x = ...` etc.
 *
 * @param {string} code
 */
export const stripExports = (code) => code
  .replace(/^export\s+default\s+/gm, '')
  .replace(/^export\s*\{[\s\S]*?\}\s*(?:from\s*['"][^'"]*['"])?\s*;?/gm, '')
  .replace(/^export\s+\*\s+(?:as\s+\w+\s+)?from\s*['"][^'"]*['"]\s*;?/gm, '')
  .replace(/^export\s+(?=(?:const|let|var|function|class|async)\b)/gm, '');

// Limitation: each match is anchored to a line start, so TWO import statements
// on ONE physical line (`import a from 'x'; import b from 'y';`) only hoist the
// first — the second stays in the IIFE body and throws a syntax error. Keep
// top-level imports one-per-line. (Pre-existing; a one-statement multi-name
// import like `import { table, chart } from 'peerd:std'` is fine.)
const TOP_IMPORT_RE =
  /(?:^|\n)\s*(import\s+(?:[\w$,*{}\s\n]+?\s+from\s+)?(['"])([^'"]+)\2\s*;?)/g;

/**
 * @param {string} code
 * @param {string} entryPath
 * @param {ResolverDeps} deps
 * @param {Map<string, ModuleEntry>} cache
 */
const extractTopLevelImports = async (code, entryPath, deps, cache) => {
  /** @type {Array<{ start: number, end: number, stmt: string, quote: string, path: string }>} */
  const matches = [];
  let m;
  while ((m = TOP_IMPORT_RE.exec(code)) !== null) {
    const stmtStart = m.index + m[0].indexOf(m[1]);
    matches.push({
      start: stmtStart,
      end:   stmtStart + m[1].length,
      stmt:  m[1],
      quote: m[2],
      path:  m[3],
    });
  }

  let importsBlock = '';
  for (const match of matches) {
    rejectProtocolRelative(match.path);
    let stmt = match.stmt;
    if (match.path.startsWith('.')) {
      const resolved = resolveRelativePath(entryPath, match.path);
      const sub = await buildModule(resolved, deps, cache, new Set());
      stmt = stmt.replace(
        `${match.quote}${match.path}${match.quote}`,
        `${match.quote}${sub.blobUrl}${match.quote}`,
      );
    } else if (deps.builtins?.[match.path]) {
      // bare builtin (peerd:std) → its native URL, imported by the worker directly.
      stmt = stmt.replace(
        `${match.quote}${match.path}${match.quote}`,
        `${match.quote}${deps.builtins[match.path]}${match.quote}`,
      );
    } else if (isRemoteSpecifier(match.path)) {
      // remote module → fetched host-side (audited), imported as a blob.
      const sub = await buildModule(match.path, deps, cache, new Set());
      stmt = stmt.replace(
        `${match.quote}${match.path}${match.quote}`,
        `${match.quote}${sub.blobUrl}${match.quote}`,
      );
    } else if (match.path.startsWith(TOOLBOX_SPECIFIER_PREFIX)) {
      // toolbox module → resolved + blobbed like a local file (lane-gated by
      // the readToolboxModule dep — buildModule refuses when it's absent).
      const sub = await buildModule(match.path, deps, cache, new Set());
      stmt = stmt.replace(
        `${match.quote}${match.path}${match.quote}`,
        `${match.quote}${sub.blobUrl}${match.quote}`,
      );
    }
    importsBlock += `${stmt}\n`;
  }

  let body = code;
  const ranges = matches.map((mm) => [mm.start, mm.end]).sort((a, b) => b[0] - a[0]);
  for (const [start, end] of ranges) {
    // Preserve LINE POSITIONS: re-insert the removed statement's newlines as
    // blanks, so a body line number equals its user-code line number — that
    // equality is what lets a worker error's stack map back to
    // notebook.js:<line> (worker-source.js mapWorkerError). A single-line
    // import leaves an empty line; a multi-line import leaves as many.
    const removedNewlines = (body.slice(start, end).match(/\n/g) ?? []).length;
    body = body.slice(0, start) + '\n'.repeat(removedNewlines) + body.slice(end);
  }
  return { imports: importsBlock, body };
};
