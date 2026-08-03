// @ts-check
// notebook-neutralizers.js — the REALM SEAL for the Notebook worker.
//
// The js_notebook worker runs agent-authored code. This module makes the
// audited postMessage fetch bridge (peerd.egress.fetch / global fetch) the ONLY
// network egress reachable from that realm:
//
//   1. `fetch` itself IS the bridge. The native fetch is deleted from the
//      whole prototype chain (worker globals inherit it from
//      WorkerGlobalScope.prototype, so an own-property shim alone leaves
//      the native recoverable via Object.getPrototypeOf), and the bridge
//      is pinned as a non-configurable, non-writable own property.
//   2. Every other network-capable primitive is hard-blocked the same
//      way: XMLHttpRequest, WebSocket, WebSocketStream, EventSource,
//      WebTransport, navigator.sendBeacon, importScripts (a classic-
//      worker loader, dead in module workers, sealed anyway), and the
//      nested Worker / SharedWorker constructors — a nested worker is a
//      FRESH realm with un-sealed natives, so it must not exist at all.
//   3. The seal runs as the worker entry's FIRST static import (notebook-tab.js
//      emits `import "<seal blob>"` ahead of the agent's imports). Module
//      graphs evaluate depth-first in declaration order, so the seal
//      executes before any agent module's top-level body — closing the
//      old gap where statically-imported agent code ran pre-stub.
//
// What this still is NOT: the outermost fence. The host page's CSP
// (notebook-tab/index.html, connect-src 'none') backstops the seal in the
// Notebook TAB — inherited by the blob worker, so even a fresh realm there
// can't leave. But the SAME sealed worker also runs HEADLESS in the offscreen
// document (offscreen/job-runner.js, for script), whose CSP must allow https:
// (the voice model downloads there) — so in that host the realm seal is the
// ONLY fence. Every network-capable primitive must therefore be sealed by the
// realm itself, not deferred to the page CSP.
// Module loads are NOT an open channel: a remote (https:) import never
// reaches this realm's native loader — the HOST resolver fetches its source
// through the same audited relay as data fetches (module-resolver.js
// fetchRemote → sw/web-fetch: denylist + SSRF + audit) and hands the worker
// a same-realm blob, so the module graph the loader sees carries no
// third-party URLs. import() itself is syntax, not a global — nothing to
// seal here.
//
// One implementation, three callers: realm-seal.js (the worker entry's
// first static import — the production path), the bun unit tests (mock
// globals), and the in-browser tests (real worker realms). All import
// applyRealmSeal from here, so production and tests cannot drift.
/**
 * @param {any} global the worker (or mock) global scope to seal. why any: this
 *   reaches into arbitrary realm globals (fetch, Worker, navigator, …) and
 *   deletes/redefines them — the operation is type-erased by design.
 */
