// @ts-check
// webFetch — egress wrapper for arbitrary web tools.
//
// safeFetch is intentionally narrow: provider endpoints ONLY. That
// invariant defends the "even if the agent is prompt-injected, it
// can't exfiltrate the conversation" property. Web tools (read_article,
// call_api, web_search) need to reach arbitrary HTTPS hosts the user
// might be reading; they go through THIS function, not safeFetch.
//
// What webFetch DOES enforce:
//   - http / https schemes only (no file://, chrome://, etc.)
//   - a PRIVATE-NETWORK block (SSRF defense): no LAN / loopback / link-local
//     targets. The denylist can't express IP ranges, so this is a separate
//     pure guard ahead of it (private-network.js). Closes the LAN-scan /
//     localhost-service vector; see that file for what it deliberately does
//     NOT cover (DNS rebinding, arbitrary public-domain exfil).
//   - the denylist — banks, health portals, password managers, etc.
//     The origin gate at the dispatcher already checks this for any
//     tool that declares its origins(), but we duplicate the check
//     here so a malformed tool that returns an empty origin list
//     can't bypass the denylist via raw webFetch.
//   - audit on both allow and deny so the user has visibility.
//
// What webFetch deliberately does NOT enforce:
//   - a per-host allowlist. Web is fundamentally open; trying to
//     allowlist arbitrary domains would either over-restrict (block
//     legitimate reads) or under-restrict (defeat the point). The
//     denylist + per-tool confirmation gates are the right knobs.

import { EgressDeniedError } from './errors.js';
import { isPrivateOrLocalHost } from './private-network.js';

// A response we must refuse to follow. In an MV3 SW, redirect:'manual'
// turns any 3xx into an opaqueredirect (type set, status 0). We also match
// the real redirect statuses defensively — but NOT 300/304/305/306, which
// are not automatic redirects (304 in particular is a valid cached reply).
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** @param {Response} res */
export const isRedirect = (res) =>
  res?.type === 'opaqueredirect' || REDIRECT_STATUSES.has(res?.status);

// ── session scoping — the web actor's credential rule, AT THE BOUNDARY ──────
//
// peerd never uses raw fetch: every open-web request proxies through webFetch, so
// the ONE place that can attach the user's cookies is the ONE place this rule lives.
// The web resident (kind:'web') may carry the user's SESSION on a request ONLY when
// the target is SAME-ORIGIN as the tab it owns — there it is already in the user's
// session via the rendered tab, so a credentialed fetch to that origin is no
// escalation (and the actor never holds a credential: the BROWSER attaches the
// origin's cookies; keyless is intact). Everything CROSS-ORIGIN — or any request
// with no owned tab — stays SESSIONLESS, so a prompt-injected actor can never point
// a credentialed fetch at a DIFFERENT site the user is logged into and read it out.
// The decision is the boundary's: a tool cannot opt a cross-origin request into
// credentials, because it never supplies the credentials value at all.

/**
 * Should this request carry the user's session? Yes ONLY if it is same-origin to
 * the actor's (trusted, SW-set) session origin. Pure.
 * @param {string} targetUrl
 * @param {string | null | undefined} sessionOrigin  the owned tab's origin
 * @returns {'include' | 'omit'}
 */
export const sessionScopedCredentials = (targetUrl, sessionOrigin) => {
  if (!sessionOrigin) return 'omit';                 // 0-tab state → sessionless
  let origin;
  try { origin = new URL(targetUrl).origin; } catch { return 'omit'; }
  return origin === sessionOrigin ? 'include' : 'omit';
};

/**
 * Wrap a webFetch so every request it carries is session-scoped (above). The
 * caller's own `credentials` is IGNORED and overwritten — the boundary decides, by
 * construction. getSessionOrigin is read PER CALL so a mid-turn tab adoption (the
 * web actor opening its first tab) is reflected immediately.
 * @param {(resource: any, init?: any) => Promise<Response>} webFetch
 * @param {() => string | null | undefined} getSessionOrigin
 * @returns {(resource: any, init?: any) => Promise<Response>}
 */
