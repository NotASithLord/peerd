// @ts-check
// Red-team, in-browser tier: sandbox escape proven in REAL realms, the thing
// the Bun scenario (tests/red-team/scenarios/06-sandbox-escape.ts) cannot do.
//
// Scenario 06 drives the production seal/compose functions against mock globals
// in Bun; this file re-frames the attack in an actual browser: a real module
// Worker running the PRODUCTION realm seal, and the shipped CSP + manifest
// sandbox fences that confine the App iframe. It complements the exhaustive
// mechanics in notebook-seal.test.js by asserting the adversary-facing invariants
// a red-team reviewer checks first.

import { describe, it, expect } from '../../framework.js';

const FIXTURES = '/tests/unit/engine-tabs/notebook-tab/fixtures';

/** @param {string} file */
const spawnFixture = (file) => new Worker(`${FIXTURES}/${file}`, { type: 'module' });

/**
 * @param {Worker} worker @param {string} type @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
const nextMessage = (worker, type, timeoutMs = 10000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out waiting for '${type}'`)), timeoutMs);
  /** @param {MessageEvent} ev */
  const onMessage = (ev) => {
    if (!ev.data || ev.data.type !== type) return;
    clearTimeout(timer);
    worker.removeEventListener('message', onMessage);
    resolve(ev.data);
  };
  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error(`worker error: ${e.message || 'load failed'}`)); }, { once: true });
});

describe('red-team: sandboxed code cannot escape a real Notebook worker realm', () => {
  it('every raw exfil / remote-code channel is dead in a real worker', async () => {
    const worker = spawnFixture('seal-probe-worker.js');
    try {
      await nextMessage(worker, 'fixture-ready');
      const reply = nextMessage(worker, 'probe-results');
      worker.postMessage({ type: 'run-probes' });
      const { results, fetchInspection } = await reply;
      // The adversary's toolbox: raw sockets, remote code, beacons, cache-fetch,
      // and minting a fresh un-sealed realm, all must throw the egress error.
      for (const channel of [
        'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource',
        'WebTransport', 'Worker', 'SharedWorker', 'importScripts', 'sendBeacon',
        'caches', 'rawOpfs',
      ]) {
        expect(results[channel].threw).toBe(true);
        expect(results[channel].name).toBe('NotebookEgressBlockedError');
      }
      expect(results.chromeAbsent).toBe(true);
      expect(results.browserAbsent).toBe(true);
      // The native fetch is unrecoverable off the prototype chain, and the bridge
      // slot is pinned so it can't be reassigned to an exfiltrating function.
      expect(fetchInspection.protoFetchFound).toBe(false);
      expect(fetchInspection.ownWritable).toBe(false);
      expect(fetchInspection.ownConfigurable).toBe(false);
    } finally { worker.terminate(); }
  });

  it('the sealed realm resists in-realm sabotage of the fetch bridge', async () => {
    const worker = spawnFixture('seal-probe-worker.js');
    try {
      await nextMessage(worker, 'fixture-ready');
      worker.addEventListener('message', (ev) => {
        const m = ev.data;
        if (!m || m.type !== 'fetch-request') return;
        worker.postMessage({ type: 'fetch-response', rid: m.rid, ok: true, status: 200, bodyB64: btoa('bridged') });
      });
      const reply = nextMessage(worker, 'sabotage-result');
      worker.postMessage({ type: 'sabotage-then-fetch', url: 'https://api.example/ping' });
      const result = await reply;
      expect(result.stillSealed).toBe(true);               // sabotage failed
      expect(result.attempts.define).toBe('TypeError');    // defineProperty on the pinned slot throws
      expect(result.fetch.ok).toBe(true);                  // the sanctioned bridge still works
    } finally { worker.terminate(); }
  });
});

