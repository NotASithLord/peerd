// @ts-check
// Pure enrollment-planning logic for the WebAuthn PRF unlock path.
//
// Functional core for webauthn.js's imperative shell: capability-probe
// results go in, enrollment decisions come out. Nothing here touches
// navigator.credentials, navigator.userAgentData, or storage — every
// function is values-in/values-out so the whole decision table is
// Bun-testable without a browser.
//
// The probe inputs come from two browser APIs (run by the caller):
//   - PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
//     — "does THIS machine have Touch ID / Windows Hello / a screen-lock
//     authenticator?" Universally available wherever WebAuthn is.
//   - PublicKeyCredential.getClientCapabilities() — richer map (Chrome
//     133+ / Safari 17.4+), including `extension:prf` (can this CLIENT
//     run the PRF extension at all?) and
//     `userVerifyingPlatformAuthenticator` (same fact as the first
//     probe). Missing on older browsers — treat absence as "unknown",
//     never as "no".

/**
 * @typedef {'platform' | 'security-key'} EnrollFlavor
 *
 * @typedef {Object} CapabilityProbe
 * @property {boolean} webAuthnAvailable          navigator.credentials.create exists
 * @property {boolean | null} platformAuthenticator  isUVPAA() result; null = probe failed
 * @property {PublicKeyCredentialClientCapabilities | null} clientCapabilities
 *           getClientCapabilities() result (a Record<string, boolean>);
 *           null = unavailable
 *
 * @typedef {Object} EnrollmentPlan
 * @property {EnrollFlavor[]} paths   Ordered choices to offer (first = lead).
 * @property {'supported' | 'unsupported' | 'unknown'} prfHint
 *           Client-level PRF support. 'unsupported' means NO authenticator
 *           can produce the vault KEK through this browser — paths is
 *           empty and the UI should route to the passphrase.
 */

/**
 * Decide which enrollment choices to offer from the probe results.
 *
 * Rules:
 *  - No WebAuthn → nothing to offer.
 *  - getClientCapabilities() says the client can't do the PRF extension
 *    → nothing to offer: a credential that can't run PRF can never
 *    unlock the vault, so offering enrollment would be a lie. Absence
 *    of the capability map (older browsers) is NOT a "no" — we proceed
 *    and let the post-create() PRF check be the honest gate.
 *  - A security key ("cross-platform") is ALWAYS offered — hardware
 *    keys are pluggable, so their absence right now proves nothing.
 *  - The platform path leads when either probe says a platform
 *    authenticator exists.
 *
 * @param {CapabilityProbe} probe
 * @returns {EnrollmentPlan}
 */
export const planEnrollment = ({ webAuthnAvailable, platformAuthenticator, clientCapabilities }) => {
  if (!webAuthnAvailable) return { paths: [], prfHint: 'unknown' };

  const caps = clientCapabilities ?? null;
  // why bracket access + explicit === checks: capability keys for
  // WebAuthn extensions are spec-named "extension:<id>", and the map
  // may omit keys entirely (= unknown) — undefined must not collapse
  // into false.
  const prfCap = caps ? caps['extension:prf'] : undefined;
  const prfHint = prfCap === true ? 'supported'
    : prfCap === false ? 'unsupported'
    : 'unknown';
  if (prfHint === 'unsupported') return { paths: [], prfHint };

  const hasPlatform = platformAuthenticator === true
    || (caps ? caps.userVerifyingPlatformAuthenticator === true : false);
  return {
    paths: hasPlatform ? ['platform', 'security-key'] : ['security-key'],
    prfHint,
  };
};

/**
 * authenticatorSelection criteria per enrollment flavor.
 *
 *  - 'platform'      → pin attachment to the built-in authenticator
 *                      (Touch ID / Windows Hello), skipping the QR /
 *                      hybrid / USB chooser noise.
 *  - 'security-key'  → pin to 'cross-platform' so the browser prompts
 *                      for a roaming FIDO2 key (YubiKey etc.).
 *  - anything else   → NO attachment: the browser's full picker. This
 *                      is the pre-flavor behavior — kept as the default
 *                      so existing call sites (and any enrollment made
 *                      before the flavored UI) behave exactly as before.
 *
 * residentKey 'required' in all flavors: the credential must be
 * discoverable (no username to remember at unlock). userVerification
 * 'required': the PRF output gates the vault DK; possession alone is
 * not enough.
 *
 * @param {EnrollFlavor | undefined} flavor
 * @returns {AuthenticatorSelectionCriteria}
 */
