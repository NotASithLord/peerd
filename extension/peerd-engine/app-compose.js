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

  return injectAtDocumentStart(composed, appFileServerScript(entry));
};

// The runner puts the bytes of every App file on this Window property just
// before it writes the App document. The file server takes them and deletes it.
export const APP_FILES_HANDOFF = '__peerdAppFiles';
// The file server fires this Window event when the App asks for a file it does
// not have. The runner reports it to the App tab without the path.
export const APP_FILE_MISSING_EVENT = 'peerd-app-file-missing';

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
 * @param {string} missingEvent
 * @param {RegExp} dataPath
 */
export function serveAppFiles(scope, entry, types, handoff, missingEvent, dataPath) {
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
  const missing = () => scope.dispatchEvent(new Event(missingEvent));

  const nativeFetch = scope.fetch;
  /** @param {[RequestInfo | URL, RequestInit?]} args @returns {Promise<Response>} */
  const fetch = (...args) => {
    const found = resolve(args[0]);
    if (!found) return Reflect.apply(nativeFetch, scope, args);
    const { path } = found;
    if (path === null) missing();
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
      if (request.path === null) missing();
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

  // why: Loaders also add scripts, start workers, and load audio worklets by
  // URL, and the browser loads those itself. Give it a blob: URL of the App
  // file. A missing file gets a revoked blob: URL, so the load fails the way a
  // 404 does and never reads a packaged extension file. An App data path gets
  // the same answer: fetch and XHR can read it, but peerd.data can rewrite it
  // with no new consent, so it never loads as code.
  /** @type {Record<string, string>} */
  const blobUrls = Object.create(null);
  let missingUrl = '';
  /** @param {unknown} input @returns {unknown} */
  const appUrl = (input) => {
    const found = resolve(input);
    if (!found) return input;
    const { path } = found;
    if (path === null || dataPath.test(path)) {
      missing();
      if (!missingUrl) {
        missingUrl = URL.createObjectURL(new Blob());
        URL.revokeObjectURL(missingUrl);
      }
      return missingUrl;
    }
    blobUrls[path] ??= URL.createObjectURL(new Blob([files[path]], { type: typeOf(path) }));
    return blobUrls[path];
  };
  const script = scope.HTMLScriptElement?.prototype;
  const src = script && Object.getOwnPropertyDescriptor(script, 'src');
  if (script && src?.set) {
    const nativeSet = src.set;
    const { setAttribute } = scope.Element.prototype;
    Object.defineProperty(script, 'src', {
      ...src,
      /** @param {unknown} value */
      set(value) { nativeSet.call(this, appUrl(value)); },
    });
    Object.defineProperty(script, 'setAttribute', {
      configurable: true,
      enumerable: true,
      writable: true,
      /** @param {string} name @param {unknown} value */
      value(name, value) {
        return Reflect.apply(setAttribute, this, [name, String(name).toLowerCase() === 'src' ? appUrl(value) : value]);
      },
    });
  }
  const NativeWorker = scope.Worker;
  if (typeof NativeWorker === 'function') {
    scope.Worker = class Worker extends NativeWorker {
      /** @param {string | URL} url @param {WorkerOptions} [options] */
      constructor(url, options) {
        super(/** @type {string} */ (appUrl(url)), options);
      }
    };
  }
  const worklet = scope.AudioWorklet?.prototype;
  if (worklet) {
    const { addModule } = worklet;
    Object.defineProperty(worklet, 'addModule', {
      configurable: true,
      enumerable: true,
      writable: true,
      /** @param {string | URL} url @param {WorkletOptions} [options] */
      value(url, options) { return Reflect.apply(addModule, this, [appUrl(url), options]); },
    });
  }
}

/**
 * Give the App a localStorage and a sessionStorage that hold values in page
 * memory, and remove window.caches.
 * why: In the opaque App frame a read of these three properties throws
 * SecurityError, and game engines read them with no try/catch. The stand-ins
 * never touch real browser storage or the parent, and nothing is saved: the
 * values go when the App closes. Without caches, an engine takes the path it
 * has for a page with no Cache API, which is also what a Worker of this frame
 * gets. indexedDB stays native: its read does not throw, and open() throws the
 * SecurityError that engines already handle. composeApp serializes this
 * function into the App document, so it must not use anything outside its body.
 *
 * @param {Window & typeof globalThis} scope
 */
export function keepAppStorageInMemory(scope) {
  'use strict';
  const memoryStorage = () => {
    /** @type {Map<string, string>} */
    const items = new Map();
    /** @type {Record<string, (...args: unknown[]) => unknown>} */
    const methods = {
      getItem: (key) => items.get(String(key)) ?? null,
      setItem: (key, value) => { items.set(String(key), String(value)); },
      removeItem: (key) => { items.delete(String(key)); },
      clear: () => items.clear(),
      key: (index) => [...items.keys()][Number(index)] ?? null,
    };
    // why a Proxy: engines also read and write keys as properties (storage[key]).
    const storage = new Proxy(Object.create(scope.Storage?.prototype ?? Object.prototype), {
      get: (target, name) => (typeof name !== 'string' ? Reflect.get(target, name)
        : name === 'length' ? items.size
          : Object.hasOwn(methods, name) ? methods[name]
            : name in target ? Reflect.get(target, name) : items.get(name)),
      set: (_target, name, value) => { items.set(String(name), String(value)); return true; },
      has: (target, name) => name in target || items.has(/** @type {string} */ (name)),
      deleteProperty: (_target, name) => items.delete(/** @type {string} */ (name)) || true,
      ownKeys: () => [...items.keys()],
      getOwnPropertyDescriptor: (_target, name) => (typeof name === 'string' && items.has(name)
        ? { value: items.get(name), writable: true, enumerable: true, configurable: true } : undefined),
    });
    return { configurable: true, enumerable: true, get: () => storage };
  };
  Object.defineProperty(scope, 'localStorage', memoryStorage());
  Object.defineProperty(scope, 'sessionStorage', memoryStorage());
  Reflect.deleteProperty(scope, 'caches');
}

/** @param {string} entry */
const appFileServerScript = (entry) => {
  // Escape every '<' so no argument can end the script early.
  /** @param {unknown} value */
  const literal = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
  return '<script data-peerd-file-server>'
    + `(${serveAppFiles})(self,${literal(entry)},${literal(APP_FILE_TYPES)},${literal(APP_FILES_HANDOFF)},`
    + `${literal(APP_FILE_MISSING_EVENT)},${APP_DATA_PATH_RE});`
    + `(${keepAppStorageInMemory})(self);`
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
