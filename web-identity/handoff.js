// @ts-check
// peerd-distributed/identity/handoff.js - the extension ↔ id.peerd.ai
// ceremony handoff (docs/design/portable-identity/ 04).
//
// The canonical RP page is a PURE PRF ORACLE: it runs the WebAuthn
// ceremony for the peerd.ai credential and returns the 32-byte PRF
// output - nothing else. It never sees the seed, the capsule, the
// recovery record, or the capsule key; all capsule crypto stays in the
// extension. The one secret that crosses (the PRF output) crosses only
// as AEAD ciphertext bound to a single live request:
//
//   extension                          id.peerd.ai (web-identity/)
//   ──────────                         ───────────────────────────
//   mint ephemeral ECDH P-256 (epk)
//   mint 32-byte challenge
//   open  {origin}/#req=b64(request) ─▶ parse + show consent
//                                       WebAuthn create()/get() with the
//                                         frozen PRF input (credential-
//                                         wrapper.js constants)
//                                       ECDH(pageEph, epk) → HKDF(salt=
//                                         challenge) → AES-GCM key
//   read #res=… off the tab URL     ◀─ location.replace('#res=b64(env)')
//   ECDH-decrypt, check challenge
//   derive KEK locally, wrap/unwrap CapK
//
// why fragment + AEAD instead of postMessage: fragments never reach a
// server, and the ciphertext in tab history is useless without the
// ephemeral private key, which lives only in the extension context that
// minted it and dies with the flow. No reliance on cross-scheme
// postMessage targetOrigin semantics, identical on Chrome and Firefox.
//
// SELF-CONTAINED ON PURPOSE: no imports. A byte-identical copy of this
// file ships on the static ceremony page (web-identity/handoff.js),
// where the extension's /shared/ helpers do not exist - CI asserts the
// two copies match (tests/peerd-distributed/identity-handoff.test.ts).

// FROZEN alongside the PRF constants (see credential-wrapper.js header):
// the RP ID is the anchor every passkey is minted against - changing it
// after first production mint orphans every credential. The ORIGIN may
// move between subdomains of the RP ID before launch; the RP ID may not.
export const IDENTITY_RP_ID = 'peerd.ai';
export const IDENTITY_RP_ORIGIN = 'https://id.peerd.ai';

// The PRF input every portable-identity credential is evaluated with -
// hashing the tag pins the input to exactly 32 bytes on every
// authenticator. Deterministic protocol state, never per-install; FROZEN
// (an input change orphans every passkey wrapper ever minted).
const PRF_INPUT_TAG = 'peerd.identity.credential.v1';
/** @returns {Promise<Uint8Array>} */
export const identityPrfInput = async () =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PRF_INPUT_TAG)));

export const HANDOFF_VERSION = 1;
const HANDOFF_HKDF_INFO = 'peerd/identity-handoff/v1';
const CHALLENGE_BYTES = 32;
const IV_BYTES = 12;
const FRAGMENT_MAX = 8192;
const FLOWS = Object.freeze(['register', 'get']);

export class IdentityHandoffError extends Error {
  /** @param {string} message @param {string} code @param {{ cause?: unknown }} [options] */
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = 'IdentityHandoffError';
    this.code = code;
  }
}

/** @param {Uint8Array} bytes */
const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
/** @param {string} b64 */
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const utf8 = (/** @type {string} */ s) => new TextEncoder().encode(s);

/** @param {Record<string, unknown>} value */
const encodeEnvelope = (value) => toB64(utf8(JSON.stringify(value)));
/** @param {string} b64 @param {string} what */
const decodeEnvelope = (b64, what) => {
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length > FRAGMENT_MAX) {
    throw new IdentityHandoffError(`${what} is missing or oversized`, 'bad-envelope');
  }
  try {
    return JSON.parse(new TextDecoder().decode(fromB64(b64)));
  } catch (cause) {
    throw new IdentityHandoffError(`${what} is not decodable`, 'bad-envelope', { cause });
  }
};

// P-256 everywhere: universal WebCrypto support (X25519 is not there yet
// on every target this page must serve).
const ECDH_PARAMS = Object.freeze({ name: 'ECDH', namedCurve: 'P-256' });

/** @param {any} jwk  bounded public-key JWK check before importKey sees it */
const validatePublicJwk = (jwk) => {
  if (!jwk || typeof jwk !== 'object') return 'not-an-object';
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return 'wrong-curve';
  if (typeof jwk.x !== 'string' || jwk.x.length === 0 || jwk.x.length > 64) return 'bad-x';
  if (typeof jwk.y !== 'string' || jwk.y.length === 0 || jwk.y.length > 64) return 'bad-y';
  if (jwk.d !== undefined) return 'private-material';
  return null;
};

