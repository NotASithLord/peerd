// @ts-check
// WebAuthn PRF helpers — passkey unlock for the vault. Works with both
// platform authenticators (Touch ID / Windows Hello) and roaming
// hardware security keys (YubiKey etc.); the PRF output is the same
// 32 bytes either way.
//
// What lives here
// ---------------
// Pure wrappers around `navigator.credentials.create()` and `.get()` with
// the PRF extension. These functions must run in a document context — a
// service worker cannot call WebAuthn directly. In the V1 wiring the side
// panel is the document; it calls these helpers, gets back the 32-byte
// PRF output, and ships it to the SW where the vault treats it as raw
// key material for an AES-KW KEK.
//
// What deliberately does NOT live here
// ------------------------------------
//  - Anything that touches the vault DK. The PRF output is just bytes to
//    this file; deriving a KEK and wrapping/unwrapping the DK is the
//    vault's job (vault.js + keys.js).
//  - Storage. We don't read or write kv here — the caller (vault) does
//    that. Keeps the WebAuthn-side and crypto-side concerns separable.
//  - The SW message protocol. The SW glues this to the vault.
//
// Why PRF and not just "the credential is the key"
// -----------------------------------------------
// WebAuthn credentials don't directly expose any key material to JS. The
// `prf` extension is the only path: the authenticator computes
// HMAC(credentialSecret, salt) inside the secure element and returns 32
// bytes that JS can use as a symmetric key. The salt is chosen by us and
// stored with the vault — same salt + same credential → same 32 bytes
// every time. Different salt → different bytes (so we can derive multiple
// keys from one credential if needed later).
//
// Browser support: Chrome 116+ (Mac Touch ID, Windows Hello), Safari
// 18.5+, Firefox 137+ (behind a flag in some channels). Older browsers
// return undefined for `getClientExtensionResults().prf`, which we treat
// as "PRF not available" and surface as PrfNotSupportedError.

import {
  authenticatorSelectionFor,
  evaluateCreatePrf,
  allowCredentialDescriptor,
  sanitizeTransports,
} from './enroll-options.js';

const PRF_SALT_BYTES = 32;
const USER_HANDLE_BYTES = 16;
const CHALLENGE_BYTES = 32;

const RP_NAME = 'peerd';

/**
 * Per-credential PRF context the vault stores so future unlocks can
 * reproduce the same 32-byte PRF output from the same authenticator.
 *
 * @typedef {Object} PrfContext
 * @property {Uint8Array} credentialId   The authenticator's credential ID.
 * @property {Uint8Array} prfSalt        Fixed 32 bytes used as PRF input.
 * @property {string[] | null} [transports]  AuthenticatorTransport hints
 *           recorded at enrollment (response.getTransports()); lets the
 *           unlock prompt route straight to the right authenticator
 *           class. Absent/null on pre-transports enrollments.
 */

/**
 * @typedef {Object} PrfEnrollResult
 * @property {Uint8Array} credentialId
 * @property {Uint8Array} prfSalt
 * @property {Uint8Array} prfOutput      32 bytes of HMAC output from the authenticator.
 * @property {string[] | null} transports  getTransports() of the new credential, or null.
 */

export class PrfNotSupportedError extends Error {
  constructor(msg = 'WebAuthn PRF extension is not supported in this browser/authenticator.') {
    super(msg); this.name = 'PrfNotSupportedError';
  }
}

export class PrfCancelledError extends Error {
  constructor(msg = 'WebAuthn ceremony was cancelled or denied.') {
    super(msg); this.name = 'PrfCancelledError';
  }
}

/**
 * The ceremony succeeded but THIS authenticator cannot evaluate the PRF
 * (hmac-secret) extension — so it could never produce the vault KEK.
 * Distinct from PrfNotSupportedError (the BROWSER can't do WebAuthn/PRF
 * at all): here the fix is a different authenticator (YubiKey 5+, a
 * recent platform authenticator) or the passphrase, not a different
 * browser. Enrollment MUST fail on this error — a credential that can't
 * do PRF would lock the user out the moment the vault locks.
 */
export class PrfUnsupportedByAuthenticatorError extends Error {
  constructor(msg = 'This authenticator cannot protect the vault key (no PRF/hmac-secret support). Use a different authenticator or a passphrase.') {
    super(msg); this.name = 'PrfUnsupportedByAuthenticatorError';
  }
}

/**
 * Cheap feature detection. Returns false where WebAuthn is missing
 * entirely; can't detect whether the authenticator supports PRF without
 * actually issuing a ceremony. UI should call this before showing the
 * "Enroll Touch ID" affordance.
 *
 * @returns {boolean}
 */
export const isWebAuthnAvailable = () => {
  // why: navigator.credentials is missing in MV3 SW contexts even at
  // runtime; guard so this file is safe to import-but-not-call from
  // anywhere.
  return typeof navigator !== 'undefined'
    && typeof navigator.credentials !== 'undefined'
    && typeof navigator.credentials.create === 'function'
    && typeof PublicKeyCredential !== 'undefined';
};

