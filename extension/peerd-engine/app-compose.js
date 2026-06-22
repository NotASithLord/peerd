// @ts-check
// peerd-engine/app-compose.js — turn a per-app file map into a single
// HTML document the sandboxed runner can document.write.
//
// Apps are multi-file (index.html + style.css + script.js + data.json
// + …) but the runner only takes a single HTML body. We inline the
// tag-relative referenced files at compose time:
//
//   <link rel="stylesheet" href="style.css">     →  <style>…</style>
//   <script src="script.js">…</script>           →  <script>…</script>
//   new Worker('worker.js')                      →  blob: worker (shim, see below)
//   <img src="./logo.png">                       →  (left as-is; v1 limit)
//   <a href="./other.html">                      →  (left as-is — nav)
//
// "tag-relative" is liberal on purpose: a bundle file resolves whether the
// agent writes it bare ('style.css'), dot-relative ('./style.css'),
// parent-relative ('../style.css'), or root-relative ('/style.css') — same
// latitude the Worker resolver already gives `new Worker('worker.js')`.
// Absolute URLs (scheme:), protocol-relative (//host), data: URIs, and
// pure #fragment / ?query refs pass through unchanged. They'll resolve via
// the iframe's normal fetch -- which may or may not succeed depending on
// what the agent wrote.
//
// Pure function, browser-free. Tested in Bun against a file map.

import { escapeAttr } from '/shared/util.js';

/**
 * Inline tag-relative <link rel="stylesheet"> and <script src> references
 * by reading from `files` and substituting the file's content.
 *
 * @param {Record<string, string>} files - path → content
 * @param {string} [entry='index.html']
 * @returns {string} composed HTML
 */
export const composeApp = (files, entry = 'index.html') => {
  if (!(entry in files)) {
    throw new Error(`app entry not found: ${entry}`);
  }
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
    visited.add(path);
    return `<style data-from="${escapeAttr(path)}">${files[path]}</style>`;
  });

  // Inline <script src="./..."></script>  → <script>…</script>
  // Capture the closing tag too so we don't leave a dangling </script>.
  const SCRIPT_RE = /<script\b([^>]*?)\bsrc\s*=\s*(['"])([^'"]+)\2([^>]*?)>(\s*)<\/script>/gi;
  composed = composed.replace(SCRIPT_RE, (full, beforeSrc, _q, src, afterSrc, inner) => {
    if (!isRelativeAndKnown(src, files, entry)) return full;
    const path = resolveRel(entry, src);
    visited.add(path);
    // Preserve type="module" etc. if present.
    const attrs = (`${beforeSrc} ${afterSrc}`).replace(/\bsrc\s*=\s*['"][^'"]*['"]/i, '').trim();
    const attrStr = attrs ? ` ${attrs}` : '';
    return `<script${attrStr} data-from="${escapeAttr(path)}">${files[path]}</script>`;
  });

  // Make `new Worker('worker.js')` Just Work. A Worker URL inside the opaque-
  // origin sandbox can't load by path (a chrome-extension:// or null-origin
  // worker script is blocked — "cannot be accessed from origin 'null'"); the
  // ONLY thing that loads is a same-origin blob: URL (the manifest sandbox CSP
  // allows worker-src blob:). So embed the referenced worker file's source and
  // shim Worker to build a blob URL from it at runtime (blob URLs only exist at
  // runtime). Precise: only files actually named in a `new Worker('literal')`
  // are embedded, so data/libs aren't bloated in. why a shim over telling the
  // agent to hand-roll a blob — it reaches for `new Worker('worker.js')`.
  composed = inlineWorkerFiles(composed, files, entry);

  return composed;
};

// ---------------------------------------------------------------------------

// A href/src is inlinable when it's a same-bundle relative reference AND it
// resolves to a file we actually hold. why two gates: `isBundleRelative`
// rejects things that are categorically NOT bundle files (CDN URLs, data:
// URIs, #fragments) so we don't misread them; the "resolves to a known file"
// guard is what makes accepting BARE paths ('style.css') safe — a CDN URL
// can't collide with a bundle key, so there's no need to demand a './' prefix.
// Resolution is anchored at the real `entry` (not a hardcoded 'index.html'),
// so a nested entry (pages/about.html) resolves its siblings correctly and the
// check agrees with the resolveRel() the caller uses to read the file.
/**
 * @param {string} ref
 * @param {Record<string, string>} files
 * @param {string} [entry]
 */
const isRelativeAndKnown = (ref, files, entry = 'index.html') =>
  isBundleRelative(ref) && resolveRel(entry, ref) in files;

// True unless `ref` is something that can't name a bundled file: an absolute
// URL with a scheme (https:, data:, mailto:, blob:…), a protocol-relative
// //host reference, or a pure in-document #fragment / ?query.
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
  const srcBySpec = {};
  WORKER_REF_RE.lastIndex = 0;
  let m;
  while ((m = WORKER_REF_RE.exec(composed))) {
    const spec = m[2];
    if (srcBySpec[spec] != null) continue;
    const path = workerFilePath(spec, entry, files);
    if (path) srcBySpec[spec] = files[path];
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
 * Make every link in a composed app open as a real top-level tab.
 *
 * why: apps run in a manifest-sandboxed iframe with an opaque origin.
 * A plain <a href> navigates the IFRAME ITSELF — and most real sites
 * (huggingface.co, github.com…) send frame-ancestors/X-Frame-Options
 * denials, so the click dead-ends on ERR_BLOCKED_BY_RESPONSE. The
 * sandbox is doing its job; the missing affordance is that outbound
 * links belong in a NEW TAB (Chrome's default sandbox CSP allows
 * popups and lets them escape the sandbox into a normal browsing
 * context). One <base target="_blank"> covers every link without
 * rewriting the app's markup; an app that ships its OWN <base> is
 * respected. Pure — string in, string out.
 *
 * @param {string} html  composed document
 * @returns {string}
 */
export const withNewTabLinks = (html) => {
  if (/<base\b/i.test(html)) return html;
  const BASE = '<base target="_blank">';
  // After <head…> when present; else before the first markup. Either
  // way the tag precedes every <a> the document can contain.
  const m = /<head[^>]*>/i.exec(html);
  if (m) {
    const at = m.index + m[0].length;
    return html.slice(0, at) + BASE + html.slice(at);
  }
  return BASE + html;
};

/**
 * Strip <meta http-equiv="refresh"> — a DECLARATIVE self-navigation that
 * reloads the opaque-origin sandbox frame, the same hazard withNewTabLinks
 * fixes for <a> and the runner's submit guard fixes for forms. A reload
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