/** @param {any} jwk @param {string} what */
const importPeerPublicKey = async (jwk, what) => {
  const defect = validatePublicJwk(jwk);
  if (defect) throw new IdentityHandoffError(`${what} public key rejected: ${defect}`, 'bad-public-key');
  // Strip to exactly the fields a public EC JWK needs - nothing an
  // untrusted envelope smuggles alongside survives.
  const { kty, crv, x, y } = jwk;
  try {
    return await crypto.subtle.importKey('jwk', { kty, crv, x, y }, ECDH_PARAMS, false, []);
  } catch (cause) {
    throw new IdentityHandoffError(`${what} public key is not a valid P-256 point`, 'bad-public-key', { cause });
  }
};

/**
 * ECDH → HKDF(salt=challenge, info=fixed) → one-shot AES-GCM key. The
 * challenge in the salt binds the key to this request; a replayed
 * response against a fresh request derives a different key and fails
 * authentication.
 *
 * @param {CryptoKey} privateKey  this side's ECDH private key
 * @param {CryptoKey} publicKey   the peer's imported public key
 * @param {Uint8Array} challenge
 */
const deriveHandoffKey = async (privateKey, publicKey, challenge) => {
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  // Wipe the raw ECDH secret now that it lives inside the non-extractable
  // HKDF handle. Honesty note: the PRF output also travels base64-inside-
  // JSON through this module, and JS strings cannot be wiped - buffer
  // fills here reduce lifetime, they do not guarantee erasure.
  new Uint8Array(shared).fill(0);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: /** @type {BufferSource} */ (challenge),
      info: utf8(HANDOFF_HKDF_INFO),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

/**
 * EXTENSION SIDE - mint a ceremony request. The private key never leaves
 * the calling context; hold it in memory for the life of the flow and
 * drop it (it is non-extractable, and single-use by contract).
 *
 * @param {Object} args
 * @param {'register' | 'get'} args.flow
 * @param {string | null} [args.credentialId]  routes a 'get' straight to
 *        the enrolled credential; omitted → discoverable-credential picker
 * @param {string[] | null} [args.transports]
 * @returns {Promise<{ request: any, privateKey: CryptoKey, challenge: Uint8Array }>}
 */
export const createHandoffRequest = async ({ flow, credentialId = null, transports = null }) => {
  if (!FLOWS.includes(flow)) throw new IdentityHandoffError(`unknown flow ${flow}`, 'bad-flow');
  const keyPair = /** @type {CryptoKeyPair} */ (
    await crypto.subtle.generateKey(ECDH_PARAMS, false, ['deriveBits', 'deriveKey']));
  const challenge = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES));
  const epk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  delete epk.key_ops;
  delete epk.ext;
  return {
    request: {
      v: HANDOFF_VERSION,
      flow,
      challenge: toB64(challenge),
      epk,
      credentialId,
      transports,
    },
    privateKey: keyPair.privateKey,
    challenge,
  };
};

/**
 * Both sides - the ceremony URL the extension opens, and the request the
 * page parses back out of its own fragment.
 * @param {string} origin @param {any} request
 */
export const buildCeremonyUrl = (origin, request) =>
  `${origin}/#req=${encodeURIComponent(encodeEnvelope(request))}`;

/**
 * Guarded percent-decoding: a malformed sequence in a fragment we do not
 * control (any page can navigate a watched tab) must surface as this
 * module's typed refusal or a calm null, never a bare URIError.
 * @param {string} value
 */
const decodePercent = (value) => {
  try { return decodeURIComponent(value); } catch { return null; }
};

