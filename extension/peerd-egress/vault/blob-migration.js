// @ts-check
// Vault blob chrome.storage.local → IndexedDB migration — the pure half.
//
// Storage HYGIENE, not a security change: the blob (wrapped DK + wrap
// metadata) is ciphertext either way, and both backends are unencrypted
// extension-scoped disk. The blob simply joins everything else in IDB
// instead of being the lone chrome.storage.local actor.
//
// The migration must be loss-proof: the wrapped DK is the only path to
// every stored secret, so the chrome.storage.local copy is deleted ONLY
// after the IDB copy has been written, READ BACK, and verified equal.
// This module is the decision table (values in, plan out); vault.js
// performs the IO and falls back to 'kv' if any step of a 'copy' fails
// — silently, retried on the next vault construction (next SW boot).

/**
 * Deep structural equality for blob-shaped data: plain objects, arrays,
 * primitives. The blob is base64 strings + numbers — every live write
 * goes through bytesToBase64, so there are no raw Uint8Array fields to
 * compare.
 *
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
export const blobsEqual = (a, b) => {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => blobsEqual(a[k], b[k]));
  }
  return false;
};

/**
 * @typedef {Object} MigrationPlan
 * @property {'idb' | 'kv'} backend   where blob reads/writes should go
 * @property {'none' | 'copy' | 'delete-kv' | 'delete-idb'} action
 */

/**
 * Decide where the vault blob lives and what (if anything) to do about
 * it, given what each backend currently holds (`undefined` = absent).
 *
 * The invariant that makes this loss-proof: the IDB copy is treated as
 * authoritative ONLY when no chrome.storage.local copy exists, or when
 * the two are byte-equal. Both-present-and-UNEQUAL can only mean a
 * failed/interrupted 'copy' left a poisoned IDB record behind (post-
 * verify writes go exclusively to IDB, so a healthy install never
 * diverges) — adopting that record and deleting the kv original would
 * lose the vault permanently. So kv wins and the IDB leftover is
 * scrubbed; the migration retries clean on a later boot.
 *
 * @param {{ idbValue: any, kvValue: any }} state
 * @returns {MigrationPlan}
 */
export const planVaultBlobMigration = ({ idbValue, kvValue }) => {
  const inIdb = idbValue !== undefined;
  const inKv  = kvValue  !== undefined;
  // Fresh install (neither) reports 'idb' too: a brand-new vault's first
  // write should land in the new home, never re-seed chrome.storage.local.
  if (!inKv)  return { backend: 'idb', action: 'none' };
  if (!inIdb) return { backend: 'idb', action: 'copy' };
  return blobsEqual(idbValue, kvValue)
    // why delete-kv: a verified copy landed but the storage.local delete
    // didn't (crash/quota blip between the two) — finish the migration.
    ? { backend: 'idb', action: 'delete-kv' }
    : { backend: 'kv',  action: 'delete-idb' };
};