export const authenticatorSelectionFor = (flavor) => {
  /** @type {AuthenticatorSelectionCriteria} */
  const base = { residentKey: 'required', userVerification: 'required' };
  if (flavor === 'platform') return { ...base, authenticatorAttachment: 'platform' };
  if (flavor === 'security-key') return { ...base, authenticatorAttachment: 'cross-platform' };
  return base;
};

/**
 * Classify the PRF extension output of a create() ceremony.
 *
 *  - 'ready'       → the authenticator evaluated PRF during create();
 *                    `results.first` carries the 32 bytes.
 *  - 'unsupported' → the client says this authenticator cannot do PRF
 *                    (`enabled: false`). Enrollment MUST fail — this
 *                    credential could never unlock the vault.
 *  - 'follow-up'   → PRF is supported but wasn't evaluated at create()
 *                    (`enabled: true`, no results — some browsers only
 *                    evaluate on get()), or the client predates PRF
 *                    create()-results entirely (no prf entry). Run a
 *                    get() against the fresh credential; ITS result is
 *                    the honest verdict.
 *
 * @param {AuthenticationExtensionsClientOutputs | undefined} ext
 *        credential.getClientExtensionResults()
 * @returns {'ready' | 'unsupported' | 'follow-up'}
 */
export const evaluateCreatePrf = (ext) => {
  const prf = ext?.prf;
  if (prf?.results?.first) return 'ready';
  if (prf?.enabled === false) return 'unsupported';
  return 'follow-up';
};

// AuthenticatorTransport strings are short tokens ('usb', 'nfc', 'ble',
// 'hybrid', 'internal', …). Bounds are deliberately loose — future
// transports must round-trip — but big enough garbage is dropped so a
// tampered blob can't bloat allowCredentials.
const MAX_TRANSPORTS = 8;
const MAX_TRANSPORT_LEN = 32;

/**
 * Sanitize a transports list for storage / for allowCredentials.
 * Accepts what response.getTransports() returned at enrollment (or what
 * the blob stored). Returns a deduped string array, or null when there
 * is nothing usable — callers omit the field entirely on null, which is
 * also the shape for every pre-transports enrollment (additive schema).
 *
 * @param {unknown} value
 * @returns {string[] | null}
 */
export const sanitizeTransports = (value) => {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  for (const t of value) {
    if (seen.size >= MAX_TRANSPORTS) break;
    if (typeof t === 'string' && t.length > 0 && t.length <= MAX_TRANSPORT_LEN) seen.add(t);
  }
  return seen.size > 0 ? [...seen] : null;
};

/**
 * Build the allowCredentials descriptor for the unlock ceremony.
 * Transports recorded at enrollment let the browser route the prompt
 * straight to the right authenticator class (a security-key enrollment
 * prompts "insert your key" instead of poking Touch ID). Omitted when
 * unknown — the browser then tries everything, which is the legacy
 * behavior every pre-transports enrollment keeps.
 *
 * @param {{ credentialId: Uint8Array, transports?: unknown }} args
 * @returns {PublicKeyCredentialDescriptor}
 */
export const allowCredentialDescriptor = ({ credentialId, transports }) => {
  // why the casts: (1) sanitizeTransports keeps transports as loose strings
  // on purpose (future transport tokens must round-trip — see its header),
  // but the DOM type pins them to the closed AuthenticatorTransport union;
  // at runtime these are exactly what getTransports() returned. (2) a plain
  // Uint8Array's ArrayBufferLike backing isn't a BufferSource to the DOM
  // types (it admits SharedArrayBuffer), which the vault never produces.
  const t = /** @type {AuthenticatorTransport[] | null} */ (sanitizeTransports(transports));
  return {
    type: 'public-key',
    id: /** @type {BufferSource} */ (credentialId),
    ...(t ? { transports: t } : {}),
  };
};

/**
 * Human label for the platform authenticator, from a UA platform string
 * (navigator.userAgentData?.platform ?? navigator.platform).
 *
 * LABEL ONLY — never behavior. The enrollment flow is identical on
 * every OS; this just lets the button say "Touch ID" instead of the
 * abstract "passkey" where we can tell. Unknown platforms get null and
 * the UI falls back to generic copy.
 *
 * @param {unknown} platform
 * @returns {string | null}
 */
export const platformAuthenticatorLabel = (platform) => {
  if (typeof platform !== 'string') return null;
  const p = platform.toLowerCase();
  // 'mac' covers 'macOS' (userAgentData) and 'MacIntel' (navigator.platform);
  // 'win' covers 'Windows' and 'Win32'.
  if (p.includes('mac')) return 'Touch ID';
  if (p.includes('win')) return 'Windows Hello';
  return null;
};
