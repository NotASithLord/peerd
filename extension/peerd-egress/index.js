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
// whether the module is doing too much.

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
export { makeWebFetch } from './fetch/web-fetch.js';
export { EgressDeniedError } from './fetch/errors.js';

// --- denylist -----------------------------------------------------------
export {
  matchesDenylist,
  findDenylistMatch,
  flattenCategorisedDenylist,
  normalizeDenylistPattern,
} from './denylist/denylist.js';

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