describe('red-team: Pod jobs receive named capabilities, never extension authority', () => {
  it('blocks ambient fetch, raw OPFS, chrome/browser APIs, and keeps only the named fetch bridge', async () => {
    const worker = spawnFixture('pod-seal-probe-worker.js');
    try {
      const result = await nextMessage(worker, 'pod-seal-result');
      expect(result.globalFetch.threw).toBe(true);
      expect(result.globalFetch.name).toBe('PodEgressBlockedError');
      expect(result.rawOpfs.threw).toBe(true);
      expect(result.chromeAbsent).toBe(true);
      expect(result.browserAbsent).toBe(true);
      expect(result.namedFetch).toBe('function');
    } finally { worker.terminate(); }
  });

  it('the Pod host page independently denies native connections with CSP', async () => {
    // eslint-disable-next-line no-restricted-globals
    const html = await (await fetch('/engine-tabs/pod-tab/index.html')).text();
    const meta = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i);
    expect(meta?.[1]).toBe("connect-src 'none'");
  });
});

describe('red-team: the App iframe + Notebook page CSP fences confine untrusted code', () => {
  it('the Notebook page ships connect-src \'none\' as its second fence', async () => {
    // why bare fetch is acceptable: reads our own shipped page source to pin the
    // CSP (not a network egress), same rationale as notebook-seal.test.js.
    // eslint-disable-next-line no-restricted-globals
    const html = await (await fetch('/engine-tabs/notebook-tab/index.html')).text();
    const meta = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i);
    expect(meta?.[1]).toBe("connect-src 'none'");
  });

  it('the manifest sandbox CSP denies the App iframe ambient authority and network egress', async () => {
    // eslint-disable-next-line no-restricted-globals
    const manifest = await (await fetch('/manifest.json')).json();
    const sandboxCsp = String(manifest?.content_security_policy?.sandbox ?? manifest?.sandbox?.csp ?? '');
    expect(sandboxCsp).toContain('allow-scripts');
    // The two tokens whose ABSENCE is the containment: no allow-same-origin means
    // the app runs at an opaque origin (no extension storage / OPFS / parent DOM),
    // and no allow-top-navigation means it cannot redirect the host tab.
    // (The custom in-browser framework has no `.not`, so assert absence directly.)
    expect(sandboxCsp.includes('allow-same-origin')).toBe(false);
    expect(sandboxCsp.includes('allow-top-navigation')).toBe(false);
    expect(sandboxCsp.includes('allow-forms')).toBe(false);
    expect(sandboxCsp.includes('allow-popups')).toBe(false);
    expect(sandboxCsp.includes('allow-downloads')).toBe(false);
    for (const directive of [
      "default-src 'none'", "connect-src 'none'", "frame-src 'none'",
      "object-src 'none'", "form-action 'none'", "base-uri 'none'",
      "webrtc 'block'",
    ]) expect(sandboxCsp).toContain(directive);
    // App assets are composed inline; only non-network data/blob resources and
    // the blob Worker shim are restored above the deny-by-default floor.
    expect(sandboxCsp).toContain("worker-src blob:");
    expect(sandboxCsp).toContain("img-src data: blob:");
    expect(sandboxCsp.includes("script-src 'self'")).toBe(false);
    expect(sandboxCsp.includes("worker-src 'self'")).toBe(false);
  });

  it('the App runner cancels form submits so a hostile bundle cannot navigate out', async () => {
    // eslint-disable-next-line no-restricted-globals
    const runner = await (await fetch('/engine-tabs/app-tab/runner.html')).text();
    // The runner intercepts submit events (preventDefault) AND overrides the
    // legacy Form.prototype.submit() that bypasses the event, both navigation
    // leaks out of the sandboxed frame are closed. (meta-refresh stripping is
    // covered at the compose layer by scenario 06's stripMetaRefresh probe.)
    expect(/addEventListener\(['"]submit['"]/.test(runner)).toBe(true);
    expect(/Form\.prototype\.submit/.test(runner)).toBe(true);
    expect(runner).toContain('RTCPeerConnection');
    expect(runner).toContain('securitypolicyviolation');
    expect(runner).toContain("type: 'app-link'");
  });
});