export function applyRealmSeal(global) {
  // why a named subclass: convention (CLAUDE.md) — and it lets notebook
  // code (and our tests) distinguish "the notebook blocked this" from a
  // genuine platform error.
  class NotebookEgressBlockedError extends Error {
    /** @param {string} channel */
    constructor(channel) {
      super(`${channel} is disabled in the peerd Notebook. Use peerd.egress.fetch(url) for audited network access.`);
      this.name = 'NotebookEgressBlockedError';
      /** @type {string} */
      this.channel = channel;
    }
  }
  /** @param {string} channel @returns {never} */
  const fail = (channel) => { throw new NotebookEgressBlockedError(channel); };

  // Remove every reachable copy of `name` (own + whole prototype chain),
  // then pin `value` as a non-configurable, non-writable own property.
  // why delete-then-define: defineProperty alone only SHADOWS a prototype
  // method — `WorkerGlobalScope.prototype.fetch.call(self, url)` would
  // still reach the native. Deleting the (configurable) prototype slot
  // makes the native unreachable for good: no fresh copy exists in this
  // realm, and fresh realms are sealed off (Worker/importScripts below).
  /** @param {any} target @param {string} name @param {any} value */
  const seal = (target, name, value) => {
    for (let o = target; o; o = Object.getPrototypeOf(o)) {
      const desc = Object.getOwnPropertyDescriptor(o, name);
      if (desc && desc.configurable) {
        try { delete o[name]; } catch { /* strict-mode delete can throw; keep walking */ }
      }
    }
    try {
      Object.defineProperty(target, name, {
        value, writable: false, configurable: false, enumerable: false,
      });
    } catch {
      // Last resort (hostile pre-state, e.g. an existing non-configurable
      // accessor): plain assignment. The CSP backstop covers this path.
      try { target[name] = value; } catch { /* nothing left to do */ }
    }
  };

  // --- the ONLY sanctioned egress: fetch bridged over postMessage -------
  // The host page relays fetch-request → SW webFetch (SSRF block +
  // denylist + audit) and posts fetch-response back. Closure state is
  // unreachable from notebook code; notebook code posting its own
  // fetch-request messages is equivalent to calling peerd.egress.fetch — same
  // audited path, so that is not a bypass.
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void, timer: ReturnType<typeof setTimeout> }>} */
  const pending = new Map();
  let nextRid = 1;
  /** @param {any} input @param {any} [init] why any: stands in for the fetch Request/init shapes the bridge accepts (string url, {url}, RequestInit-ish). */
  const bridgedFetch = (input, init) => {
    const url = typeof input === 'string' ? input : input && input.url;
    if (!url) return Promise.reject(new TypeError('fetch: url required'));
    // why method/headers/body now ride the bridge: full HTTP from inside a
    // Notebook script ("code mode") at parity with the fetch_url tool — same
    // host-side webFetch (SSRF block + denylist + audit) governs every method,
    // so a POST here is the SAME egress surface, not a new one. Body must be a
    // string (JSON/text); a stream/Blob can't cross postMessage, which keeps the
    // bridge small. Headers normalize to a plain object.
    const opts = init || (typeof input === 'object' && input) || {};
    const method = typeof opts.method === 'string' ? opts.method.toUpperCase() : 'GET';
    /** @type {Record<string, string> | undefined} */
    let headers;
    if (opts.headers) {
      /** @type {Record<string, string>} */
      const h = {};
      if (typeof opts.headers.forEach === 'function') {
        opts.headers.forEach((/** @type {string} */ v, /** @type {string} */ k) => { h[k] = v; });
      } else for (const k of Object.keys(opts.headers)) h[k] = opts.headers[k];
      headers = h;
    }
    const body = opts.body == null ? undefined
      : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    // Design 2a extract step — why + security posture: shared/fetch-extract.js.
    // Only the one shipped mode crosses the bridge; anything else stays inert
    // (today's raw behavior, byte-for-byte).
    const extract = opts.extract === 'markdown' ? 'markdown' : undefined;
    return new Promise((resolve, reject) => {
      const rid = nextRid++;
      // why a timeout: a dropped host relay must not strand the eval —
      // the worker has no other way to observe the host going away.
      const timer = setTimeout(() => {
        if (pending.has(rid)) {
          pending.delete(rid);
          reject(new Error(`fetch ${url} timed out`));
        }
      }, 30000);
      pending.set(rid, { resolve, reject, timer });
      global.postMessage({ type: 'fetch-request', rid, url, method, headers, body, ...(extract ? { extract } : {}) });
    });
  };
  global.addEventListener('message', (/** @type {MessageEvent} */ ev) => {
    const m = ev && ev.data;
    if (!m || typeof m !== 'object' || m.type !== 'fetch-response') return;
    const p = pending.get(m.rid);
    if (!p) return;
    pending.delete(m.rid);
    clearTimeout(p.timer);
    if (!m.ok && m.error) { p.reject(new Error(`fetch failed: ${m.error}`)); return; }
    const bytes = m.bodyB64
      ? Uint8Array.from(atob(m.bodyB64), (c) => c.charCodeAt(0))
      : new Uint8Array();
    const headers = m.headers || {};
    // Design 2a markers: contentType reports what the bytes ARE ('text/markdown'
    // after extraction, the wire type otherwise); extracted says whether the
    // host's extraction actually ran, so code fanning out over mixed URLs can tell.
    let contentType = null;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-type') { contentType = headers[key]; break; }
    }
    p.resolve({
      ok: m.ok,
      status: m.status,
      statusText: m.statusText || '',
      headers,
      contentType,
      extracted: m.extracted === true,
      text: async () => new TextDecoder().decode(bytes),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      arrayBuffer: async () => bytes.buffer,
      // why a method: the platform's Response.bytes() is a function returning
      // Promise<Uint8Array>, and that's the shape a model reaches for. As a
      // data property it LISTS in Object.keys but `resp.bytes()` throws
      // "not a function" — observed burning several live agent turns.
      bytes: async () => bytes,
    });
  });
  seal(global, 'fetch', bridgedFetch);

  // --- hard-block every other network-capable primitive -----------------
  // why function expressions (not arrows): `new <arrow>` throws a generic
  // TypeError before the body runs; a function body runs under `new` and
  // throws OUR error, so both call and construct yield the actionable
  // message.
  for (const name of [
    'XMLHttpRequest',
    'WebSocket',
    'WebSocketStream',
    'EventSource',
    'WebTransport',
    'Worker',        // a nested worker would be a fresh, un-sealed realm
    'SharedWorker',  // not exposed in workers today; sealed for symmetry
  ]) {
    // why function, not arrow: these stand in for constructors (Worker,
    // SharedWorker, …). An arrow has no [[Construct]], so `new Worker()`
    // would throw "not a constructor" instead of OUR actionable error
    // (see the call-and-construct note above). prefer-arrow-callback is
    // off for this file in eslint.config.js for exactly this reason.
    seal(global, name, function () { fail(name); });
  }
  // importScripts already throws in module workers, but it lives on
  // WorkerGlobalScope.prototype — seal it so a future classic-worker
  // context (or a spec change) cannot resurrect a loader-shaped fetch.
  seal(global, 'importScripts', function () { fail('importScripts'); });
  if (global.navigator) {
    seal(global.navigator, 'sendBeacon', function () { fail('navigator.sendBeacon'); });
  }

  // The Cache API: cache.add()/addAll() run the Fetch algorithm — a REAL network
  // GET that escapes the audited bridge. The Notebook tab's connect-src 'none'
  // would fence it, but the offscreen script host that runs this SAME worker
  // allows https:, so the realm must block it directly. Replace the whole
  // CacheStorage with throwing stubs (open/match/has/delete/keys); the sandbox's
  // sanctioned storage is OPFS. seal() deletes the prototype getter the same way
  // it does for fetch, so the native CacheStorage is unreachable.
  const cacheBlocked = () => fail('Cache API (caches)');
  seal(global, 'caches', /** @type {any} */ ({
    open: cacheBlocked, match: cacheBlocked, has: cacheBlocked,
    delete: cacheBlocked, keys: cacheBlocked,
  }));
}
