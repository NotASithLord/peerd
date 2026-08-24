// @ts-check
// dpop/sign — the signing shell for RFC 9449 proofs. Composes the pure proof
// shape (dpop/proof.js) with WebCrypto ECDSA. Kept out of dpop/keys.js so the
// cold authority kernel's key-custody graph never evaluates proof shaping;
// only the egress boundary (fetch/web-fetch.js) needs this module.

import { assembleProof, buildProofInput } from './proof.js';
import { base64url, ES256_SIGN_PARAMS, utf8Bytes } from './jwk.js';

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
 * `nonce` is the RFC 9449 §8 server challenge — passed straight through to
 * buildProofInput, which owns the claim's shape. The boundary supplies it from
 * the per-origin cache in dpop/nonce.js (see fetch/web-fetch.js for the one-shot
 * retry that re-signs with a freshly issued one).
 *
 * @param {{ privateKey?: CryptoKey, publicJwk?: unknown, method?: unknown, url?: unknown,
 *           jti?: unknown, iatSeconds?: unknown, accessTokenHash?: unknown, nonce?: unknown }} arg
 * @param {{ subtle?: SubtleCrypto }} [deps]
 * @returns {Promise<string | null>}
 */
export const signDpopProof = async (
  { privateKey, publicJwk, method, url, jti, iatSeconds, accessTokenHash, nonce } = {},
  { subtle } = {},
) => {
  if (!privateKey) return null;
  const built = buildProofInput({ publicJwk, method, url, jti, iatSeconds, accessTokenHash, nonce });
  if (!built) return null;
  try {
    const signature = await (subtle ?? crypto.subtle).sign(ES256_SIGN_PARAMS, privateKey, /** @type {BufferSource} */ (utf8Bytes(built.signingInput)));
    return assembleProof(built.signingInput, signature);
  } catch { return null; }
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

