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
 * @param {(prompt: any, signal?: AbortSignal) => Promise<'yes_once'|'yes_session'|'no'>} deps.confirm
 * @param {() => Promise<string|null>} deps.getCurrentSessionId
 * @param {(bytes: Uint8Array) => string} deps.bytesToBase64
 * @param {(e: any) => void} [deps.audit]
 * @param {() => number} [deps.now]
 */
export const makeVmHttpFetch = (deps) => {
  const { webFetch, cacheGet, cachePut, confirm, getCurrentSessionId, bytesToBase64, now = Date.now } = deps;
  const injectGitAuth = makeInjectGitAuth(deps);

  /**
   * @param {{ url: string, method?: string, headers?: Record<string,string>, body?: string|null, gitAuth?: boolean, noCache?: boolean, signal?: AbortSignal }} req
   *   noCache opts this request out of the IDB cache entirely (no read, no
   *   store). why: remote MODULE source (module-resolver.js makeFetchRemote)
   *   must hit the live audited fetch every run — a warm IDB hit would serve
   *   third-party code with no denylist re-check and no audit entry, and the
   *   design forbids a persistent module cache (stale code silently pinned).
   */
  return async ({ url, method, headers, body, gitAuth, noCache, signal }) => {
    const verb = (method || 'GET').toUpperCase();
    if (signal?.aborted) return { ok: false, error: 'aborted' };

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
      }, signal);
      if (ans !== 'yes_once' && ans !== 'yes_session') {
        return { ok: false, error: 'web write declined by user' };
      }
      if (signal?.aborted) return { ok: false, error: 'aborted' };
    }

    let effHeaders = gitAuth ? await injectGitAuth(url, headers) : headers;
    if (signal?.aborted) return { ok: false, error: 'aborted' };

    const cacheable = !noCache && isRequestCacheable({ method: verb, url, headers: effHeaders, body });
    const key = cacheable ? cacheKey(url) : null;
    let cached = null;
    if (key) {
      try { cached = await cacheGet(key); } catch { cached = null; }
      if (signal?.aborted) return { ok: false, error: 'aborted' };
      if (cached && isFresh(cached.meta, cached.storedAt, now())) {
        return { ok: true, status: cached.meta.status, statusText: cached.meta.statusText || '',
          headers: cached.meta.headers, bodyB64: cached.bodyB64, fromCache: 'fresh' };
      }
      if (cached) effHeaders = { ...(effHeaders || {}), ...revalidationHeaders(cached.meta) };
    }

    const requestInit = (verb !== 'GET') || effHeaders || body != null
      ? { method: verb, headers: effHeaders || undefined, body: body ?? undefined }
      : undefined;
    const init = signal ? { ...(requestInit ?? {}), signal } : requestInit;
    const res = await webFetch(url, init);

    if (res.status === 304 && cached) {
      try { await cachePut({ ...cached, storedAt: now() }); } catch { /* best effort */ }
      return { ok: true, status: cached.meta.status, statusText: cached.meta.statusText || '',
        headers: cached.meta.headers, bodyB64: cached.bodyB64, fromCache: 'revalidated' };
    }

    const ab = await res.arrayBuffer();
    if (signal?.aborted) return { ok: false, error: 'aborted' };
    if (ab.byteLength > MAX_VM_FETCH_BODY) {
      return { ok: false, error: `body too large: ${ab.byteLength}B > ${MAX_VM_FETCH_BODY}B` };
    }
    const bodyB64 = bytesToBase64(new Uint8Array(ab));
    const meta = { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers) };

    if (key && isResponseStorable(meta, ab.byteLength)) {
      try { await cachePut({ key, meta, bodyB64, storedAt: now() }); }
      catch { /* cache is best-effort; a quota failure must not fail the fetch */ }
    }
    return { ok: res.ok, status: res.status, statusText: res.statusText, headers: meta.headers, bodyB64 };
  };
};
