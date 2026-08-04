// @ts-check
// dpop/keys — the SHELL for DPoP: a proof-of-possession key peerd can USE but
// can never READ, plus the hashing/signing that turns dpop/proof.js's pure
// shaping into a real RFC 9449 proof.
//
// THE WHOLE POINT, in one line: `generateKey(..., false, ...)`.
//
// The `false` is the `extractable` argument, and it is NON-NEGOTIABLE. A
// non-extractable CryptoKey is a HANDLE — the private scalar lives inside the
// browser's crypto implementation and there is no API, from any in-origin code,
// that returns its bytes. `crypto.subtle.exportKey` on it REJECTS. So:
//   - the agent can't read it (it never has the handle at all — the handle
//     never leaves the SW, and never enters a keyless actor heap),
//   - a prompt-injected or outright compromised service worker can't read it,
//   - a malicious co-extension that somehow reached our IDB can't read it,
//   - a heap dump / OPFS scrape / IDB export doesn't contain it.
// The honest residual is stated in THREAT-MODEL.md INV-15: non-extractability
// prevents EXFILTRATION, not USE — code running in-origin while the key is
// resident can still ask for a signature. That is bounded by the origin binding
// (a proof is minted only for the exact owned https origin), by the fact that
// proofs are minted only at the audited egress chokepoint, and by the audit log.
//
// why a CryptoKey can be PERSISTED at all: CryptoKey is structured-cloneable,
// so IndexedDB stores the HANDLE while the key material stays inside the
// implementation. That is what lets the key survive an MV3 service-worker
// eviction without ever becoming bytes we hold.
//
// Functional core / imperative shell: every IO seam here is INJECTED —
// `load`/`save` (the persistence pair), `generate`, `now`, and `subtle`. The
// production wiring hands `makeDpopKeyStore` the idb primitives; nothing in this
// file imports storage.

import {
  assembleProof, base64url, buildProofInput, jwkThumbprintInput, publicJwkOnly, utf8Bytes,
} from './proof.js';

/**
 * The IndexedDB object store holding one keypair record per owned origin
 * (`{ origin, privateKey, publicJwk, createdAt }`, keyPath `origin`). Declared
 * in storage/idb.js's upgrade path; named here so the wiring can't drift.
 */
export const DPOP_KEY_STORE = 'dpop_keys';

/** @typedef {{ origin: string, privateKey: CryptoKey, publicJwk: { kty: string, crv: string, x: string, y: string }, createdAt: number }} DpopKeyRecord */

/** ECDSA P-256 / SHA-256 — the `ES256` of the JOSE header. One place, one truth. */
const ES256_KEY_PARAMS = /** @type {EcKeyGenParams} */ ({ name: 'ECDSA', namedCurve: 'P-256' });
const ES256_SIGN_PARAMS = /** @type {EcdsaParams} */ ({ name: 'ECDSA', hash: 'SHA-256' });

/**
 * Generate a fresh proof-of-possession keypair.
 *
 * The `false` below is the security property of this entire feature; do not
 * parameterize it, and do not "fix" it if a test ever wants the private key.
 * The PUBLIC key stays exportable regardless — the Web Crypto ECDSA generateKey
 * steps set the public key's [[extractable]] slot to true unconditionally — which
 * is what lets us build the JWK for the proof header and the `jkt` thumbprint.
 *
 * @param {{ subtle?: SubtleCrypto }} [deps]
 * @returns {Promise<{ privateKey: CryptoKey, publicKey: CryptoKey, publicJwk: { kty: string, crv: string, x: string, y: string } }>}
 */
export const generateDpopKeypair = async ({ subtle } = {}) => {
  const s = subtle ?? crypto.subtle;
  const pair = /** @type {CryptoKeyPair} */ (await s.generateKey(ES256_KEY_PARAMS, false, ['sign', 'verify']));
  const publicJwk = publicJwkOnly(await s.exportKey('jwk', pair.publicKey));
  // A runtime that refuses to export the PUBLIC half of a non-extractable pair
  // would leave us unable to build a proof header at all; fail loudly here
  // rather than mint a headerless proof the server will reject.
  if (!publicJwk) throw new Error('dpop: public JWK unavailable');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicJwk };
};

/**
 * Build the persistence pair from injected IDB primitives (the production
 * wiring passes `egress.idb.get` / `egress.idb.put`). Keeping this a factory is
 * what lets `getOrCreateDpopKey` be tested against a plain Map.
 * @param {{ get: (store: string, key: any) => Promise<any>, put: (store: string, value: any) => Promise<void> }} idb
 * @returns {{ load: (origin: string) => Promise<any>, save: (record: DpopKeyRecord) => Promise<void> }}
 */
export const makeDpopKeyStore = ({ get, put }) => ({
  load: (origin) => get(DPOP_KEY_STORE, origin),
  save: (record) => put(DPOP_KEY_STORE, record),
});

/** An https origin in canonical `URL.origin` form — the only thing we mint keys for. */
/** @param {unknown} origin @returns {string | null} */
const canonicalHttpsOrigin = (origin) => {
  const s = String(origin ?? '');
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  return u.protocol === 'https:' && u.origin === s ? s : null;
};