/**
 * Imperative capability probe — the IO half of the enrollment planner.
 * Runs the two detection APIs and returns raw facts; the pure decision
 * (which enrollment choices to offer) lives in enroll-options.js
 * (planEnrollment), so it stays Bun-testable.
 *
 * Both probes are individually fault-tolerant: a throwing probe yields
 * null ("unknown"), never false — planEnrollment only narrows the offer
 * on a definite "no".
 *
 * @returns {Promise<import('./enroll-options.js').CapabilityProbe>}
 */
export const probeWebAuthnCapabilities = async () => {
  if (!isWebAuthnAvailable()) {
    return { webAuthnAvailable: false, platformAuthenticator: null, clientCapabilities: null };
  }
  let platformAuthenticator = null;
  try {
    platformAuthenticator =
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { /* probe failed → unknown */ }
  let clientCapabilities = null;
  try {
    // Chrome 133+ / Safari 17.4+; absent elsewhere. Carries client-level
    // PRF support ('extension:prf') the older probe can't see.
    if (typeof PublicKeyCredential.getClientCapabilities === 'function') {
      clientCapabilities = await PublicKeyCredential.getClientCapabilities();
    }
  } catch { /* probe failed → unknown */ }
  return { webAuthnAvailable: true, platformAuthenticator, clientCapabilities };
};

/**
 * getTransports() is on AuthenticatorAttestationResponse (Chrome 74+,
 * Safari 16+, Firefox 119+); guard + sanitize so a missing method or an
 * exotic return shape degrades to null (= store nothing) instead of
 * failing an otherwise-good enrollment.
 */
/** @param {PublicKeyCredential} credential */
const readTransports = (credential) => {
  try {
    // getTransports() lives on AuthenticatorAttestationResponse (create()
    // path); the base AuthenticatorResponse type doesn't declare it, so
    // narrow before the guarded probe.
    const response = /** @type {AuthenticatorAttestationResponse} */ (credential?.response);
    return sanitizeTransports(response?.getTransports?.());
  } catch {
    return null;
  }
};

/**
 * Enroll an authenticator and capture the first PRF output in the same
 * ceremony.
 *
 * Chrome supports `prf.eval` directly in `create()` (return PRF output
 * at enrollment time). Some older browsers/authenticators require a
 * follow-up `get()` to materialise the PRF. We use the
 * single-ceremony path; if `prf.results.first` comes back undefined we
 * fall back to an immediate `get()` against the freshly created
 * credential to get the bytes — same UX (one Touch ID tap) when the
 * one-shot path works, two taps when it doesn't.
 *
 * PRF honesty: if the create() extension results say the authenticator
 * CANNOT do PRF (`enabled: false`) — or the follow-up get() comes back
 * without PRF bytes — the enrollment FAILS with
 * PrfUnsupportedByAuthenticatorError. We never hand the caller a
 * credential that can't actually unlock the vault. (The orphan
 * credential left on the authenticator is inert — it wraps nothing —
 * and can be removed via the OS/key's passkey manager.)
 *
 * @param {Object} [opts]
 * @param {import('./enroll-options.js').EnrollFlavor} [opts.flavor]
 *        'platform' (Touch ID / Windows Hello) or 'security-key'
 *        (roaming FIDO2 key). Omitted → the browser's full picker,
 *        which is the pre-flavor behavior.
 * @returns {Promise<PrfEnrollResult>}
 */
export const enrollWithPrf = async ({ flavor } = {}) => {
  if (!isWebAuthnAvailable()) throw new PrfNotSupportedError();

  const prfSalt = crypto.getRandomValues(new Uint8Array(PRF_SALT_BYTES));
  const userId = crypto.getRandomValues(new Uint8Array(USER_HANDLE_BYTES));
  const challenge = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES));

  /** @type {PublicKeyCredentialCreationOptions} */
  const publicKey = {
    rp: { name: RP_NAME },
    user: {
      id: userId,
      name: 'peerd-vault',
      displayName: 'peerd vault',
    },
    challenge,
    pubKeyCredParams: [
      // why: ed25519 is preferred where available (smaller, simpler);
      // ECDSA-P256 is the universal floor for platform authenticators.
      { type: 'public-key', alg: -8 },   // Ed25519
      { type: 'public-key', alg: -7 },   // ES256
      { type: 'public-key', alg: -257 }, // RS256 (Windows Hello fallback)
    ],
    // why per-flavor attachment (pure table in enroll-options.js): the
    // UI offers explicit "this device" / "security key" paths, each
    // pinning the matching attachment so the browser sheet goes straight
    // to the chosen authenticator class. No flavor → no attachment → the
    // browser's full picker, exactly the pre-flavor behavior. Both
    // flavors produce the same 32-byte PRF output; the vault treats them
    // identically, and the unlock ceremony never pins attachment at all.
    authenticatorSelection: authenticatorSelectionFor(flavor),
    timeout: 60_000,
    attestation: 'none',
    extensions: {
      prf: { eval: { first: prfSalt } },
    },
  };

  /** @type {PublicKeyCredential | null} */
  let credential;
  try {
    // why the cast: create({ publicKey }) returns the base Credential type,
    // but the publicKey ceremony always yields a PublicKeyCredential.
    credential = /** @type {PublicKeyCredential | null} */ (
      await navigator.credentials.create({ publicKey }));
  } catch (e) {
    const err = /** @type {{ name?: string }} */ (e);
    if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') {
      throw new PrfCancelledError();
    }
    throw e;
  }
  if (!credential) throw new PrfCancelledError();

  const credentialId = new Uint8Array(credential.rawId);
  const transports = readTransports(credential);
  const ext = credential.getClientExtensionResults?.();
  const verdict = evaluateCreatePrf(ext);

  // why fail HERE, not at first unlock: PRF support varies per
  // authenticator (YubiKey 5+ yes; some platform authenticators and
  // older keys no). The client tells us at create() time via
  // prf.enabled — enrolling anyway would store a wrap nothing can ever
  // open and strand the user at the next lock.
  if (verdict === 'unsupported') throw new PrfUnsupportedByAuthenticatorError();

  if (verdict === 'ready') {
    // 'ready' is exactly the verdict evaluateCreatePrf returns when
    // prf.results.first is present, so the access below is sound. The PRF
    // output is an ArrayBuffer at runtime (HMAC bytes from the
    // authenticator), narrower than the spec's BufferSource.
    const ready = /** @type {{ prf: { results: { first: ArrayBuffer } } }} */ (ext);
    return {
      credentialId,
      prfSalt,
      prfOutput: new Uint8Array(ready.prf.results.first),
      transports,
    };
  }

  // Single-ceremony PRF wasn't returned (older authenticator). Do a
  // follow-up get() to fetch the PRF output. Same authenticator, same
  // salt → same 32 bytes; this is two taps but still gets us enrolled.
  try {
    const prfOutput = await getPrfOutput({ credentialId, prfSalt, transports });
    return { credentialId, prfSalt, prfOutput, transports };
  } catch (e) {
    // why re-map: in the enrollment flow a PRF-less get() result means
    // THIS authenticator can't do PRF (the browser clearly can — it just
    // ran two ceremonies). Surfacing browser-level PrfNotSupportedError
    // would tell the user to switch browsers when the fix is a different
    // authenticator or the passphrase.
    if (e instanceof PrfNotSupportedError) throw new PrfUnsupportedByAuthenticatorError();
    throw e;
  }
};

