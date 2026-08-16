// @ts-check
// Background-only egress surface. WebAuthn enrollment UI and public proof
// construction helpers remain available from index.js without joining the
// service worker's listener-registration path.

export { createVault, purgeVaultBlob, DEFAULT_AUTO_LOCK_MS } from './vault/vault.js';
export { deriveArgon2id } from './vault/argon2.js';
export {
  VaultLockedError, VaultNotInitializedError, VaultAlreadyInitializedError,
  WrongPassphraseError, PrfNotEnrolledError, PrfUnlockFailedError,
  RecoveryPassphraseNotSetError,
} from './vault/errors.js';
export { makeSafeFetch, HARDCODED_ALLOWLIST, originOf } from './fetch/safe-fetch.js';
export {
  makeWebFetch, withSessionScopedCredentials, withDpopCredentials,
} from './fetch/web-fetch.js';
export { originFromSecretName } from './fetch/origin-credentials.js';
export { makeOriginCredentialRoutes } from './fetch/origin-credential-routes.js';
export { EgressDeniedError } from './fetch/errors.js';
export {
  makeDpopKeyStore, getOrCreateDpopKey, loadDpopJkt, ensureDpopJkt,
} from './dpop/keys.js';
export {
  matchesDenylist, flattenCategorisedDenylist, normalizeDenylistPattern,
} from './denylist/denylist.js';
export {
  denylistSessionRuleUpdate, PRIVATE_NETWORK_RULE_IDS,
  DENYLIST_RESOURCE_TYPES, CHROME_DNR_RESOURCE_TYPES,
} from './denylist/dnr-rules.js';
export { makeConfirmCoordinator } from './confirm/protocol.js';
export { createAuditLog } from './audit/log.js';

import { realKV } from './storage/kv.js';
import * as _idb from './storage/idb.js';
import * as _session from './storage/session-cache.js';
export const kv = realKV();
export const idb = _idb;
export const idbKV = _idb.idbKV;
export const sessionCache = _session;
