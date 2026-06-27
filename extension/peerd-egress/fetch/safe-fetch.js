// @ts-check
// Egress allowlist — the most important security primitive in V1 (§4.5).
//
// `safeFetch` wraps the global fetch and refuses any request to a host
// that is not on the allowlist. Bare `fetch` is forbidden everywhere in
// the project (ESLint rule in .eslintrc.cjs; the few exceptions —
// system-prompt loader, this file, storage wrappers — are explicit
// overrides in the same config).
//
// What this defends against (the CREDENTIALED provider path only):
//   - The conversation, plus the API key, being POSTed to a non-provider
//     host by a prompt-injected agent or a malicious/compromised adapter
//   - A tool that holds the vault key trying to phone home
//
// What this DOES NOT govern — be honest, this is a partial control:
//   - The OPEN-WEB tool path. fetch_url / vm_import go through webFetch
//     (peerd-egress/fetch/web-fetch.js),
//     which is allowlist-FREE by design — it reaches arbitrary public
//     HTTPS hosts. webFetch enforces a scheme check, an SSRF/private-
//     network block, the sensitive-site denylist, and audit, but NOT a
//     per-host allowlist. So exfil/C2 to an arbitrary PUBLIC domain over
//     the open-web path is NOT prevented here; the architectural
//     mitigation is that the do/get/check runner has no web tools (see
//     web-fetch.js + docs/DO-GET-CHECK-DEV-NOTES.md "Egress & SSRF").
//   - Network requests originating from web pages the agent is browsing
//     (normal browser CORS + the denylist §4.2)
//   - Requests from inside the WebVM — those go through CheerpX's
//     emulated socket layer, which we route through webFetch when the VM
//     has network enabled (off by default per DECISIONS.md)
//
// What is on the allowlist:
//   - The "hardcoded" set (Anthropic, OpenAI, Ollama loopback) — these
//     are non-negotiable in code; turning them off requires editing this
//     file and a code review.
//   - User-added provider endpoints, persisted in chrome.storage.local
//     under `provider_endpoints.v1`. Adding goes through an explicit
//     per-endpoint "you are adding api.example.com" confirmation flow
//     (peerd-provider/registry.js + a per-host runtime grant flow —
//     not built yet; see TODO.md "Followups").

import { EgressDeniedError } from './errors.js';
import { isRedirect } from './web-fetch.js';
// HARDCODED_ALLOWLIST lives in its own file so changes to the provider
// allowlist stand out in code review. We re-export it for backwards
// compatibility with tests and feature code that import it from here.
export { HARDCODED_ALLOWLIST } from './allowlist.js';

/**
 * Normalize a fetch input to an origin string (`protocol//host[:port]`).
 * Origin comparison is exact — no wildcards. This avoids the entire
 * class of "evil.attacker.com appears to match api.anthropic.com.evil"
 * bugs that wildcard matching invites.
 *
 * @param {string | URL | Request} resource
 * @returns {string}
 */
export const originOf = (resource) => {
  const urlString = resource instanceof Request ? resource.url
    : resource instanceof URL ? resource.toString()
    : resource;
  const u = new URL(urlString);
  return `${u.protocol}//${u.host}`;
};

/**
 * @param {string} origin
 * @param {readonly string[]} allowlist
 */
export const isAllowed = (origin, allowlist) => allowlist.includes(origin);

/**
 * Factory for a safeFetch bound to a specific allowlist source and audit
 * sink. The production wiring (see service-worker.js) builds one of these
 * with the hardcoded list + user-added endpoints; tests build one with
 * a fixed allowlist and a recording audit.
 *
 * @param {Object} deps
 * @param {() => readonly string[]} deps.getAllowlist  called per request — must be cheap
 * @param {(partial: { type: string, details?: Record<string, any> }) => Promise<void>} [deps.audit]
 *   Append-audit fn — receives a partial entry (type + details). The
 *   audit log fills in id and timestamp. See peerd-egress/audit/log.js.
 * @param {typeof fetch} [deps.fetchFn]
 * @returns {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>}
 */
export const makeSafeFetch = ({ getAllowlist, audit, fetchFn }) => {
  const _fetch = fetchFn ?? fetch;
  const _audit = audit ?? (async () => {});
  return async (resource, init) => {
    const origin = originOf(resource);
    if (!isAllowed(origin, getAllowlist())) {
      // Audit-log first. Fire-and-forget on slow writes — we never want
      // logging latency to leak timing information. The throw is
      // synchronous so the caller sees a clean failure either way.
      _audit({ type: 'egress_denied', details: { origin } }).catch(() => {});
      throw new EgressDeniedError(origin);
    }
    // Fail closed on redirects: the allowlist is exact-origin, so ANY 3xx
    // is by definition a hop off the approved origin onto an unchecked one.
    // (MV3 SW fetch can't read the Location to re-validate; provider data
    // endpoints don't redirect, so refusing costs nothing and keeps the
    // credentialed path tight.) Forced regardless of the caller's mode.
    const res = await _fetch(resource, { ...init, redirect: 'manual' });
    if (isRedirect(res)) {
      _audit({ type: 'egress_denied', details: { origin, reason: 'redirect_blocked', status: res.status } }).catch(() => {});
      throw new EgressDeniedError(origin, 'redirect_blocked');
    }
    return res;
  };
};
