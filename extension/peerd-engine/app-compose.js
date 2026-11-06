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
  // why: Minified exports often leave the src value unquoted (src=game.js).
  const SCRIPT_RE = /<script\b([^>]*?)\bsrc\s*=\s*(?:(['"])([^'"]+)\2|([^\s'"<>=`]+))([^>]*?)>(\s*)<\/script>/gi;
  composed = composed.replace(SCRIPT_RE, (full, beforeSrc, _q, quotedSrc, bareSrc, afterSrc) => {
    const src = quotedSrc ?? bareSrc;
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

  return injectAtDocumentStart(composed, appFileServerScript(entry));
};

// The runner puts the bytes of every App file on this Window property just
// before it writes the App document. The file server takes them and deletes it.
export const APP_FILES_HANDOFF = '__peerdAppFiles';

const APP_FILE_TYPES = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
  mjs: 'text/javascript', json: 'application/json', txt: 'text/plain', csv: 'text/csv',
  xml: 'application/xml', svg: 'image/svg+xml', wasm: 'application/wasm',
  data: 'application/octet-stream', pck: 'application/octet-stream',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
};

/**
 * Answer fetch and XMLHttpRequest reads of the App's own files from memory.
 * why: Game loaders fetch their .wasm and .data files by URL, and the sandbox
 * CSP refuses every connection. Any path at the runner's origin is answered
 * here, with a 404 when it is not an App file, so the native call never reads
 * packaged extension files. Other URLs keep the native call, which the CSP
 * blocks. This server never asks the parent for a file. composeApp serializes
 * it into the App document, so it must not use anything outside its body.
 *
 * @param {Window & typeof globalThis} scope
 * @param {string} entry
 * @param {Record<string, string>} types
 * @param {string} handoff
 */
export function serveAppFiles(scope, entry, types, handoff) {
  'use strict';
  /** @type {Record<string, ArrayBuffer>} */
  const files = Object.create(null);
  const received = Reflect.get(scope, handoff);
  Reflect.deleteProperty(scope, handoff);
  if (received && typeof received === 'object') {
    for (const [path, bytes] of Object.entries(received)) {
      if (bytes instanceof ArrayBuffer) files[path] = bytes;
    }
  }
  const { Blob, DOMException, Event, ProgressEvent, Request, Response, TextDecoder, URL } = scope;
  const here = new URL(scope.location.href);
  const runnerDir = here.pathname.slice(0, here.pathname.lastIndexOf('/') + 1);
  const entryDir = entry.slice(0, entry.lastIndexOf('/') + 1);
  /** @param {string} path */
  const typeOf = (path) => {
    const dot = path.lastIndexOf('.');
    const extension = dot > path.lastIndexOf('/') ? path.slice(dot + 1).toLowerCase() : '';
    return Object.hasOwn(types, extension) ? types[extension] : 'application/octet-stream';
  };
  // undefined: not an App URL. path null: the runner's origin, but no App file.
  /** @param {unknown} input @returns {{ url: string, path: string | null } | undefined} */
  const resolve = (input) => {
    let url;
    try { url = new URL(input instanceof Request ? input.url : String(input), here); }
    catch { return undefined; }
    if (url.protocol !== here.protocol || url.host !== here.host) return undefined;
    url.hash = '';
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { return { url: url.href, path: null }; }
    const nearEntry = pathname.startsWith(runnerDir);
    const relative = nearEntry ? pathname.slice(runnerDir.length) : pathname.slice(1);
    for (const path of nearEntry ? [entryDir + relative, relative] : [relative]) {
      if (Object.hasOwn(files, path)) return { url: url.href, path };
    }
    return { url: url.href, path: null };
  };

  const nativeFetch = scope.fetch;
  /** @param {[RequestInfo | URL, RequestInit?]} args @returns {Promise<Response>} */
  const fetch = (...args) => {
    const found = resolve(args[0]);
    if (!found) return Reflect.apply(nativeFetch, scope, args);
    const { path } = found;
    return Promise.resolve(path === null
      ? new Response(null, { status: 404, statusText: 'Not Found' })
      : new Response(files[path], {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': typeOf(path), 'Content-Length': String(files[path].byteLength) },
      }));
  };
  Reflect.set(scope, 'fetch', fetch);

  const NativeRequest = scope.XMLHttpRequest;
  /**
   * @typedef {{ url: string, path: string | null, async: boolean, state: number,
   *   status: number, sent: boolean, timer: ReturnType<typeof setTimeout> | undefined,
   *   response?: unknown }} FileRequest
   */
  /** @type {WeakMap<XMLHttpRequest, FileRequest>} */
  const requests = new WeakMap();
  const invalidState = () => new DOMException('The object is in an invalid state.', 'InvalidStateError');
  /** @param {XMLHttpRequest} target @param {string} type @param {number} size */
  const progress = (target, type, size) => target.dispatchEvent(new ProgressEvent(type, {
    lengthComputable: true, loaded: size, total: size,
  }));
  /** @param {XMLHttpRequest} target @param {FileRequest} request @param {number} state */
  const enter = (target, request, state) => {
    request.state = state;
    target.dispatchEvent(new Event('readystatechange'));
    return requests.get(target) === request && request.state === state;
  };
  /** @param {FileRequest} request @param {XMLHttpRequestResponseType} type */
  const body = (request, type) => {
    if (request.state !== 4 || request.path === null) return type === '' || type === 'text' ? '' : null;
    if (!('response' in request)) {
      const bytes = files[request.path];
      if (type === 'arraybuffer') request.response = bytes.slice(0);
      else if (type === 'blob') request.response = new Blob([bytes], { type: typeOf(request.path) });
      else if (type === 'document') request.response = null;
      else {
        const text = new TextDecoder().decode(bytes);
        if (type !== 'json') request.response = text;
        else {
          try { request.response = JSON.parse(text); } catch { request.response = null; }
        }
      }
    }
    return request.response;
  };
  class AppFileRequest extends NativeRequest {
    /** @param {unknown[]} args */
    open(...args) {
      clearTimeout(requests.get(this)?.timer);
      requests.delete(this);
      const found = resolve(args[1]);
      if (!found) return Reflect.apply(NativeRequest.prototype.open, this, args);
      const request = {
        ...found, async: args.length < 3 || Boolean(args[2]),
        state: 0, status: 0, sent: false, timer: undefined,
      };
      requests.set(this, request);
      enter(this, request, 1);
    }

    /** @param {unknown[]} args */
    send(...args) {
      const request = requests.get(this);
      if (!request) return Reflect.apply(NativeRequest.prototype.send, this, args);
      if (request.state !== 1 || request.sent) throw invalidState();
      request.sent = true;
      const size = request.path === null ? 0 : files[request.path].byteLength;
      const finish = () => {
        request.status = request.path === null ? 404 : 200;
        if (!enter(this, request, 2) || !enter(this, request, 3)) return;
        progress(this, 'progress', size);
        if (requests.get(this) !== request || request.state !== 3) return;
        if (!enter(this, request, 4)) return;
        progress(this, 'load', size);
        progress(this, 'loadend', size);
      };
      progress(this, 'loadstart', 0);
      if (requests.get(this) !== request || request.state !== 1) return;
      if (request.async) request.timer = setTimeout(finish, 0);
      else finish();
    }

    abort() {
      const request = requests.get(this);
      if (!request) return NativeRequest.prototype.abort.call(this);
      clearTimeout(request.timer);
      const pending = request.sent && request.state < 4;
      request.path = null;
      request.status = 0;
      request.url = '';
      if (pending) {
        enter(this, request, 4);
        progress(this, 'abort', 0);
        progress(this, 'loadend', 0);
      }
      request.state = 0;
    }

    /** @param {unknown[]} args */
    setRequestHeader(...args) {
      const request = requests.get(this);
      if (!request) return Reflect.apply(NativeRequest.prototype.setRequestHeader, this, args);
      if (request.state !== 1 || request.sent) throw invalidState();
    }

    /** @param {string} name */
    getResponseHeader(name) {
      const request = requests.get(this);
      if (!request) return NativeRequest.prototype.getResponseHeader.call(this, name);
      if (request.state < 2 || request.path === null) return null;
      const header = String(name).toLowerCase();
      if (header === 'content-type') return typeOf(request.path);
      if (header === 'content-length') return String(files[request.path].byteLength);
      return null;
    }

    getAllResponseHeaders() {
      const request = requests.get(this);
      if (!request) return NativeRequest.prototype.getAllResponseHeaders.call(this);
      if (request.state < 2 || request.path === null) return '';
      return `content-length: ${files[request.path].byteLength}\r\ncontent-type: ${typeOf(request.path)}\r\n`;
    }
  }
  /** @param {string} name @param {(request: FileRequest, target: XMLHttpRequest) => unknown} read */
  const override = (name, read) => {
    const native = Object.getOwnPropertyDescriptor(NativeRequest.prototype, name)?.get;
    Object.defineProperty(AppFileRequest.prototype, name, {
      configurable: true,
      enumerable: true,
      get() {
        const request = requests.get(this);
        return request ? read(request, this) : native?.call(this);
      },
    });
  };
  override('readyState', (request) => request.state);
  override('status', (request) => request.status);
  override('statusText', (request) => (
    request.status === 200 ? 'OK' : request.status === 404 ? 'Not Found' : ''));
  override('responseURL', (request) => request.url);
  override('responseXML', () => null);
  override('response', (request, target) => body(request, target.responseType));
  override('responseText', (request, target) => {
    if (target.responseType !== '' && target.responseType !== 'text') throw invalidState();
    return body(request, target.responseType);
  });
  scope.XMLHttpRequest = AppFileRequest;
}

/** @param {string} entry */
const appFileServerScript = (entry) => {
  // Escape every '<' so no argument can end the script early.
  /** @param {unknown} value */
  const literal = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
  return '<script data-peerd-file-server>'
    + `(${serveAppFiles})(self,${literal(entry)},${literal(APP_FILE_TYPES)},${literal(APP_FILES_HANDOFF)});`
    + '</script>';
};

// why: The file server must run before any App script. A script before the
// first tag goes into an implied <head>, and a leading doctype keeps
// standards mode, so the App's own <html> and <head> markup still applies.
/**
 * @param {string} html
 * @param {string} snippet
 */
const injectAtDocumentStart = (html, snippet) => {
  const at = /^(?:\s|<!--[\s\S]*?-->)*(?:<!doctype[^>]*>)?/i.exec(html)?.[0].length ?? 0;
  return html.slice(0, at) + snippet + html.slice(at);
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
