// @ts-check
// dpop/proof — the PURE core of RFC 9449 (OAuth 2.0 Demonstrating Proof of
// Possession). No IO, no crypto, no clock, no randomness: string and object
// shaping only, so every rule below is Bun-testable without a browser.
//
// why DPoP at all: a BEARER token is bytes — whoever holds them is the client.
// A DPoP-bound token is only spendable by whoever can SIGN for the key it was
// issued against. Combine that with a key generated `extractable:false`
// (dpop/keys.js) and the credential stops being exfiltratable: peerd can USE
// the key at the audited egress boundary but can never READ it, so a stolen
// token — or a stolen key handle in a heap dump — buys an attacker nothing.
//
// The split is the house pattern: the decisions live here (pure), the CryptoKey
// handling, persistence, hashing and signing live in the shell (dpop/keys.js),
// and the boundary composition lives in fetch/web-fetch.js.
//
// The normative bits this file owns (RFC 9449 §4.2):
//   - `htu` is the request URI WITHOUT query and fragment — a proof must not be
//     invalidated (or narrowed) by query params, and must not leak them.
//   - `htm` is the UPPERCASED method.
//   - the JOSE header carries `typ:'dpop+jwt'`, `alg:'ES256'`, and the PUBLIC
//     JWK only. Never `d`. (RFC 7638 thumbprint input is exactly those members.)
//   - fail CLOSED: any input that cannot be canonicalized yields null, and the
//     boundary then sends anonymous rather than signing something ambiguous.

/**
 * base64url (RFC 4648 §5) of raw bytes — no padding, `-`/`_` alphabet.
 * why a counting loop: byte/codec work, explicitly exempt from the array-method
 * house rule, and `String.fromCharCode(...view)` blows the argument limit on
 * anything non-tiny.
 * @param {Uint8Array | ArrayBuffer} bytes
 * @returns {string}
 */
export const base64url = (bytes) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * UTF-8 bytes of a string. The one shared encoder — JWS signs over the UTF-8
 * octets of the signing input, and RFC 7638 hashes the UTF-8 octets of the
 * canonical JWK JSON.
 * @param {string} s
 * @returns {Uint8Array}
 */
export const utf8Bytes = (s) => new TextEncoder().encode(String(s));

/**
 * base64url of a string's UTF-8 bytes (the JOSE segment encoding).
 * @param {string} s
 * @returns {string}
 */
export const base64urlFromString = (s) => base64url(utf8Bytes(s));

/**
 * RFC 9449 §4.2 `htu` — the request URI with query and fragment REMOVED.
 * Returns null for a non-https or unparseable URL (fail closed: peerd never
 * signs a proof for cleartext, and a proof it cannot canonicalize is a proof it
 * cannot bind).
 * why origin + pathname rather than stripping `?#` by hand: it also drops
 * userinfo (`https://a@b/`) and normalizes the port, so the htu the server
 * recomputes from its own view of the request matches ours.
 * @param {unknown} url
 * @returns {string | null}
 */