export const withSessionScopedCredentials = (webFetch, getSessionOrigin) => (resource, init = {}) => {
  const url = resource instanceof Request ? resource.url : String(resource);
  const credentials = sessionScopedCredentials(url, getSessionOrigin());
  return webFetch(resource, { ...init, credentials });
};

/**
 * Factory for the web-tool fetch wrapper.
 *
 * @param {Object} deps
 * @param {() => readonly string[]} deps.getDenylist  current denylist patterns
 * @param {(host: string, patterns: readonly string[]) => boolean} deps.matchDenylist
 *   pure matcher (passed in to avoid a cross-module import here)
 * @param {(partial: { type: string, details?: Record<string, any> }) => Promise<void>} [deps.audit]
 * @param {typeof fetch} [deps.fetchFn]
 */
export const makeWebFetch = ({ getDenylist, matchDenylist, audit, fetchFn }) => {
  const _fetch = fetchFn ?? fetch;
  const _audit = audit ?? (async () => {});
  /**
   * @param {RequestInfo | URL} resource
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  return async (resource, init) => {
    const urlString = resource instanceof Request ? resource.url
      : resource instanceof URL ? resource.toString()
      : resource;
    // why on the audit: the code-mode bridge now sends full HTTP, so the log
    // must distinguish a GET read from a POST write (a wider surface to see).
    const method = (init && typeof init.method === 'string' ? init.method : 'GET').toUpperCase();
    let u;
    try { u = new URL(urlString); }
    catch {
      _audit({ type: 'egress_denied', details: { url: String(urlString), reason: 'invalid_url' } }).catch(() => {});
      throw new EgressDeniedError(String(urlString));
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      _audit({ type: 'egress_denied', details: { origin: u.origin, reason: `scheme:${u.protocol}` } }).catch(() => {});
      throw new EgressDeniedError(u.origin);
    }
    // SSRF block: no LAN / loopback / link-local targets. Ahead of the denylist
    // because the denylist can't express IP ranges. (Provider calls to a local
    // Ollama go through safeFetch/the allowlist, NOT here — so no carve-out.)
    if (isPrivateOrLocalHost(u.hostname)) {
      _audit({ type: 'egress_denied', details: { origin: u.origin, reason: 'private_network' } }).catch(() => {});
      throw new EgressDeniedError(u.origin);
    }
    // u.hostname (not u.host): the denylist matches bare hostnames; u.host
    // carries :port. (The matcher also normalizes defensively — see denylist.js.)
    const denylisted = matchDenylist(u.hostname, getDenylist());
    if (denylisted) {
      _audit({ type: 'egress_denied', details: { origin: u.origin, reason: 'denylist', method } }).catch(() => {});
      throw new EgressDeniedError(u.origin);
    }
    // Redirects fail closed. A 3xx to a different host would re-open every
    // gate above (scheme / SSRF private-network / denylist) against an
    // UN-checked target — e.g. a public host that 302s to 169.254.169.254
    // or to a denylisted bank. MV3 service-worker fetch cannot read a
    // redirect's Location header (redirect:'manual' returns an opaque,
    // header-less response), so we cannot re-validate and follow per hop;
    // we refuse the redirect instead. Forced regardless of the caller's
    // redirect mode (primitives.js used to ask for 'follow').
    const res = await _fetch(resource, { ...init, redirect: 'manual' });
    if (isRedirect(res)) {
      _audit({ type: 'egress_denied', details: { origin: u.origin, reason: 'redirect_blocked', status: res.status } }).catch(() => {});
      throw new EgressDeniedError(u.origin, 'redirect_blocked');
    }
    // why: audit successful web fetches too. The "what URLs has the
    // agent touched?" question becomes answerable from the audit log.
    _audit({ type: 'web_fetch', details: { origin: u.origin, path: u.pathname, method } }).catch(() => {});
    return res;
  };
};
