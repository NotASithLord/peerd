// Tests for the SW-side egress orchestration extracted from service-worker.js:
// makeVmHttpFetch (the anti-exfil write gate + host-bound git-auth + the
// revalidating IDB cache) and makeGitCredentialRoutes (token provisioning).
//
// This is security-critical glue that previously lived inline in a service
// worker (un-runnable under bun). The extraction made the IO injectable, so
// here we drive it with fakes and assert the gates that protect the user: a
// non-GET prompts and refuses on decline, GETs never prompt, a git token only
// attaches to its own HTTPS host, the cache serves/revalidates/stores correctly,
// and oversized bodies are rejected.

import { describe, test, expect } from 'bun:test';
import { makeVmHttpFetch, makeInjectGitAuth, WEB_WRITE_CONFIRM_KEY, MAX_VM_FETCH_BODY } from '../../../extension/peerd-engine/vm-net/vm-http-fetch.js';
import { makeGitCredentialRoutes } from '../../../extension/peerd-engine/vm-net/git-credential-routes.js';

// A minimal Response-like object the factory consumes: it reads .status,
// .statusText, .ok, .headers (iterable of [k,v]), and .arrayBuffer().
function fakeResponse({ status = 200, statusText = 'OK', headers = {}, body = 'BODY' }: { status?: number; statusText?: string; headers?: Record<string, string>; body?: string } = {}) {
  const bytes = new TextEncoder().encode(body);
  return {
    status, statusText, ok: status >= 200 && status < 300,
    headers: new Map(Object.entries(headers)),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

const bytesToBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const b64 = (s: string) => Buffer.from(s).toString('base64');

// Build a fetch with sensible defaults; override any dep per-test.
function build(overrides: any = {}) {
  const calls = { fetch: [] as any[], confirm: [] as any[], cachePut: [] as any[], audit: [] as any[] };
  const deps = {
    webFetch: async (url: string, init?: any) => { calls.fetch.push({ url, init }); return fakeResponse(); },
    getSecret: async () => null,
    cacheGet: async () => null,
    cachePut: async (rec: any) => { calls.cachePut.push(rec); },
    confirm: async (p: any) => { calls.confirm.push(p); return 'yes_once'; },
    getCurrentSessionId: async () => 'sid-1',
    bytesToBase64,
    audit: (e: any) => { calls.audit.push(e); },
    now: () => 1_000_000,
    ...overrides,
  };
  return { fetch: makeVmHttpFetch(deps), calls, deps };
}

describe('makeVmHttpFetch — anti-exfil write gate', () => {
  test('GET never prompts', async () => {
    const { fetch, calls } = build();
    const r = await fetch({ url: 'https://example.com/x', method: 'GET' });
    expect(r.ok).toBe(true);
    expect(calls.confirm.length).toBe(0);
  });

  test('HEAD never prompts', async () => {
    const { fetch, calls } = build();
    await fetch({ url: 'https://example.com/x', method: 'HEAD' });
    expect(calls.confirm.length).toBe(0);
  });

  test('POST prompts with the shared web:write key + host, proceeds on yes_once', async () => {
    const { fetch, calls } = build();
    const r = await fetch({ url: 'https://api.example.com/p', method: 'POST', body: b64('hi') });
    expect(calls.confirm.length).toBe(1);
    expect(calls.confirm[0].tool).toBe(WEB_WRITE_CONFIRM_KEY);
    expect(calls.confirm[0].tool).toBe('web:write');
    expect(calls.confirm[0].origins).toEqual(['api.example.com']);
    expect(calls.confirm[0].sessionId).toBe('sid-1');
    expect(r.ok).toBe(true);
  });

  test('OPTIONS is gated too (can carry a body)', async () => {
    const { fetch, calls } = build();
    await fetch({ url: 'https://api.example.com/p', method: 'OPTIONS' });
    expect(calls.confirm.length).toBe(1);
  });

  test('declining a write returns an error and never fetches', async () => {
    const { fetch, calls } = build({ confirm: async () => 'no' });
    const r = await fetch({ url: 'https://api.example.com/p', method: 'POST', body: b64('x') });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/declined/);
    expect(calls.fetch.length).toBe(0);
  });

  test('yes_session also proceeds', async () => {
    const { fetch, calls } = build({ confirm: async () => 'yes_session' });
    const r = await fetch({ url: 'https://api.example.com/p', method: 'PUT', body: b64('x') });
    expect(r.ok).toBe(true);
    expect(calls.fetch.length).toBe(1);
  });

  test('an unparseable URL still gates and passes the raw string as the origin', async () => {
    const { fetch, calls } = build();
    await fetch({ url: 'not a url', method: 'POST' });
    expect(calls.confirm[0].origins).toEqual(['not a url']);
  });
});

describe('makeVmHttpFetch — host-bound git auth', () => {
  test('attaches a Bearer token only when the secret exists and the host matches over https', async () => {
    const { fetch, calls } = build({ getSecret: async (name: string) => (name === 'git:github.com' ? 'ghp_secrettoken' : null) });
    await fetch({ url: 'https://github.com/o/r/info/refs', method: 'GET', gitAuth: true });
    const sent = calls.fetch[0].init;
    expect(sent.headers.Authorization).toBe('Bearer ghp_secrettoken');
    // audited the USE, not the value
    const a = calls.audit.find((e: any) => e.type === 'git_auth_attached');
    expect(a.details.host).toBe('github.com');
    expect(JSON.stringify(a)).not.toContain('ghp_secrettoken');
  });

  test('canonicalizes api.github.com → github.com for the token lookup', async () => {
    const seen: string[] = [];
    const { fetch } = build({ getSecret: async (name: string) => { seen.push(name); return name === 'git:github.com' ? 'tok-123' : null; } });
    await fetch({ url: 'https://api.github.com/repos/o/r', method: 'GET', gitAuth: true });
    expect(seen).toContain('git:github.com');
  });

  test('gitlab.com gets a PRIVATE-TOKEN header, not Bearer', async () => {
    const { fetch, calls } = build({ getSecret: async () => 'glpat-abcdefgh' });
    await fetch({ url: 'https://gitlab.com/g/p', method: 'GET', gitAuth: true });
    expect(calls.fetch[0].init.headers['PRIVATE-TOKEN']).toBe('glpat-abcdefgh');
    expect(calls.fetch[0].init.headers.Authorization).toBeUndefined();
  });

  test('never attaches a token over http (cleartext)', async () => {
    const { fetch, calls } = build({ getSecret: async () => 'tok-should-not-leak' });
    await fetch({ url: 'http://github.com/o/r', method: 'GET', gitAuth: true });
    const init = calls.fetch[0].init;
    expect(init?.headers?.Authorization).toBeUndefined();
  });

  test('no gitAuth flag → never consults the vault', async () => {
    let consulted = false;
    const { fetch } = build({ getSecret: async () => { consulted = true; return 'tok'; } });
    await fetch({ url: 'https://github.com/o/r', method: 'GET' });
    expect(consulted).toBe(false);
  });

  test('a vault-locked getSecret throw degrades to anonymous (public repos still work)', async () => {
    const { fetch, calls } = build({ getSecret: async () => { throw new Error('locked'); } });
    const r = await fetch({ url: 'https://github.com/o/r', method: 'GET', gitAuth: true });
    expect(r.ok).toBe(true);
    expect(calls.fetch[0].init?.headers?.Authorization).toBeUndefined();
  });
});

describe('makeInjectGitAuth (unit)', () => {
  test('returns headers unchanged for a non-matching/LAN host', async () => {
    const inject = makeInjectGitAuth({ getSecret: async () => 'tok', audit: () => {} });
    const out = await inject('https://localhost/o/r', { X: '1' });
    expect(out).toEqual({ X: '1' });
  });
});

describe('makeVmHttpFetch — response cache', () => {
  const cacheableUrl = 'https://cdn.example.com/pkg.tgz';

  test('a fresh cached entry is served without touching the network', async () => {
    const cached = { key: cacheableUrl, meta: { status: 200, statusText: 'OK', headers: { 'cache-control': 'max-age=3600' } }, bodyB64: b64('CACHED'), storedAt: 1_000_000 - 1000 };
    const { fetch, calls } = build({ cacheGet: async () => cached });
    const r = await fetch({ url: cacheableUrl, method: 'GET' });
    expect(r.fromCache).toBe('fresh');
    expect(r.bodyB64).toBe(b64('CACHED'));
    expect(calls.fetch.length).toBe(0);
  });

  test('a stale entry replays validators and a 304 serves the stored body (revalidated)', async () => {
    const cached = { key: cacheableUrl, meta: { status: 200, statusText: 'OK', headers: { etag: 'W/"v1"', 'last-modified': 'Mon' } }, bodyB64: b64('OLD'), storedAt: 0 };
    const { fetch, calls } = build({
      cacheGet: async () => cached,
      webFetch: async (_u: string, init: any) => { calls.fetch.push({ init }); return fakeResponse({ status: 304 }); },
    });
    const r = await fetch({ url: cacheableUrl, method: 'GET' });
    expect(calls.fetch[0].init.headers['If-None-Match']).toBe('W/"v1"');
    expect(calls.fetch[0].init.headers['If-Modified-Since']).toBe('Mon');
    expect(r.fromCache).toBe('revalidated');
    expect(r.bodyB64).toBe(b64('OLD'));
    // a 304 refreshes the stored timestamp
    expect(calls.cachePut.length).toBe(1);
    expect(calls.cachePut[0].storedAt).toBe(1_000_000);
  });

  test('a fresh 200 GET is stored', async () => {
    const { fetch, calls } = build({
      webFetch: async () => fakeResponse({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: 'NEW' }),
    });
    const r = await fetch({ url: cacheableUrl, method: 'GET' });
    expect(r.ok).toBe(true);
    expect(calls.cachePut.length).toBe(1);
    expect(calls.cachePut[0].key).toBe(cacheableUrl);
    expect(calls.cachePut[0].bodyB64).toBe(b64('NEW'));
  });

  test('a no-store response is not stored', async () => {
    const { fetch, calls } = build({
      webFetch: async () => fakeResponse({ status: 200, headers: { 'cache-control': 'no-store' } }),
    });
    await fetch({ url: cacheableUrl, method: 'GET' });
    expect(calls.cachePut.length).toBe(0);
  });

  test('an authenticated GET is never cached (read or write)', async () => {
    const cached = { key: cacheableUrl, meta: { status: 200, headers: { 'cache-control': 'max-age=3600' } }, bodyB64: b64('PRIV'), storedAt: 1_000_000 };
    let cacheRead = false;
    const { fetch, calls } = build({
      getSecret: async () => 'glpat-abcdefgh',
      cacheGet: async () => { cacheRead = true; return cached; },
    });
    const r = await fetch({ url: 'https://gitlab.com/g/p/raw', method: 'GET', gitAuth: true });
    // authed request is not cacheable → cache untouched and nothing stored
    expect(cacheRead).toBe(false);
    expect(calls.cachePut.length).toBe(0);
    expect(r.fromCache).toBeUndefined();
  });

  test('a non-GET is never cached', async () => {
    let cacheRead = false;
    const { fetch, calls } = build({ cacheGet: async () => { cacheRead = true; return null; } });
    await fetch({ url: 'https://api.example.com/p', method: 'POST', body: b64('x') });
    expect(cacheRead).toBe(false);
    expect(calls.cachePut.length).toBe(0);
  });

  test('a cachePut quota failure does not fail the fetch', async () => {
    const { fetch } = build({ cachePut: async () => { throw new Error('QuotaExceeded'); } });
    const r = await fetch({ url: cacheableUrl, method: 'GET' });
    expect(r.ok).toBe(true);
  });
});

describe('makeVmHttpFetch — body cap', () => {
  test('a response over the cap is rejected', async () => {
    const big = 'a'.repeat(MAX_VM_FETCH_BODY + 1);
    const { fetch } = build({ webFetch: async () => fakeResponse({ body: big }) });
    const r = await fetch({ url: 'https://example.com/big', method: 'GET' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too large/);
  });

  test('a response exactly at the cap is allowed', async () => {
    const exact = 'a'.repeat(MAX_VM_FETCH_BODY);
    const { fetch } = build({ webFetch: async () => fakeResponse({ body: exact }) });
    const r = await fetch({ url: 'https://example.com/edge', method: 'GET' });
    expect(r.ok).toBe(true);
  });
});

// --- git-credential routes --------------------------------------------------

function fakeVault() {
  const secrets = new Map<string, string>();
  return {
    secrets,
    listSecretNames: async () => [...secrets.keys()],
    setSecret: async (name: string, value: string) => { secrets.set(name, value); },
    deleteSecret: async (name: string) => { secrets.delete(name); },
  };
}

class FakeLocked extends Error {}

function buildRoutes(overrides: any = {}) {
  const vault = overrides.vault ?? fakeVault();
  const audit: any[] = [];
  const routes = makeGitCredentialRoutes({
    vault,
    isLockedError: (e: any) => e instanceof FakeLocked,
    audit: (e: any) => audit.push(e),
    ...overrides.factory,
  });
  return { routes, vault, audit };
}

describe('makeGitCredentialRoutes', () => {
  test('list returns canonical host NAMES only, sorted, never values', async () => {
    const vault = fakeVault();
    vault.secrets.set('git:github.com', 'tok-a');
    vault.secrets.set('git:gitlab.com', 'tok-b');
    vault.secrets.set('anthropic', 'sk-not-a-git-secret'); // ignored
    const { routes } = buildRoutes({ vault });
    const r = await routes['git-cred/list']();
    expect(r).toEqual({ ok: true, hosts: ['github.com', 'gitlab.com'] });
    expect(JSON.stringify(r)).not.toContain('tok-a');
  });

  test('set canonicalizes the host, stores under git:<host>, audits the host only', async () => {
    const { routes, vault, audit } = buildRoutes();
    const r = await routes['git-cred/set']({ host: 'https://api.github.com/', token: 'ghp_abcdefgh' });
    expect(r).toEqual({ ok: true, host: 'github.com' });
    expect(vault.secrets.get('git:github.com')).toBe('ghp_abcdefgh');
    expect(audit[0].type).toBe('git_credential_added');
    expect(audit[0].details.host).toBe('github.com');
    expect(JSON.stringify(audit)).not.toContain('ghp_abcdefgh');
  });

  test('set rejects a junk host', async () => {
    const { routes, vault } = buildRoutes();
    const r = await routes['git-cred/set']({ host: 'localhost', token: 'ghp_abcdefgh' });
    expect(r).toEqual({ ok: false, error: 'bad-host' });
    expect(vault.secrets.size).toBe(0);
  });

  test('set rejects an implausible token (too short / has whitespace)', async () => {
    const { routes, vault } = buildRoutes();
    expect(await routes['git-cred/set']({ host: 'github.com', token: 'short' })).toEqual({ ok: false, error: 'bad-token' });
    expect(await routes['git-cred/set']({ host: 'github.com', token: 'has space inside' })).toEqual({ ok: false, error: 'bad-token' });
    expect(vault.secrets.size).toBe(0);
  });

  test('delete removes the secret and audits', async () => {
    const vault = fakeVault();
    vault.secrets.set('git:github.com', 'tok');
    const { routes, audit } = buildRoutes({ vault });
    const r = await routes['git-cred/delete']({ host: 'github.com' });
    expect(r).toEqual({ ok: true });
    expect(vault.secrets.has('git:github.com')).toBe(false);
    expect(audit[0].type).toBe('git_credential_removed');
  });

  test('a vault-locked throw maps to { ok:false, error:locked }', async () => {
    const lockedVault = { listSecretNames: async () => { throw new FakeLocked(); }, setSecret: async () => {}, deleteSecret: async () => {} };
    const { routes } = buildRoutes({ vault: lockedVault });
    expect(await routes['git-cred/list']()).toEqual({ ok: false, error: 'locked' });
  });

  test('a non-locked throw propagates', async () => {
    const brokenVault = { listSecretNames: async () => { throw new Error('boom'); }, setSecret: async () => {}, deleteSecret: async () => {} };
    const { routes } = buildRoutes({ vault: brokenVault });
    await expect(routes['git-cred/list']()).rejects.toThrow('boom');
  });
});
