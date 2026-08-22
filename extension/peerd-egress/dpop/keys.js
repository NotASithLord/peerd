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
  base64url, ES256_KEY_PARAMS, jwkThumbprintInput, publicJwkOnly, utf8Bytes,
} from './jwk.js';

/**
 * The IndexedDB object store holding one keypair record per owned origin
 * (`{ origin, privateKey, publicJwk, createdAt }`, keyPath `origin`). Declared
 * in storage/idb.js's upgrade path; named here so the wiring can't drift.
 */
export const DPOP_KEY_STORE = 'dpop_keys';

/** @typedef {{ origin: string, privateKey: CryptoKey, publicJwk: { kty: string, crv: string, x: string, y: string }, createdAt: number }} DpopKeyRecord */

/**
 * THE non-extractability guard, in one predicate. INV-15's whole claim used to
 * rest on a single `false` literal thirty lines below — nothing asserted it, so a
 * refactor, a polyfilled `subtle`, or a record written by an older build could
 * have quietly downgraded the credential to an exportable key and no test would
 * have noticed.
 *
 * why it checks the ALGORITHM too, not just `extractable`: an extractable-false
 * key of the wrong curve (or a non-ECDSA key entirely) can't produce an ES256
 * proof, so accepting one only converts a loud "wrong key" into a silent stream
 * of 401s. One predicate answers "is this the key INV-15 describes?".
 *
 * Used at BOTH ends of the key's life, with deliberately different consequences:
 *   - a LOADED record that fails it is treated as ABSENT (re-mint below), because
 *     the record is untrusted input — possibly written by an older or broken build.
 *   - a FRESHLY GENERATED key that fails it THROWS, because that means the runtime
 *     did not honor `extractable:false` and there is nothing safe to do with it.
 * @param {unknown} k
 * @returns {boolean}
 */
export const usableDpopPrivateKey = (k) => {
  if (typeof CryptoKey === 'undefined' || !(k instanceof CryptoKey)) return false;
  return k.type === 'private'
    && k.extractable === false
    && /** @type {any} */ (k.algorithm)?.name === 'ECDSA'
    && /** @type {any} */ (k.algorithm)?.namedCurve === 'P-256';
};

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
  // why a THROW and not a null: we asked for a key we cannot read and got back
  // something else. Returning null would degrade to an anonymous request and hide
  // it; throwing makes a runtime that ignores `extractable:false` a loud failure
  // that the boundary still converts to "send anonymous" one frame up.
  if (!usableDpopPrivateKey(pair.privateKey)) throw new Error('dpop: generated key is not a non-extractable P-256 private key');
  const publicJwk = publicJwkOnly(await s.exportKey('jwk', pair.publicKey));
  // A runtime that refuses to export the PUBLIC half of a non-extractable pair
  // would leave us unable to build a proof header at all; fail loudly here
  // rather than mint a headerless proof the server will reject.
  if (!publicJwk) throw new Error('dpop: public JWK unavailable');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicJwk };
};

/**
 * Build the persistence trio from injected IDB primitives (the production
 * wiring passes `egress.idb.get` / `.put` / `.del`). Keeping this a factory is
 * what lets `getOrCreateDpopKey` be tested against a plain Map.
 *
 * why `remove` exists: the keypair is HALF the credential. Revoking an
 * integration that only deleted the vault token left the keypair — and with it
 * the stable `jkt` the authorization server knows this device by — in IndexedDB
 * forever, so a later credential for the same origin would re-present the exact
 * fingerprint the user believed they had removed. Retiring a credential retires
 * both halves.
 * @param {{ get: (store: string, key: any) => Promise<any>, put: (store: string, value: any) => Promise<void>, del: (store: string, key: any) => Promise<void> }} idb
 * @returns {{ load: (origin: string) => Promise<any>, save: (record: DpopKeyRecord) => Promise<void>, remove: (origin: string) => Promise<void> }}
 */
