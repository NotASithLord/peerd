// @ts-check
// Realm seal, proven in a REAL worker realm — the thing the bun suite
// cannot do. Spawns module workers whose first static import is the
// PRODUCTION seal module (/notebook-tab/realm-seal.js), exactly like the
// worker entries notebook-tab.js assembles, and verifies:
//   - every raw network channel throws NotebookEgressBlockedError,
//   - the native fetch is gone from the actual prototype chain and the
//     bridge cannot be unseated from inside the realm,
//   - the bridged fetch still round-trips through the host relay
//     (the test page plays the notebook-tab host),
//   - the seal evaluates BEFORE a statically-imported module's top-level
//     body (the old pre-prologue gap),
//   - the page CSP second fence stays pinned at connect-src 'none'.

import { describe, it, expect } from '../../framework.js';

const FIXTURES = '/tests/unit/notebook-tab/fixtures';

// why file workers, not blobs: the CDP harness serves the runner over
// http, where the runner page CSP (script-src 'self') blocks blob-URL
// workers; same-origin file workers run identically on both the http
// harness and the extension origin. Evaluation-order semantics are the
// same either way — order comes from the module graph, not the URL kind.
/** @param {string} file */
const spawnFixture = (file) => new Worker(`${FIXTURES}/${file}`, { type: 'module' });

/**
 * Resolve the next worker message whose `data.type` matches. The payload is
 * an untyped postMessage bag (each fixture answers a different shape), so the
 * resolved value is genuinely dynamic.
 * @param {Worker} worker
 * @param {string} type
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
const nextMessage = (worker, type, timeoutMs = 10000) => new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`timed out waiting for worker message '${type}'`)), timeoutMs);
  /** @param {MessageEvent} ev */
  const onMessage = (ev) => {
    if (!ev.data || ev.data.type !== type) return;
    clearTimeout(timer);
    worker.removeEventListener('message', onMessage);
    resolve(ev.data);
  };
  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', (e) => {
    clearTimeout(timer);
    reject(new Error(`worker error: ${e.message || 'failed to load'}`));
  }, { once: true });
});

describe('notebook-tab realm seal (real worker realm)', () => {
  it('hard-blocks every raw network channel with NotebookEgressBlockedError', async () => {
    const worker = spawnFixture('seal-probe-worker.js');
    try {
      await nextMessage(worker, 'fixture-ready');
      const reply = nextMessage(worker, 'probe-results');
      worker.postMessage({ type: 'run-probes' });
      const { results } = await reply;
      for (const channel of [
        'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource',
        'WebTransport', 'Worker', 'SharedWorker', 'importScripts', 'sendBeacon',
        'caches',
      ]) {
        expect(results[channel].threw).toBe(true);
        expect(results[channel].name).toBe('NotebookEgressBlockedError');
        expect(results[channel].message).toContain('peerd.egress.fetch');
      }
    } finally { worker.terminate(); }
  });

  it('deletes the native fetch off the real prototype chain and pins the bridge', async () => {
    const worker = spawnFixture('seal-probe-worker.js');
    try {
      await nextMessage(worker, 'fixture-ready');
      const reply = nextMessage(worker, 'probe-results');
      worker.postMessage({ type: 'run-probes' });
      const { fetchInspection } = await reply;
      expect(fetchInspection.protoFetchFound).toBe(false);
      expect(fetchInspection.ownWritable).toBe(false);
      expect(fetchInspection.ownConfigurable).toBe(false);
    } finally { worker.terminate(); }
  });

  it('survives in-realm sabotage while the bridged fetch keeps working', async () => {
    const worker = spawnFixture('seal-probe-worker.js');
    try {
      await nextMessage(worker, 'fixture-ready');
      // Play the notebook-tab host: answer the bridge's fetch-request like the
      // SW relay would, so the round-trip proves the sanctioned path.
      worker.addEventListener('message', (ev) => {
        const m = ev.data;
        if (!m || m.type !== 'fetch-request') return;
        worker.postMessage({
          type: 'fetch-response', rid: m.rid,
          ok: true, status: 200, bodyB64: btoa('sealed-but-bridged'),
        });
      });
      const reply = nextMessage(worker, 'sabotage-result');
      worker.postMessage({ type: 'sabotage-then-fetch', url: 'https://api.example/ping' });
      const result = await reply;
      expect(result.stillSealed).toBe(true);
      // defineProperty on a non-configurable slot must throw (TypeError);
      // assignment/delete may silently no-op in sloppy realms — what
      // matters is stillSealed above.
      expect(result.attempts.define).toBe('TypeError');
      expect(result.fetch.ok).toBe(true);
      expect(result.fetch.status).toBe(200);
      expect(result.fetch.text).toBe('sealed-but-bridged');
    } finally { worker.terminate(); }
  });

  it('bridges full HTTP — method/headers/body out, statusText/headers back (code mode)', async () => {
    const worker = spawnFixture('seal-probe-worker.js');
    try {
      await nextMessage(worker, 'fixture-ready');
      /** @type {{ method?: string, headers?: Record<string, string>, body?: string } | null} */
      let captured = null;
      worker.addEventListener('message', (ev) => {
        const m = ev.data;
        if (!m || m.type !== 'fetch-request') return;
        captured = m;  // capture exactly what the bridge sent
        worker.postMessage({
          type: 'fetch-response', rid: m.rid,
          ok: true, status: 201, statusText: 'Created',
          headers: { 'content-type': 'application/json' },
          bodyB64: btoa('{"ok":true}'),
        });
      });
      const reply = nextMessage(worker, 'post-result');
      worker.postMessage({ type: 'post-fetch', url: 'https://api.example/things' });
      const result = await reply;
      // request: method/headers/body threaded through the bridge
      // why double-cast: `captured` is only assigned inside the message
      // listener, so TS narrows it to its initial `null` at this read; the
      // listener DID run (the post-result reply above proves it). Re-widen
      // through unknown to the request shape the bridge sent.
      const sent = /** @type {{ method?: string, headers: Record<string, string>, body?: string }} */ (
        /** @type {unknown} */ (captured));
      expect(sent.method).toBe('POST');
      expect(sent.headers['X-Test']).toBe('1');
      expect(sent.body).toBe('hello');
      // response: status/statusText/headers came back to the realm
      expect(result.fetch.status).toBe(201);
      expect(result.fetch.statusText).toBe('Created');
      expect(result.fetch.contentType).toBe('application/json');
      expect(result.fetch.text).toBe('{"ok":true}');
    } finally { worker.terminate(); }
  });

  it('seals BEFORE a statically-imported module body runs (the old prologue gap)', async () => {
    const worker = spawnFixture('seal-order-entry.js');
    try {
      const { result } = await nextMessage(worker, 'order-result');
      expect(result.webSocket.threw).toBe(true);
      expect(result.webSocket.name).toBe('NotebookEgressBlockedError');
      expect(result.webSocket.message).toContain('peerd.egress.fetch');
      expect(result.xhr.threw).toBe(true);
      expect(result.fetchIsBridge).toBe(true);
    } finally { worker.terminate(); }
  });

  it('keeps the notebook-tab page CSP second fence at connect-src none', async () => {
    // why bare fetch is acceptable here: this reads our own static page
    // source (extension origin / test web root) to pin the shipped CSP —
    // not a network egress (same rationale as loop/system-prompt.js).
    // eslint-disable-next-line no-restricted-globals
    const resp = await fetch('/notebook-tab/index.html');
    const html = await resp.text();
    const meta = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i);
    expect(meta?.[1]).toBe("connect-src 'none'");
  });
});
