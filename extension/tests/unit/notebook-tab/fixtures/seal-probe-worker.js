// @ts-check
// Fixture worker for the realm-seal in-browser tests. Mirrors the
// production notebook-tab worker entry: the PRODUCTION seal module is the
// first static import, then everything below runs against the sealed
// realm. Driven by command messages from the test page, which also
// plays the host side of the fetch bridge.

import '/notebook-tab/realm-seal.js';

/**
 * The sealed realm replaces `fetch` with the audited Notebook bridge,
 * whose response is a plain object — `{ ok, status, statusText, headers,
 * text(), json() }` with `headers` a record (see notebook-neutralizers.js)
 * — NOT a native `Response`. Type the bridge result to that shape so the
 * probe can read `headers['content-type']` and call `text()`.
 *
 * @typedef {object} BridgeResponse
 * @property {boolean} ok
 * @property {number} status
 * @property {string} statusText
 * @property {Record<string, string>} headers
 * @property {() => Promise<string>} text
 * @property {() => Promise<unknown>} json
 */

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<BridgeResponse>}
 */
const bridgeFetch = (url, init) =>
  /** @type {Promise<BridgeResponse>} */ (
    /** @type {unknown} */ (globalThis.fetch(url, init))
  );

/** @param {() => void} fn */
const probe = (fn) => {
  try {
    fn();
    return { threw: false };
  } catch (e) {
    const err = /** @type {{ name?: string, message?: string }} */ (e);
    return { threw: true, name: err?.name ?? 'Error', message: String(err?.message ?? e) };
  }
};

// why globalThis.* everywhere: the probes must hit exactly what Notebook
// code would reach for; bare identifiers would also trip the lint rules
// that exist to keep raw fetch out of production code.
// why: the probe deliberately reaches for worker-only / experimental
// network globals that the project's lib.dom config doesn't declare
// (WebSocketStream is experimental; importScripts is the worker scope).
// Cast through a view that adds them so the seal probe can name what it
// tried to open.
const workerGlobal = /** @type {typeof globalThis & {
 *   WebSocketStream: new (url: string) => unknown,
 *   importScripts: (...urls: string[]) => void,
 * }} */ (globalThis);

const runProbes = () => ({
  XMLHttpRequest: probe(() => new workerGlobal.XMLHttpRequest()),
  WebSocket: probe(() => new workerGlobal.WebSocket('wss://example.invalid/')),
  WebSocketStream: probe(() => new workerGlobal.WebSocketStream('wss://example.invalid/')),
  EventSource: probe(() => new workerGlobal.EventSource('https://example.invalid/')),
  WebTransport: probe(() => new workerGlobal.WebTransport('https://example.invalid/')),
  Worker: probe(() => new workerGlobal.Worker('/nested.js')),
  SharedWorker: probe(() => new workerGlobal.SharedWorker('/nested.js')),
  importScripts: probe(() => workerGlobal.importScripts('https://example.invalid/x.js')),
  sendBeacon: probe(() => workerGlobal.navigator.sendBeacon('https://example.invalid/', 'x')),
  // caches.open(...).add(url) runs the Fetch algorithm — sealed because the
  // offscreen js_run host has no connect-src 'none' backstop.
  caches: probe(() => workerGlobal.caches.open('x')),
});

const inspectFetch = () => {
  // A truly sealed realm has NO copy of fetch anywhere above the global —
  // prototype recovery (Object.getPrototypeOf(self).fetch) must come up
  // empty — and the own slot must be pinned.
  let protoFetchFound = false;
  for (let o = Object.getPrototypeOf(globalThis); o; o = Object.getPrototypeOf(o)) {
    if (Object.getOwnPropertyDescriptor(o, 'fetch')) protoFetchFound = true;
  }
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  return {
    protoFetchFound,
    ownWritable: desc?.writable ?? null,
    ownConfigurable: desc?.configurable ?? null,
  };
};

const sabotage = () => {
  const sealed = globalThis.fetch;
  /** @type {Record<string, string>} */
  const attempts = {};
  // why: the sabotage probe tries to overwrite/delete the sealed fetch
  // bridge with hostile values the real type forbids — cast to a writable,
  // deletable view so the test can record that the seal rejects each move.
  const mutableGlobal = /** @type {{ fetch?: unknown }} */ (globalThis);
  try { mutableGlobal.fetch = () => 'evil'; attempts.assign = 'no-throw'; }
  catch (e) { attempts.assign = /** @type {{ name?: string }} */ (e)?.name ?? 'Error'; }
  try { delete mutableGlobal.fetch; attempts.del = 'no-throw'; }
  catch (e) { attempts.del = /** @type {{ name?: string }} */ (e)?.name ?? 'Error'; }
  try {
    Object.defineProperty(globalThis, 'fetch', { value: () => 'evil' });
    attempts.define = 'no-throw';
  } catch (e) { attempts.define = /** @type {{ name?: string }} */ (e)?.name ?? 'Error'; }
  return { attempts, stillSealed: globalThis.fetch === sealed };
};

self.addEventListener('message', async (ev) => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'run-probes') {
    postMessage({ type: 'probe-results', results: runProbes(), fetchInspection: inspectFetch() });
    return;
  }
  if (m.type === 'sabotage-then-fetch') {
    const result = sabotage();
    try {
      // Round-trip through the bridge AFTER the undo attempts: the test
      // page answers the fetch-request, proving the sanctioned path
      // still works post-sabotage.
      const resp = await bridgeFetch(m.url);
      postMessage({
        type: 'sabotage-result',
        ...result,
        fetch: { ok: resp.ok, status: resp.status, text: await resp.text() },
      });
    } catch (e) {
      const err = /** @type {{ message?: string }} */ (e);
      postMessage({ type: 'sabotage-result', ...result, fetch: { error: String(err?.message ?? e) } });
    }
    return;
  }
  if (m.type === 'post-fetch') {
    // Exercise the full-HTTP bridge (code mode): method/headers/body must reach
    // the host, and statusText/headers must come back.
    try {
      const resp = await bridgeFetch(m.url, { method: 'POST', headers: { 'X-Test': '1' }, body: 'hello' });
      postMessage({
        type: 'post-result',
        fetch: { ok: resp.ok, status: resp.status, statusText: resp.statusText, contentType: resp.headers['content-type'], text: await resp.text() },
      });
    } catch (e) {
      const err = /** @type {{ message?: string }} */ (e);
      postMessage({ type: 'post-result', fetch: { error: String(err?.message ?? e) } });
    }
    return;
  }
});

postMessage({ type: 'fixture-ready' });
