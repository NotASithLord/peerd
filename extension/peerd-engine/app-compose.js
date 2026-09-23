// @ts-check
// Compose an App file map into one sandbox document.
// Relative references use bundle files. Absolute references stay unchanged.
// why: The opaque runner can load only bundled, data, and blob resources.

import { escapeAttr } from '/shared/util.js';

const APP_DATA_PATH_RE = /^data\/[a-z0-9][a-z0-9._-]{0,63}\.json$/i;
/** why: Mutable App data must never become executable without consent rotation. @param {string} path */
const assertStaticSource = (path) => {
  if (APP_DATA_PATH_RE.test(path)) throw new Error(`app runtime data cannot be a composed source: ${path}`);
};

/** @param {Record<string,string>} files @param {string} [entry] @returns {string} */
export const composeApp = (files, entry = 'index.html') => {
  if (!(entry in files)) {
    throw new Error(`app entry not found: ${entry}`);
  }
  assertStaticSource(entry);
  const visited = new Set();

  // Inline <link rel="stylesheet" href="./...">  → <style>…</style>
  const LINK_RE = /<link\b([^>]*?)\brel\s*=\s*['"]stylesheet['"]([^>]*)>/gi;
  let composed = files[entry].replace(LINK_RE, (full, before, after) => {
    const attrs = before + after;
    const hrefMatch = /\bhref\s*=\s*(['"])([^'"]+)\1/.exec(attrs);
    if (!hrefMatch) return full;
    const href = hrefMatch[2];
    if (!isRelativeAndKnown(href, files, entry)) return full;
    const path = resolveRel(entry, href);
    assertStaticSource(path);
    visited.add(path);
    return `<style data-from="${escapeAttr(path)}">${files[path]}</style>`;
  });

  // Inline <script src="./..."></script>  → <script>…</script>
  // Capture the closing tag too so we don't leave a dangling </script>.
  const SCRIPT_RE = /<script\b([^>]*?)\bsrc\s*=\s*(['"])([^'"]+)\2([^>]*?)>(\s*)<\/script>/gi;
  composed = composed.replace(SCRIPT_RE, (full, beforeSrc, _q, src, afterSrc, inner) => {
    if (!isRelativeAndKnown(src, files, entry)) return full;
    const path = resolveRel(entry, src);
    assertStaticSource(path);
    visited.add(path);
    // Preserve type="module" etc. if present.
    const attrs = (`${beforeSrc} ${afterSrc}`).replace(/\bsrc\s*=\s*['"][^'"]*['"]/i, '').trim();
    const attrStr = attrs ? ` ${attrs}` : '';
    return `<script${attrStr} data-from="${escapeAttr(path)}">${files[path]}</script>`;
  });

  // why: The opaque runner needs an inlined blob for each literal worker path.
  composed = inlineWorkerFiles(composed, files, entry);

  return composed;
};

// why: Accept only known bundle paths and resolve them from the actual entry.
/** @param {string} ref @param {Record<string,string>} files @param {string} [entry] */
const isRelativeAndKnown = (ref, files, entry = 'index.html') =>
  isBundleRelative(ref) && resolveRel(entry, ref) in files;

// Reject absolute and in-document references.
/** @param {string} ref */
const isBundleRelative = (ref) =>
  !/^[a-z][a-z0-9+.-]*:/i.test(ref)
  && !ref.startsWith('//')
  && !ref.startsWith('#')
  && !ref.startsWith('?');

/**
 * @param {string} basePath
 * @param {string} relPath
 */
const resolveRel = (basePath, relPath) => {
  // basePath is the entry file (e.g. 'index.html' or 'pages/about.html')
  // relPath is './style.css' or '../shared/main.js'
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

// `new Worker('x')` / `new SharedWorker("x")` — capture the spec string.
const WORKER_REF_RE = /new\s+(?:Shared)?Worker\s*\(\s*(['"])([^'"]+)\1/g;

// Resolve a Worker spec to a bundled file. Liberal on purpose: the agent
// writes the spec bare ('worker.js') or relative ('./worker.js'); both should
// find the file. Returns the matching key in `files`, or null.
/**
 * @param {string} spec
 * @param {string} entry
 * @param {Record<string, string>} files
 * @returns {string | null}
 */
const workerFilePath = (spec, entry, files) => {
  for (const candidate of [spec, resolveRel(entry, spec), spec.replace(/^\.?\//, '')]) {
    if (candidate in files) return candidate;
  }
  return null;
};

// Embed the source of every file referenced by `new Worker('literal')` and
// inject a tiny shim that turns those specs into blob: workers at runtime.
// No-op (returns input unchanged) when the app uses no resolvable workers.
/**
 * @param {string} composed
 * @param {Record<string, string>} files
 * @param {string} entry
 */
const inlineWorkerFiles = (composed, files, entry) => {
  /** @type {Record<string, string>} */
  const srcBySpec = Object.create(null);
  WORKER_REF_RE.lastIndex = 0;
  let m;
  while ((m = WORKER_REF_RE.exec(composed))) {
    const spec = m[2];
    if (srcBySpec[spec] != null) continue;
    const path = workerFilePath(spec, entry, files);
    if (path) {
      assertStaticSource(path);
      srcBySpec[spec] = files[path];
    }
  }
  if (Object.keys(srcBySpec).length === 0) return composed;

  // Escape every '<' so an embedded '</script>' (or any tag) in a worker's
  // source can't break out of the shim's <script>. < parses back to '<'
  // inside the JS string literal, so the worker source is byte-identical.
  const lit = JSON.stringify(srcBySpec).replace(/</g, '\\u003c');
  // The shim overrides Worker so a known spec loads from an inlined blob; any
  // other spec passes straight through to the native constructor. Module
  // workers (type:'module') are passed through via opts — they work if the
  // worker is self-contained (a blob: base can't resolve relative imports).
  const shim = '<script data-peerd-worker-shim>(function(){'
    + `var S=${lit},N=self.Worker;if(!N)return;`
    + 'function W(u,o){'
    + 'if(Object.prototype.hasOwnProperty.call(S,u)){'
    + "u=URL.createObjectURL(new Blob([S[u]],{type:'application/javascript'}));}"
    + 'return new N(u,o);}'
    + 'W.prototype=N.prototype;self.Worker=W;'
    + '})();</script>';
  return injectAtHeadStart(composed, shim);
};

// Insert a snippet as the FIRST thing in <head> (so it runs before any app
// script that constructs a Worker); prepend if the doc is headless.
/**
 * @param {string} html
 * @param {string} snippet
 */
const injectAtHeadStart = (html, snippet) => {
  const m = /<head[^>]*>/i.exec(html);
  if (!m) return snippet + html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + snippet + html.slice(at);
};

/**
 * Strip <meta http-equiv="refresh"> — a DECLARATIVE self-navigation that
 * reloads the opaque-origin sandbox frame, the same hazard the runner's
 * trusted link broker and submit guard close for interactive controls. A reload
 * loses all app state AND tears down the dweb bridge, so in a dwapp a
 * meta-refresh is always a mistake (change screens by showing/hiding DOM).
 * why strip, not rewrite: there's nothing here worth preserving. Pure —
 * string in, string out; matches in any attribute order, self-closed or not.
 *
 * @param {string} html
 * @returns {string}
 */
export const stripMetaRefresh = (html) =>
  html.replace(/<meta\b[^>]*\bhttp-equiv\s*=\s*["']?\s*refresh\b[^>]*>/gi, '');
