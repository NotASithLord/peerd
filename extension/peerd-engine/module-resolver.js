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
// CDN URLs / bare specifiers pass through untouched. The worker's
// native module loader fetches them directly — bypassing peerd-egress.
// Documented limitation.

/**
 * @typedef {{
 *   readFile: (path: string) => Promise<string>,
 *   makeBlobUrl: (source: string) => string,
 *   log?: (entry: { type: string, path: string, blobUrl?: string, error?: string }) => void,
 *   builtins?: Record<string, string>,
 * }} ResolverDeps
 *
 * `builtins` maps a bare specifier to a URL the worker can import natively —
 * e.g. { 'peerd:std': 'chrome-extension://…/notebook-std.js' }. A matching
 * STATIC import is rewritten to that URL (so `import { table } from 'peerd:std'`
 * loads the real module); other bare specifiers still pass through untouched.
 */

/** @typedef {{ blobUrl: string, source: string }} ModuleEntry */

/**
 * Resolve a relative path against a base file's directory.
 * 'utils.js' + './nested.js' → 'nested.js'
 * 'lib/foo.js' + './bar.js'  → 'lib/bar.js'
 * 'lib/foo.js' + '../baz.js' → 'baz.js'
 *
 * @param {string} basePath
 * @param {string} relPath
 */
export const resolveRelativePath = (basePath, relPath) => {
  if (!relPath.startsWith('.')) return relPath;
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
const STATIC_IMPORT_RE =
  /(import\s+(?:[\w$,*{}\s\n]+?\s+from\s+)?|export\s+(?:\*|\{[\s\S]*?\})\s+from\s+)(['"])([^'"]+)\2/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

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
  // why cast: cache.has() guards presence but doesn't narrow get()'s return.
  if (cache.has(path)) return /** @type {ModuleEntry} */ (cache.get(path));
  if (visited.has(path)) {
    // We're inside a cycle and the module hasn't finished resolving
    // yet. Return null source -- the partial fix-up below stops the
    // worker from receiving a half-baked blob.
    throw new Error(`circular import: ${path}`);
  }
  visited.add(path);

  let source;
  try { source = await deps.readFile(path); }
  catch (e) {
    const msg = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
    deps.log?.({ type: 'resolve-failed', path, error: msg });
    throw new Error(`cannot resolve './${path}': ${msg}`);
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
    if (match.path.startsWith('.')) {
      const resolved = resolveRelativePath(fromPath, match.path);
      const sub = await buildModule(resolved, deps, cache, new Set(visited));
      staticReplacements.push({ match, blobUrl: sub.blobUrl });
    } else if (deps.builtins?.[match.path]) {
      // bare builtin (peerd:std) → its native URL; nested modules can import it too.
      staticReplacements.push({ match, blobUrl: deps.builtins[match.path] });
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
    // relative → resolve against fromPath; bare/CDN → unchanged. The host helper
    // re-blobs OPFS-resolved relatives in the worker realm. (A bare/CDN dynamic
    // import still routes through the helper and only works if it names an OPFS
    // file — a pre-existing limitation, separate from builtins.)
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
    }
    importsBlock += `${stmt}\n`;
  }

  let body = code;
  const ranges = matches.map((mm) => [mm.start, mm.end]).sort((a, b) => b[0] - a[0]);
  for (const [start, end] of ranges) {
    body = body.slice(0, start) + body.slice(end);
  }
  return { imports: importsBlock, body };
};
