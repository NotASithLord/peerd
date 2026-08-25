// @ts-check
// Cold authority-kernel storage/error surface. Unlike kernel.js this entry has
// no static edge to vault crypto; the sealed vault Worker owns that graph.

export { purgeVaultBlob } from './vault/purge.js';
export { DEFAULT_AUTO_LOCK_MS } from './vault/constants.js';
export {
  VaultAlreadyInitializedError,
  VaultLockedError,
  VaultNotInitializedError,
  WrongPassphraseError,
  PrfNotEnrolledError,
  PrfUnlockFailedError,
  RecoveryPassphraseNotSetError,
} from './vault/errors.js';
export { createAuditLog } from './audit/log.js';
export { DEFAULT_AUDIT_MAX_ENTRIES } from './audit/retention.js';
export { makeWriteGuard } from '../peerd-runtime/lifecycle/write-guard.js';
export {
  applyStoreBootPosture,
  VERSION_STAMP_KEY,
} from '../peerd-runtime/lifecycle/store-registry.js';
export {
  flattenCategorisedDenylist,
  matchesDenylist,
  normalizeDenylistPattern,
} from './denylist/denylist.js';
import {
  count, del, delUpTo, get, getAll, getAllKeys, getMany, patch, put, transact,
} from './storage/idb.js';
import { realKV } from './storage/kv.js';
import {
  sessionDelete, sessionGet, sessionSet,
} from './storage/session-cache.js';

export const kv = {
  /** @param {string} key */ get: (key) => realKV().get(key),
  /** @param {string} key @param {any} value */ set: (key, value) => realKV().set(key, value),
  /** @param {string} key */ delete: (key) => realKV().delete(key),
  /** @param {string} [prefix] */ list: (prefix) => realKV().list(prefix),
};
export const idb = {
  count, del, delUpTo, get, getAll, getAllKeys, getMany, patch, put, transact,
};
export const sessionCache = { sessionGet, sessionSet, sessionDelete };
