// @ts-check
// origin-credentials — the pure rules for API-key storage + origin-bound use.
//
// DESIGN-18 P1. An API integration (a `backing:'api'` web actor) owns ONE origin
// and may authenticate to it WITHOUT ever holding the key: the key is stored in the
// vault, decrypted only in the SW at request time, and injected at the egress
// BOUNDARY — never on the keyless actor's ctx. This is the `origin:<origin>` analog
// of the shipped `git:<host>` injection (peerd-engine/vm-net/git-credentials.js);
// it copies that battle-tested shape exactly. This module owns the pure decisions;
// the boundary wrapper (web-fetch.js withApiCredentials) composes it over the vault.
//
// The eight NORMATIVE security rules (DESIGN-18 spec §Credentials), each enforced here
// or by the wrapper so the design can't regress vs the git precedent:
//   2. https-ONLY at grant (normalizeKeyedOrigin) AND send (authOriginForRequestUrl).
//   3. same-origin via URL.origin equality — never a synthesized form; spoof-proof.
//   4. single-shot, pre-fetch injection (the wrapper); redirects stay refused by webFetch.
//   5. the strip set includes the CONFIGURED header name; injection is last-wins (wrapper).
//   6. value only on the wire — audit the header NAME + origin, never the value (wrapper).
//   7. fail closed silently — locked/missing vault → no header, no throw (wrapper).
//   (1) origin:<origin> naming + the {header,value} shape; (8) web:write confirm is
//   unchanged and lives in fetch_url. The owned-origin SSRF/open-redirect residual is
//   accepted + named in the spec.

export const ORIGIN_SECRET_PREFIX = 'origin:';

// A real public DNS host: dotted labels ending in an alpha TLD (the git precedent's
// rule). Rejects bare IPs / localhost / junk — input hygiene for what we STORE; the
// SW's webFetch still enforces the network SSRF block at send time.
const API_ORIGIN_HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

/**
 * Normalize a user-entered origin for KEYED use — https-ONLY (rule 2, grant time: a
 * bearer key must never be bound to a cleartext origin). Accepts a bare host (assumed
 * https) or a full https URL; returns the canonical `https://host[:port]` (URL.origin)
 * or null. why stricter than the P0 addressing normalizer (web-actor.js, which allows
 * http for keyless public APIs): a STORED KEY rides only https.
 * @param {unknown} input
 * @returns {string | null}
 */
export const normalizeKeyedOrigin = (input) => {
  let s = String(input ?? '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;   // bare host → https
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:') return null;                       // rule 2: https only
  if (!API_ORIGIN_HOSTNAME_RE.test(u.hostname)) return null;      // public dotted host
  return u.origin;
};

/** Vault secret name for an (already-canonical) origin. @param {string} origin */
export const originSecretName = (origin) => `${ORIGIN_SECRET_PREFIX}${origin}`;

/** Inverse: a vault secret name → its origin, or null if not an origin secret. @param {string} name */
export const originFromSecretName = (name) =>
  String(name).startsWith(ORIGIN_SECRET_PREFIX) ? String(name).slice(ORIGIN_SECRET_PREFIX.length) : null;

/**
 * THE SEND-TIME BINDING GATE (rules 2 + 3). Given an outbound request URL and the
 * actor's OWNED origin, return the origin whose key may authenticate the request — or
 * null to send anonymously. Authenticates ONLY when the request is https AND its
 * URL.origin EQUALS the owned origin. Cross-origin, http, or a spoof
 * (`owned.evil.com`, userinfo tricks) all land on a different origin → null. Does NOT
 * decide whether a key EXISTS; the caller looks up originSecretName(origin) in the vault.
 * @param {string} url  the outbound request url
 * @param {string | undefined} ownedOrigin  the actor's fixed owned origin (URL.origin form)
 * @returns {string | null}
 */
export const authOriginForRequestUrl = (url, ownedOrigin) => {
  if (!ownedOrigin) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:') return null;        // rule 2 (send): never over cleartext
  return u.origin === ownedOrigin ? ownedOrigin : null;   // rule 3: URL.origin equality
};

/**
 * A plausible API key: non-empty, no whitespace, a sane minimum. Formats vary wildly,
 * so this is a sanity gate, not a validator.
 * @param {unknown} key @returns {boolean}
 */
export const isPlausibleApiKey = (key) =>
  typeof key === 'string' && key.trim().length >= 8 && !/\s/.test(key.trim());

/**
 * Build the vault secret string for an origin key. Stored as JSON {header, value} so
 * the boundary knows the exact header to set (rule 5) and its full value. `scheme`
 * shapes the value: 'bearer' (default) → `Authorization: Bearer <key>`; 'raw' → the
 * key verbatim in `header` (default Authorization), for X-API-Key-style schemes.
 * Returns null if the key isn't plausible.
 * @param {{ key?: string, header?: string, scheme?: 'bearer' | 'raw' }} arg
 * @returns {string | null}
 */
export const buildOriginSecret = ({ key, header, scheme } = {}) => {
  const k = typeof key === 'string' ? key.trim() : '';
  if (!isPlausibleApiKey(k)) return null;
  const useScheme = scheme === 'raw' ? 'raw' : 'bearer';
  const name = useScheme === 'bearer' ? 'Authorization' : (typeof header === 'string' && header.trim() ? header.trim() : 'Authorization');
  const value = useScheme === 'bearer' ? `Bearer ${k}` : k;
  return JSON.stringify({ header: name, value });
};

/**
 * Parse a stored origin secret into the header to inject. Accepts the JSON {header,
 * value} shape, OR a bare token (legacy / hand-entered) → Authorization: Bearer.
 * Returns null for an empty/garbage secret (→ the wrapper sends anonymous).
 * @param {string | null | undefined} stored
 * @returns {{ header: string, value: string } | null}
 */
export const parseOriginAuth = (stored) => {
  if (typeof stored !== 'string' || !stored.trim()) return null;
  try {
    const o = JSON.parse(stored);
    if (o && typeof o.header === 'string' && o.header.trim() && typeof o.value === 'string' && o.value) {
      return { header: o.header.trim(), value: o.value };
    }
    // JSON that isn't our shape → fall through to bearer-of-the-string below is wrong
    // (it's structured but malformed); treat as no usable secret.
    return null;
  } catch {
    // Not JSON → a raw token; default to Authorization: Bearer (the common case).
    return { header: 'Authorization', value: `Bearer ${stored.trim()}` };
  }
};
