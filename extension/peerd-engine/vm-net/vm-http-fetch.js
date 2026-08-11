// @ts-check
// vm-http-fetch — the SW-side egress orchestration for the WebVM bridge.
//
// This is the imperative-shell logic that sits between the bridge's
// sw/web-fetch message and the raw `webFetch`: the anti-exfil write gate, the
// host-bound git-auth injection, and the IDB response cache (revalidation +
// store). It was inline in the service worker; factored here as an IO-injected
// factory so it's unit-testable (the SW was the only thing exercising it, and a
// SW can't run under bun). The pure POLICY lives in the sibling cores
// (http-cache, git-credentials, http-bridge); this composes them.
//
// All IO is injected (see makeVmHttpFetch deps) — no browser/IDB/vault import.

import { isRequestCacheable, cacheKey, isFresh, revalidationHeaders, isResponseStorable } from './http-cache.js';
import { authHostForRequestUrl, gitSecretName, gitAuthHeader } from './git-credentials.js';
import { needsWebWriteConfirm } from './http-bridge.js';

export const WEB_WRITE_CONFIRM_KEY = 'web:write';
export const MAX_VM_FETCH_BODY = 50 * 1024 * 1024;

/** @param {Response} response @param {number} limit */
const readBoundedBody = async (response, limit) => {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > limit ? { bytes: null, size: bytes.byteLength } : { bytes, size: bytes.byteLength };
  }
  /** @type {Uint8Array[]} */ const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    size += chunk.byteLength;
    if (size > limit) {
      await reader.cancel('response body limit exceeded').catch(() => {});
      return { bytes: null, size };
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, size };
};

/**
 * Host-bound git-auth injection. Attaches the user's `git:<host>` token only
 * when the request URL canonicalizes to that host over HTTPS (authHostForRequestUrl
 * refuses non-https/LAN); audits the USE, never the value.
 * @param {{ getSecret: (name: string) => Promise<string|null>, audit?: (e: any) => void }} deps
 * @returns {(url: string, headers?: Record<string,string>) => Promise<Record<string,string>|undefined>}
 */
export const makeInjectGitAuth = ({ getSecret, audit }) => async (url, headers) => {
  const host = authHostForRequestUrl(url);
  if (!host) return headers;
  let token = null;
  try { token = await getSecret(gitSecretName(host)); }
  catch { /* vault locked / no secret → anonymous, public repos still work */ }
  if (!token) return headers;
  try { audit?.({ type: 'git_auth_attached', details: { host } }); } catch { /* best effort */ }
  return { ...(headers || {}), ...gitAuthHeader(host, token) };
};

/**
 * Build the WebVM bridge fetch. Returns the SW message shape:
 *   { ok, status, statusText, headers, bodyB64, fromCache? } | { ok:false, error }
 *
 * @param {Object} deps
 * @param {(url: string, init?: any) => Promise<Response>} deps.webFetch  denylist+SSRF+redirect-gated fetch
 * @param {(name: string) => Promise<string|null>} deps.getSecret         vault secret lookup (git tokens)
 * @param {(key: string) => Promise<any>} deps.cacheGet                   IDB cache read
 * @param {(record: any) => Promise<void>} deps.cachePut                  IDB cache write
 * @param {(prompt: any) => Promise<'yes_once'|'yes_session'|'no'>} deps.confirm
 * @param {() => Promise<string|null>} deps.getCurrentSessionId
 * @param {(bytes: Uint8Array) => string} deps.bytesToBase64
 * @param {(e: any) => void} [deps.audit]
 * @param {() => number} [deps.now]
 */
export const makeVmHttpFetch = (deps) => {
  const { webFetch, cacheGet, cachePut, confirm, getCurrentSessionId, bytesToBase64, now = Date.now } = deps;
  const injectGitAuth = makeInjectGitAuth(deps);

  /**
   * @param {{ url: string, method?: string, headers?: Record<string,string>, body?: string|null, gitAuth?: boolean, noCache?: boolean, signal?:AbortSignal, maxBodyBytes?:number }} req
   *   noCache opts this request out of the IDB cache entirely (no read, no
   *   store). why: remote MODULE source (module-resolver.js makeFetchRemote)
   *   must hit the live audited fetch every run — a warm IDB hit would serve
   *   third-party code with no denylist re-check and no audit entry, and the
   *   design forbids a persistent module cache (stale code silently pinned).
   */
  return async ({ url, method, headers, body, gitAuth, noCache, signal, maxBodyBytes }) => {
    const verb = (method || 'GET').toUpperCase();
    const bodyLimit = Math.min(MAX_VM_FETCH_BODY, Math.max(1, Number(maxBodyBytes) || MAX_VM_FETCH_BODY));

    // Anti-exfil gate: anything that can transmit a body (every verb except
    // GET/HEAD — including OPTIONS) is confirmed. Control ops never reach here;
    // git-clone fetches are GETs.
    if (needsWebWriteConfirm(verb)) {
      let host = url;
      try { host = new URL(url).host; } catch { /* keep raw */ }
      const sid = await getCurrentSessionId().catch(() => null);
      const ans = await confirm({
        tool: WEB_WRITE_CONFIRM_KEY, kind: 'web_write', origins: [host],
        summary: `Allow the WebVM to send a ${verb} request to ${host}? This can send data out of the browser.`,
        sessionId: sid ?? null,
      });
      if (ans !== 'yes_once' && ans !== 'yes_session') {
        return { ok: false, error: 'web write declined by user' };
      }
    }

    let effHeaders = gitAuth ? await injectGitAuth(url, headers) : headers;

    const cacheable = !noCache && isRequestCacheable({ method: verb, url, headers: effHeaders, body });
    const key = cacheable ? cacheKey(url) : null;
    let cached = null;
    if (key) {
      try { cached = await cacheGet(key); } catch { cached = null; }
      if (cached && isFresh(cached.meta, cached.storedAt, now())) {
        return { ok: true, status: cached.meta.status, statusText: cached.meta.statusText || '',
          headers: cached.meta.headers, bodyB64: cached.bodyB64, fromCache: 'fresh' };
      }
      if (cached) effHeaders = { ...(effHeaders || {}), ...revalidationHeaders(cached.meta) };
    }

    const init = (verb !== 'GET') || effHeaders || body != null
      ? { method: verb, headers: effHeaders || undefined, body: body ?? undefined, signal }
      : (signal ? { signal } : undefined);
    const res = await webFetch(url, init);

    if (res.status === 304 && cached) {
      try { await cachePut({ ...cached, storedAt: now() }); } catch { /* best effort */ }
      return { ok: true, status: cached.meta.status, statusText: cached.meta.statusText || '',
        headers: cached.meta.headers, bodyB64: cached.bodyB64, fromCache: 'revalidated' };
    }

    const bodyResult = await readBoundedBody(res, bodyLimit);
    if (!bodyResult.bytes) {
      return { ok: false, error: `body too large: at least ${bodyResult.size}B > ${bodyLimit}B` };
    }
    const bodyB64 = bytesToBase64(bodyResult.bytes);
    const meta = { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers) };

    if (key && isResponseStorable(meta, bodyResult.size)) {
      try { await cachePut({ key, meta, bodyB64, storedAt: now() }); }
      catch { /* cache is best-effort; a quota failure must not fail the fetch */ }
    }
    return { ok: res.ok, status: res.status, statusText: res.statusText, headers: meta.headers, bodyB64 };
  };
};
