// @ts-check
// origin-credentials — the pure rules for API-key storage + origin-bound use.
//
// DESIGN-18 P1. An API integration (a `backing:'api'` web actor) owns ONE origin
// and may authenticate to it WITHOUT ever holding the key: the key is stored in the
// vault, decrypted only in the sealed vault Worker, and returned over its private
// channel to the exact SW egress handler; never on the keyless actor's ctx. This is the `origin:<origin>` analog
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
 * key verbatim in `header` (default Authorization), for X-API-Key-style schemes;
 * 'dpop' → `{scheme:'dpop', value:<token>}`, an ACCESS TOKEN that is useless on its
 * own — the boundary must pair it with a freshly signed proof of possession
 * (RFC 9449; peerd-egress/dpop/). why the dpop shape stores no `header`: the header
 * set is FIXED by the RFC (`Authorization: DPoP …` + `DPoP: <proof>`), so letting it
 * be configured could only produce a token sent without its proof.
 * Returns null if the key isn't plausible.
 *
 * SCHEME HANDLING IS FAIL-CLOSED, and that is a security rule, not tidiness. The
 * scheme is normalized (`trim().toLowerCase()`, so `'DPoP'` and `' Raw '` mean what
 * they say) and then matched against a CLOSED set; anything else returns null.
 * why a refusal rather than a fallback: this used to fall through to bearer, so one
 * typo at a credential constructor — `'DPoP'`, `'dpop '`, `'bearar'` — silently
 * stored a proof-of-possession token as a bare bearer secret, i.e. quietly downgraded
 * the strongest credential peerd can hold to the weakest. An unrecognized scheme means
 * the caller wanted something we do not implement; the safe answer is to store nothing.
 * An ABSENT scheme still means bearer, unchanged — that is the documented default, not
 * a guess about an unknown name.
 * @param {{ key?: string, header?: string, scheme?: 'bearer' | 'raw' | 'dpop' }} arg
 * @returns {string | null}
 */
export const buildOriginSecret = ({ key, header, scheme } = {}) => {
  const k = typeof key === 'string' ? key.trim() : '';
  if (!isPlausibleApiKey(k)) return null;
  const named = (scheme == null ? '' : String(scheme).trim().toLowerCase()) || 'bearer';
  if (named === 'dpop') return JSON.stringify({ scheme: 'dpop', value: k });
  if (named !== 'bearer' && named !== 'raw') return null;          // closed set: refuse, never downgrade
  const name = named === 'bearer' ? 'Authorization' : (typeof header === 'string' && header.trim() ? header.trim() : 'Authorization');
  const value = named === 'bearer' ? `Bearer ${k}` : k;
  return JSON.stringify({ header: name, value });
};

/**
 * Parse a stored origin secret into the header to inject. Accepts the JSON {header,
 * value} shape, the JSON {scheme:'dpop', value} shape, OR a bare token (legacy /
 * hand-entered) → Authorization: Bearer.
 * Returns null for an empty/garbage secret (→ the wrapper sends anonymous).
 *
 * The dpop result carries the extra `scheme:'dpop'` + `token` members so the
 * boundary can tell a self-sufficient BEARER credential from one that is only
 * spendable alongside a freshly signed proof. why the extra members rather than a
 * separate parser: every existing caller reads `.header`/`.value` and keeps working,
 * while a caller that does NOT understand proof-of-possession can (and does — see
 * withApiCredentials) refuse the credential by checking one field.
 * @param {string | null | undefined} stored
 * @returns {{ header: string, value: string, scheme?: 'dpop', token?: string } | null}
 */
export const parseOriginAuth = (stored) => {
  if (typeof stored !== 'string' || !stored.trim()) return null;
  const raw = stored.trim();
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { header: 'Authorization', value: `Bearer ${raw}` }; }   // not JSON → raw token
  // A JSON OBJECT is meant to be our {header,value} shape — honor it, or reject if
  // malformed (structured but wrong is "no usable secret", not a token).
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    // Proof-of-possession first: the header set is fixed by RFC 9449, so a stored
    // `header` (if some future writer adds one) is deliberately ignored here.
    // The scheme is case-normalized on the READ side too, matching buildOriginSecret:
    // a record that says `'DPoP'` must be recognized as proof-of-possession, because
    // the alternative is falling through to a shape that spends the token as a bearer.
    const storedScheme = typeof parsed.scheme === 'string' ? parsed.scheme.trim().toLowerCase() : '';
    if (storedScheme === 'dpop') {
      return (typeof parsed.value === 'string' && parsed.value)
        ? { header: 'Authorization', value: `DPoP ${parsed.value}`, scheme: 'dpop', token: parsed.value }
        : null;
    }
    return (typeof parsed.header === 'string' && parsed.header.trim() && typeof parsed.value === 'string' && parsed.value)
      ? { header: parsed.header.trim(), value: parsed.value }
      : null;
  }
  // A JSON PRIMITIVE / array (an all-digit key like "12345678", "true", a quoted string)
  // is still a bare hand-entered token → Authorization: Bearer, matching the contract for
  // every bare-token case (not just the ones JSON.parse happens to reject).
  return { header: 'Authorization', value: `Bearer ${raw}` };
};