/** @param {string} fragment  location.hash with or without the leading '#' */
export const parseCeremonyRequest = (fragment) => {
  const raw = /** @type {string} */ (fragment ?? '').replace(/^#/, '');
  const match = /^req=(.+)$/.exec(raw);
  if (!match) return null;
  const decoded = decodePercent(match[1]);
  if (decoded === null) throw new IdentityHandoffError('ceremony request is not decodable', 'bad-envelope');
  const request = decodeEnvelope(decoded, 'ceremony request');
  if (request?.v !== HANDOFF_VERSION) throw new IdentityHandoffError(`unsupported handoff version ${request?.v}`, 'bad-version');
  if (!FLOWS.includes(request.flow)) throw new IdentityHandoffError(`unknown flow ${request.flow}`, 'bad-flow');
  const challenge = (() => {
    try { return fromB64(request.challenge); } catch { return new Uint8Array(0); }
  })();
  if (challenge.length !== CHALLENGE_BYTES) throw new IdentityHandoffError('bad challenge', 'bad-challenge');
  const epkDefect = validatePublicJwk(request.epk);
  if (epkDefect) throw new IdentityHandoffError(`bad request key: ${epkDefect}`, 'bad-public-key');
  if (request.credentialId != null
      && (typeof request.credentialId !== 'string' || request.credentialId.length > 2048)) {
    throw new IdentityHandoffError('bad credentialId', 'bad-credential-id');
  }
  const transports = Array.isArray(request.transports)
    ? request.transports.filter((/** @type {unknown} */ t) => typeof t === 'string' && t.length <= 32).slice(0, 8)
    : null;
  const { kty, crv, x, y } = request.epk;
  // Rebuild from the validated fields only: nothing an untrusted fragment
  // smuggles alongside survives into the parsed request.
  return {
    v: request.v,
    flow: request.flow,
    challenge: request.challenge,
    epk: { kty, crv, x, y },
    credentialId: request.credentialId ?? null,
    transports,
    challengeBytes: challenge,
  };
};

/**
 * PAGE SIDE - seal the ceremony result to the requesting extension.
 * @param {Object} args
 * @param {any} args.request  the parsed ceremony request
 * @param {Uint8Array} args.prfOutput
 * @param {string | null} [args.credentialId]
 * @param {string[] | null} [args.transports]
 * @returns {Promise<string>} the value for `#res=`
 */
export const sealHandoffResponse = async ({ request, prfOutput, credentialId = null, transports = null }) => {
  if (!(prfOutput instanceof Uint8Array) || prfOutput.byteLength !== 32) {
    throw new IdentityHandoffError('PRF output must be exactly 32 bytes', 'bad-prf-output');
  }
  const extensionKey = await importPeerPublicKey(request.epk, 'request');
  const challenge = fromB64(request.challenge);
  const pageKeys = /** @type {CryptoKeyPair} */ (
    await crypto.subtle.generateKey(ECDH_PARAMS, false, ['deriveBits', 'deriveKey']));
  const key = await deriveHandoffKey(pageKeys.privateKey, extensionKey, challenge);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = utf8(JSON.stringify({
    v: HANDOFF_VERSION,
    challenge: request.challenge,
    prfOutput: toB64(prfOutput),
    credentialId,
    transports,
  }));
  let ct;
  try {
    ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  } finally {
    plaintext.fill(0);
  }
  const epk = await crypto.subtle.exportKey('jwk', pageKeys.publicKey);
  delete epk.key_ops;
  delete epk.ext;
  return encodeEnvelope({ v: HANDOFF_VERSION, epk, iv: toB64(iv), ct: toB64(ct) });
};

/** The page navigates here when done; the extension watches the tab URL. */
/** @param {string} origin @param {string} sealedResponse */
export const buildReturnUrl = (origin, sealedResponse) =>
  `${origin}/#res=${encodeURIComponent(sealedResponse)}`;

/**
 * EXTENSION SIDE - pull `#res=` off a watched tab URL. Returns null while
 * the ceremony is still in progress (no res fragment yet).
 * @param {string} url
 */
export const extractSealedResponse = (url) => {
  let hash;
  try { hash = new URL(url).hash; } catch { return null; }
  const match = /^#res=(.+)$/.exec(hash);
  return match ? decodePercent(match[1]) : null;
};

/**
 * EXTENSION SIDE - open the sealed response. Verifies the echoed
 * challenge before anything else is trusted.
 *
 * @param {Object} args
 * @param {string} args.sealedResponse
 * @param {CryptoKey} args.privateKey   from createHandoffRequest
 * @param {Uint8Array} args.challenge   from createHandoffRequest
 * @returns {Promise<{ prfOutput: Uint8Array, credentialId: string | null, transports: string[] | null }>}
 */
export const openHandoffResponse = async ({ sealedResponse, privateKey, challenge }) => {
  const envelope = decodeEnvelope(sealedResponse, 'ceremony response');
  if (envelope?.v !== HANDOFF_VERSION) throw new IdentityHandoffError(`unsupported handoff version ${envelope?.v}`, 'bad-version');
  const pageKey = await importPeerPublicKey(envelope.epk, 'response');
  const key = await deriveHandoffKey(privateKey, pageKey, challenge);
  let parsed;
  try {
    const iv = fromB64(envelope.iv);
    if (iv.length !== IV_BYTES) throw new Error('bad iv length');
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv, }, key, fromB64(envelope.ct)));
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
    plaintext.fill(0);
  } catch (cause) {
    throw new IdentityHandoffError('ceremony response could not be authenticated', 'open-failed', { cause });
  }
  if (parsed?.challenge !== toB64(challenge)) {
    throw new IdentityHandoffError('ceremony response answers a different request', 'challenge-mismatch');
  }
  const prfOutput = (() => {
    try { return fromB64(parsed.prfOutput); } catch { return new Uint8Array(0); }
  })();
  if (prfOutput.length !== 32) throw new IdentityHandoffError('response carries no PRF output', 'bad-prf-output');
  return {
    prfOutput,
    credentialId: typeof parsed.credentialId === 'string' ? parsed.credentialId : null,
    transports: Array.isArray(parsed.transports)
      ? parsed.transports.filter((/** @type {unknown} */ t) => typeof t === 'string').slice(0, 8)
      : null,
  };
};