/**
 * Unlock-path: get the PRF output for a previously enrolled credential.
 *
 * @param {PrfContext} ctx
 * @returns {Promise<Uint8Array>}   32 bytes of PRF output
 */
export const getPrfOutput = async ({ credentialId, prfSalt, transports }) => {
  if (!isWebAuthnAvailable()) throw new PrfNotSupportedError();

  const challenge = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES));

  /** @type {PublicKeyCredentialRequestOptions} */
  const publicKey = {
    challenge,
    // why transports (when recorded at enrollment): they route the
    // browser's prompt to the right authenticator class — a security-key
    // enrollment asks for the key instead of poking Touch ID. Omitted
    // (every pre-transports enrollment) the platform tries everything,
    // which is the legacy behavior. Never an attachment restriction —
    // the trust model is identical either way (still gated by user
    // verification on the one enrolled credential).
    allowCredentials: [allowCredentialDescriptor({ credentialId, transports })],
    userVerification: 'required',
    timeout: 60_000,
    extensions: {
      // why the cast: prfSalt is a plain Uint8Array; the DOM PRF input type
      // is BufferSource, which excludes the SAB-backed Uint8Array variant
      // the type system assumes but this code never produces.
      prf: { eval: { first: /** @type {BufferSource} */ (prfSalt) } },
    },
  };

  /** @type {PublicKeyCredential | null} */
  let assertion;
  try {
    assertion = /** @type {PublicKeyCredential | null} */ (
      await navigator.credentials.get({ publicKey }));
  } catch (e) {
    const err = /** @type {{ name?: string }} */ (e);
    if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') {
      throw new PrfCancelledError();
    }
    throw e;
  }
  if (!assertion) throw new PrfCancelledError();

  const ext = assertion.getClientExtensionResults?.();
  const firstBuf = ext?.prf?.results?.first;
  if (!firstBuf) {
    // why: authenticator silently dropped the PRF extension. Surface
    // this as unsupported so the UI can offer to disable the Touch ID
    // path rather than infinite-loop the user through a useless
    // ceremony.
    throw new PrfNotSupportedError();
  }
  // The PRF output is an ArrayBuffer at runtime — narrower than the spec's
  // BufferSource, which Uint8Array's constructor won't take as a view.
  return new Uint8Array(/** @type {ArrayBuffer} */ (firstBuf));
};
