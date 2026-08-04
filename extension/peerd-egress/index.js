// @ts-check
// peerd-egress — public surface.
//
// Every import from outside this module goes through this file. Deep
// imports (e.g. `/peerd-egress/vault/vault.js`) from outside the module
// are forbidden by the .eslintrc.cjs no-restricted-imports rule.
//
// Within the module, files reach for siblings via relative paths;
// `index.js` exists purely as the abstraction barrier.
//
// Grouped here by sub-area (vault, fetch, denylist, confirm,
// audit, storage). When the surface grows past ~30 names, time to ask
// whether the module is doing too much — see architecture.md §7.

// --- vault ---------------------------------------------------------------
export { createVault, purgeVaultBlob, DEFAULT_AUTO_LOCK_MS } from './vault/vault.js';
// deriveArgon2id is the production Argon2 dep the SW injects into
// createVault (thin wrapper over the vendored hash-wasm bundle);
// ARGON2_DEFAULT_PARAMS is the descriptor data new wraps record
// (exposed for UI/diagnostics, not for tweaking at call sites).
export { deriveArgon2id } from './vault/argon2.js';
export { ARGON2_DEFAULT_PARAMS } from './vault/kdf.js';
export {
  VaultLockedError,
  VaultNotInitializedError,
  VaultAlreadyInitializedError,
  WrongPassphraseError,
  PrfNotEnrolledError,
  PrfUnlockFailedError,
  RecoveryPassphraseNotSetError,
  KdfUnavailableError,
} from './vault/errors.js';
export {
  isWebAuthnAvailable,
  probeWebAuthnCapabilities,
  enrollWithPrf,
  getPrfOutput,
  PrfNotSupportedError,
  PrfCancelledError,
  PrfUnsupportedByAuthenticatorError,
} from './vault/webauthn.js';
// Pure enrollment planning (probe results in → choices out) + the
// platform-authenticator LABEL helper (cosmetic only — never behavior).
export {
  planEnrollment,
  platformAuthenticatorLabel,
} from './vault/enroll-options.js';

// --- fetch / egress allowlist -------------------------------------------
export {
  makeSafeFetch,
  HARDCODED_ALLOWLIST,
  originOf,
  isAllowed,
} from './fetch/safe-fetch.js';
export {
  makeWebFetch, sessionScopedCredentials, withSessionScopedCredentials,
  withApiCredentials, withDpopCredentials,
} from './fetch/web-fetch.js';
// DESIGN-18 P1: origin-bound API-key policy (the origin:<origin> analog of git:<host>).
export {
  ORIGIN_SECRET_PREFIX, originSecretName, originFromSecretName,
  normalizeKeyedOrigin, authOriginForRequestUrl, isPlausibleApiKey,
  buildOriginSecret, parseOriginAuth,
} from './fetch/origin-credentials.js';
export { makeOriginCredentialRoutes } from './fetch/origin-credential-routes.js';
export { EgressDeniedError } from './fetch/errors.js';

// --- DPoP (RFC 9449) proof-of-possession credentials ---------------------
// The "use but can't see" credential: a private key generated extractable:false
// (so no in-origin code can ever export it) + a fresh per-request signed proof
// minted at the egress boundary. THREAT-MODEL.md INV-15.
export {
  base64url, base64urlFromString, utf8Bytes, canonicalHtu, htmOf,
  publicJwkOnly, jwkThumbprintInput, buildProofInput, assembleProof,
} from './dpop/proof.js';
export {
  DPOP_KEY_STORE, generateDpopKeypair, makeDpopKeyStore, getOrCreateDpopKey,
  usableDpopPrivateKey, loadDpopJkt, ensureDpopJkt,
  dpopJkt, accessTokenHashFor, signDpopProof,
} from './dpop/keys.js';

// --- denylist -----------------------------------------------------------
export {
  matchesDenylist,
  findDenylistMatch,
  flattenCategorisedDenylist,
  normalizeDenylistPattern,
} from './denylist/denylist.js';
// The denylist's NETWORK-level backstop: the pure denylist →
// declarativeNetRequest rule mapping. The imperative half (keeping the rule in
// sync with the driven-tab set) is background/denylist-net-guard.js.
export {
  denylistBlockDomains,
  buildDenylistBlockRule,
  denylistSessionRuleUpdate,
  DENYLIST_RULE_ID,
  DENYLIST_RESOURCE_TYPES,
} from './denylist/dnr-rules.js';

// --- confirm protocol ---------------------------------------------------
export { makeConfirmCoordinator } from './confirm/protocol.js';

// --- audit --------------------------------------------------------------
export { createAuditLog } from './audit/log.js';
export { DEFAULT_AUDIT_MAX_ENTRIES } from './audit/retention.js';

// --- storage primitives -------------------------------------------------
// Exposed as namespaces (`egress.kv.get(...)`) rather than individual
// functions to match the architecture-doc public-API shape (§6 example
// passes `kv: egress.kv` directly into createVault). Other modules are
// expected to use the higher-level vault/audit/safeFetch surfaces above;
// direct storage access is for chassis wiring only.
//
// kv is exposed as the production KV INSTANCE (an object with get/set/...
// methods), not as the module namespace — the vault and other consumers
// call kv.get(...) directly. Calling `realKV()` at module load is safe
// because makeRealKV only returns a closure of functions; it doesn't
// touch chrome.storage until those functions are actually called.
import { realKV } from './storage/kv.js';
import * as _idb from './storage/idb.js';
import * as _session from './storage/session-cache.js';
export const kv = realKV();
export const idb = _idb;
// The single-blob IDB key-value adapter the engine registries inject
// (the registry-factory storage seam): `idbKV('apps')` etc.
export const idbKV = _idb.idbKV;
export const sessionCache = _session;