export const canonicalHtu = (url) => {
  let u;
  try { u = new URL(String(url ?? '')); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  return `${u.origin}${u.pathname}`;
};

/**
 * RFC 9449 §4.2 `htm` — the uppercased HTTP method. Defaults to GET, matching
 * `fetch`'s own default so the proof binds what actually goes on the wire.
 * @param {unknown} method
 * @returns {string}
 */
export const htmOf = (method) => {
  const m = typeof method === 'string' ? method.trim() : '';
  return (m || 'GET').toUpperCase();
};

/**
 * Reduce a JWK to EXACTLY its public members for P-256: `{kty, crv, x, y}`.
 * Drops `d` (the private scalar), `key_ops`, `ext`, `alg`, `kid` and anything
 * else. Returns null if any required member is missing or not a string.
 * why this is load-bearing twice: the proof header must never carry private
 * material, and RFC 7638's thumbprint input is defined as exactly these members
 * — so one function guarantees both.
 * @param {unknown} jwk
 * @returns {{ kty: string, crv: string, x: string, y: string } | null}
 */
export const publicJwkOnly = (jwk) => {
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return null;
  const j = /** @type {Record<string, unknown>} */ (jwk);
  const { kty, crv, x, y } = j;
  if (typeof kty !== 'string' || typeof crv !== 'string') return null;
  if (typeof x !== 'string' || typeof y !== 'string') return null;
  if (!kty || !crv || !x || !y) return null;
  return { kty, crv, x, y };
};

/**
 * RFC 7638 §3 thumbprint INPUT for an EC key: canonical JSON over the required
 * members in LEXICOGRAPHIC order with no whitespace — `crv`, `kty`, `x`, `y`.
 * The SHA-256 of this string's UTF-8 octets, base64url'd, is the `jkt`.
 * Built by hand rather than by `JSON.stringify(obj)` so the ordering is a
 * PROPERTY of this function, not of an object literal a future edit could
 * reshuffle; `JSON.stringify` is still used per-VALUE for correct escaping.
 * @param {unknown} jwk
 * @returns {string | null}
 */
export const jwkThumbprintInput = (jwk) => {
  const pub = publicJwkOnly(jwk);
  if (!pub) return null;
  return `{"crv":${JSON.stringify(pub.crv)},"kty":${JSON.stringify(pub.kty)}`
    + `,"x":${JSON.stringify(pub.x)},"y":${JSON.stringify(pub.y)}}`;
};

/**
 * @typedef {Object} ProofInput
 * @property {string} signingInput  `<b64url(header)>.<b64url(payload)>`
 * @property {{ typ: string, alg: string, jwk: { kty: string, crv: string, x: string, y: string } }} header
 * @property {{ jti: string, htm: string, htu: string, iat: number, nonce?: string, ath?: string }} payload
 */

/**
 * Build the JWS signing input for one DPoP proof. PURE — `jti` and `iatSeconds`
 * are INJECTED, which is exactly what makes freshness testable (two calls with
 * different jti must produce different proofs) without stubbing globals.
 *
 * Returns null — fail closed — when the URL is not https, the htu cannot be
 * canonicalized, the JWK is not a usable public JWK, or jti/iat are missing.
 * The boundary treats null as "send anonymous", never as "send unsigned".
 *
 * `nonce` (RFC 9449 §8) is the SEAM, not the feature: a server that requires a
 * nonce answers the first request with 401 + `DPoP-Nonce: <n>`, and the client
 * re-sends one proof carrying that `nonce` claim. This function can already emit
 * the claim correctly; what is NOT built yet is the boundary machinery around it
 * (caching the newest nonce per origin and the automatic one-shot retry). why put
 * the seam in first: the claim is normative, opaque, and echoed VERBATIM — getting
 * its shape and placement settled here means the retry loop is later a change to
 * fetch/web-fetch.js alone, with no re-litigation of the signed bytes. Named as a
 * gap in THREAT-MODEL.md INV-15's residuals until then.
 *
 * @param {{ publicJwk?: unknown, method?: unknown, url?: unknown, jti?: unknown,
 *           iatSeconds?: unknown, accessTokenHash?: unknown, nonce?: unknown }} arg
 * @returns {ProofInput | null}
 */
export const buildProofInput = ({ publicJwk, method, url, jti, iatSeconds, accessTokenHash, nonce } = {}) => {
  const pub = publicJwkOnly(publicJwk);
  if (!pub) return null;
  const htu = canonicalHtu(url);
  if (!htu) return null;                                   // non-https / unparseable
  const id = typeof jti === 'string' ? jti.trim() : '';
  if (!id) return null;                                    // a replayable proof is no proof
  if (typeof iatSeconds !== 'number' || !Number.isFinite(iatSeconds)) return null;
  const iat = Math.floor(iatSeconds);

  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: pub };
  /** @type {{ jti: string, htm: string, htu: string, iat: number, nonce?: string, ath?: string }} */
  const payload = { jti: id, htm: htmOf(method), htu, iat };
  // `nonce` (RFC 9449 §8) is the server's own freshness challenge, echoed back
  // EXACTLY as received — never trimmed, normalized or re-encoded, because the
  // server compares it byte-for-byte against what it issued. Omitted entirely when
  // absent: an empty `nonce` claim is not the same as no claim, and servers that
  // don't use nonces reject proofs carrying one.
  if (typeof nonce === 'string' && nonce) payload.nonce = nonce;
  // `ath` binds the proof to the ACCESS TOKEN as well as the request, so a proof
  // captured off one request cannot be replayed with a different token.
  if (typeof accessTokenHash === 'string' && accessTokenHash) payload.ath = accessTokenHash;

  const signingInput = `${base64urlFromString(JSON.stringify(header))}.${base64urlFromString(JSON.stringify(payload))}`;
  return { signingInput, header, payload };
};

/**
 * Assemble the compact JWS: `signingInput + '.' + b64url(signature)`.
 * The ES256 signature MUST be the RAW `r || s` 64-byte form — which is exactly
 * what WebCrypto's ECDSA `sign` returns. why the warning: the other common
 * ECDSA encoding (X.509 / OpenSSL DER) is what most non-browser stacks emit,
 * and re-encoding either way here silently produces proofs no server accepts.
 * @param {string} signingInput
 * @param {Uint8Array | ArrayBuffer} signatureBytes
 * @returns {string | null}
 */
export const assembleProof = (signingInput, signatureBytes) => {
  if (typeof signingInput !== 'string' || !signingInput.includes('.')) return null;
  if (!signatureBytes) return null;
  return `${signingInput}.${base64url(signatureBytes)}`;
};