export const makeDpopKeyStore = ({ get, put, del }) => ({
  load: (origin) => get(DPOP_KEY_STORE, origin),
  save: (record) => put(DPOP_KEY_STORE, record),
  remove: (origin) => del(DPOP_KEY_STORE, origin),
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
 * Fails CLOSED by returning null: a non-https/non-canonical origin, a store that
 * throws, or a generate that throws all yield null, and the boundary then sends
 * anonymous rather than an unbound token.
 *
 * THE LIFECYCLE RULE, and why it is a security rule: a key is minted ONLY when
 * `load` RESOLVED and held no usable record. An UNREADABLE store (load threw) is
 * NOT "no key" — it is "we don't know", and the two must never be conflated,
 * because the fall-through from "don't know" to mint-and-`put` would OVERWRITE the
 * very key it failed to read. The key IS the token binding: overwriting it retires
 * a `jkt` the authorization server has bound a live token to, so a transient IDB
 * hiccup would permanently 401 the integration with nothing in the logs to explain
 * it. Failing closed instead costs one anonymous request and self-heals on the
 * next call, when the store may well read fine.
 *
 * A record that loaded but is NOT the key INV-15 describes (`usableDpopPrivateKey`
 * — wrong type, extractable, wrong curve) is treated as ABSENT and re-minted: that
 * is a definite answer about a definitely-unusable record, not an unknown.
 *
 * A persist failure after a successful generate still returns the fresh key — the
 * request should work; it just re-mints next time.
 *
 * @param {string} origin  canonical https `URL.origin` (from authOriginForRequestUrl)
 * @param {{ load: (origin: string) => Promise<any>, save: (record: DpopKeyRecord) => Promise<void>,
 *           generate?: () => Promise<{ privateKey: CryptoKey, publicJwk: { kty: string, crv: string, x: string, y: string } }>,
 *           now?: () => number, audit?: (e: any) => void }} deps
 * @returns {Promise<{ privateKey: CryptoKey, publicJwk: { kty: string, crv: string, x: string, y: string } } | null>}
 */
export const getOrCreateDpopKey = async (origin, { load, save, generate, now, audit } = /** @type {any} */ ({})) => {
  const canonical = canonicalHttpsOrigin(origin);
  if (!canonical) return null;
  let loadFailed = false;
  try {
    const existing = await load(canonical);
    const publicJwk = existing ? publicJwkOnly(existing.publicJwk) : null;
    if (existing?.privateKey && publicJwk && usableDpopPrivateKey(existing.privateKey)) {
      return { privateKey: existing.privateKey, publicJwk };
    }
  } catch { loadFailed = true; }
  // Fail closed on "we don't know" — never mint over a key we could not read.
  if (loadFailed) return null;

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
  // why AUDIT a mint: a new key means a new `jkt`, which means every token bound to
  // the old one stops working. That is exactly the symptom (sudden 401s) a user
  // cannot otherwise diagnose, so a re-key must never be silent. The thumbprint is
  // public and is the only key-derived value safe to record.
  try { audit?.({ type: 'dpop_key_minted', details: { origin: canonical, jkt: await dpopJkt(fresh.publicJwk) } }); }
  catch { /* best effort — auditing never fails a request */ }
  return { privateKey: fresh.privateKey, publicJwk: fresh.publicJwk };
};

/**
 * The PUBLIC `jkt` thumbprint of this origin's STORED key — read-only, and
 * deliberately NOT mint-or-create. Null when there is no usable record, when the
 * store throws, or for a non-canonical origin.
 *
 * why a separate reader: listing credentials must never have the side effect of
 * minting a key (a list right after a revoke would resurrect the fingerprint the
 * user just removed). Surfacing what EXISTS and provisioning are different acts.
 * @param {string} origin
 * @param {{ load: (origin: string) => Promise<any> }} deps
 * @param {{ subtle?: SubtleCrypto }} [crypto0]
 * @returns {Promise<string | null>}
 */
export const loadDpopJkt = async (origin, { load } = /** @type {any} */ ({}), crypto0 = {}) => {
  const canonical = canonicalHttpsOrigin(origin);
  if (!canonical) return null;
  try {
    const existing = await load(canonical);
    const publicJwk = existing ? publicJwkOnly(existing.publicJwk) : null;
    if (!publicJwk || !usableDpopPrivateKey(existing.privateKey)) return null;
    return await dpopJkt(publicJwk, crypto0);
  } catch { return null; }
};

/**
 * Mint-or-load this origin's key and return its PUBLIC `jkt` thumbprint — the
 * value a user pastes into an authorization server's client registration so the
 * tokens it issues are bound to this device.
 *
 * why provisioning mints EAGERLY: the binding has to exist before the token is
 * issued, not after. Minting lazily on the first request meant there was no
 * thumbprint to register at the moment the user needed one — which is why DPoP
 * shipped unreachable. Null on any failure (fail closed, no throw).
 * @param {string} origin
 * @param {{ load: (origin: string) => Promise<any>, save: (record: DpopKeyRecord) => Promise<void>,
 *           generate?: () => Promise<{ privateKey: CryptoKey, publicJwk: { kty: string, crv: string, x: string, y: string } }>,
 *           now?: () => number, audit?: (e: any) => void }} deps
 * @param {{ subtle?: SubtleCrypto }} [crypto0]
 * @returns {Promise<string | null>}
 */
export const ensureDpopJkt = async (origin, deps, crypto0 = {}) => {
  const key = await getOrCreateDpopKey(origin, deps);
  return key ? dpopJkt(key.publicJwk, crypto0) : null;
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