/**
 * Load this origin's keypair, or create and persist one. ONE keypair per owned
 * origin — the key is an identity at that origin, so sharing one across origins
 * would let two integrations be correlated by their `jkt`.
 *
 * Fails CLOSED by returning null: a non-https/non-canonical origin, a store
 * that throws, or a record whose handle didn't survive round-tripping all yield
 * null, and the boundary then sends anonymous rather than an unbound token.
 * A persist failure after a successful generate still returns the fresh key —
 * the request should work; it just re-mints next time.
 *
 * @param {string} origin  canonical https `URL.origin` (from authOriginForRequestUrl)
 * @param {{ load: (origin: string) => Promise<any>, save: (record: DpopKeyRecord) => Promise<void>,
 *           generate?: () => Promise<{ privateKey: CryptoKey, publicJwk: { kty: string, crv: string, x: string, y: string } }>,
 *           now?: () => number }} deps
 * @returns {Promise<{ privateKey: CryptoKey, publicJwk: { kty: string, crv: string, x: string, y: string } } | null>}
 */
export const getOrCreateDpopKey = async (origin, { load, save, generate, now } = /** @type {any} */ ({})) => {
  const canonical = canonicalHttpsOrigin(origin);
  if (!canonical) return null;
  try {
    const existing = await load(canonical);
    const publicJwk = existing ? publicJwkOnly(existing.publicJwk) : null;
    if (existing?.privateKey && publicJwk) return { privateKey: existing.privateKey, publicJwk };
  } catch { /* a broken/unreadable store re-mints below rather than failing the request */ }

  let fresh;
  try { fresh = await (generate ?? generateDpopKeypair)(); }
  catch { return null; }
  const record = /** @type {DpopKeyRecord} */ ({
    origin: canonical,
    privateKey: fresh.privateKey,
    publicJwk: fresh.publicJwk,
    createdAt: (now ?? Date.now)(),
  });
  try { await save(record); }
  catch { /* persist is best-effort: this request still gets a valid proof */ }
  return { privateKey: fresh.privateKey, publicJwk: fresh.publicJwk };
};

/**
 * RFC 7638 JWK thumbprint (`jkt`) — base64url(SHA-256(canonical JWK JSON)).
 * This is the only key-derived value that is safe to AUDIT: it is a public
 * fingerprint of a public key, and it is what an authorization server binds a
 * token to. Returns null for an unusable JWK.
 * @param {unknown} publicJwk
 * @param {{ subtle?: SubtleCrypto }} [deps]
 * @returns {Promise<string | null>}
 */
export const dpopJkt = async (publicJwk, { subtle } = {}) => {
  const input = jwkThumbprintInput(publicJwk);
  if (!input) return null;
  const digest = await (subtle ?? crypto.subtle).digest('SHA-256', /** @type {BufferSource} */ (utf8Bytes(input)));
  return base64url(digest);
};

/**
 * RFC 9449 `ath` claim — base64url(SHA-256(access token octets)). Binds the
 * proof to the token it accompanies, so a captured proof can't be paired with a
 * different token. Returns null for an empty token.
 * @param {unknown} token
 * @param {{ subtle?: SubtleCrypto }} [deps]
 * @returns {Promise<string | null>}
 */
export const accessTokenHashFor = async (token, { subtle } = {}) => {
  const t = typeof token === 'string' ? token : '';
  if (!t) return null;
  const digest = await (subtle ?? crypto.subtle).digest('SHA-256', /** @type {BufferSource} */ (utf8Bytes(t)));
  return base64url(digest);
};

/**
 * Mint ONE fresh DPoP proof: pure shaping (dpop/proof.js) + one signature.
 *
 * The signature WebCrypto returns for ECDSA is already the raw `r || s` 64-byte
 * form that JWS ES256 requires — it is emphatically NOT DER, so it is passed
 * straight to base64url with no re-encoding. Getting this wrong is the classic
 * DPoP bug and produces proofs every server rejects.
 *
 * Returns null (fail closed) when the input can't be canonicalized or the sign
 * operation throws — never a partial or unsigned proof.
 *
 * @param {{ privateKey?: CryptoKey, publicJwk?: unknown, method?: unknown, url?: unknown,
 *           jti?: unknown, iatSeconds?: unknown, accessTokenHash?: unknown }} arg
 * @param {{ subtle?: SubtleCrypto }} [deps]
 * @returns {Promise<string | null>}
 */
export const signDpopProof = async (
  { privateKey, publicJwk, method, url, jti, iatSeconds, accessTokenHash } = {},
  { subtle } = {},
) => {
  if (!privateKey) return null;
  const built = buildProofInput({ publicJwk, method, url, jti, iatSeconds, accessTokenHash });
  if (!built) return null;
  try {
    const signature = await (subtle ?? crypto.subtle).sign(ES256_SIGN_PARAMS, privateKey, /** @type {BufferSource} */ (utf8Bytes(built.signingInput)));
    return assembleProof(built.signingInput, signature);
  } catch { return null; }
};
