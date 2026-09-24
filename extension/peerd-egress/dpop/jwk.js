// @ts-check
// dpop/jwk: pure byte and JWK primitives shared by proof shaping
// (dpop/proof.js), key custody (dpop/keys.js), and proof signing
// (dpop/sign.js). No IO, no crypto calls, no clock: keeping this leaf tiny is
// what lets the cold authority kernel own the DPoP key lifecycle without
// evaluating the proof-shaping module on first wake.

/** ECDSA P-256 / SHA-256, the `ES256` of the JOSE header. */
export const ES256_KEY_PARAMS = /** @type {EcKeyGenParams} */ ({ name: 'ECDSA', namedCurve: 'P-256' });
export const ES256_SIGN_PARAMS = /** @type {EcdsaParams} */ ({ name: 'ECDSA', hash: 'SHA-256' });

/**
 * base64url (RFC 4648 §5) of raw bytes, without padding.
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
 * UTF-8 bytes of a string. JWS signs over the UTF-8
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
 * Reduce a JWK to EXACTLY its public members for P-256: `{kty, crv, x, y}`.
 * Drops `d` (the private scalar), `key_ops`, `ext`, `alg`, `kid` and anything
 * else. Returns null if any required member is missing or not a string.
 * why this is load-bearing twice: the proof header must never carry private
 * material, and RFC 7638's thumbprint input is defined as exactly these members
 * so one function guarantees both.
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
 * members in lexicographic order with no whitespace: `crv`, `kty`, `x`, `y`.
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
