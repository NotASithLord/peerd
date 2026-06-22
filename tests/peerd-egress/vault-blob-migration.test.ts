// Vault blob migration decision table — pure half of the
// chrome.storage.local → IndexedDB move. The IO lifecycle (fresh
// install, migrated install, failed-write fallback) is covered in-browser
// at extension/tests/unit/peerd-egress/vault-blob-idb.test.js.

import { describe, test, expect } from 'bun:test';
import {
  blobsEqual,
  planVaultBlobMigration,
} from '../../extension/peerd-egress/vault/blob-migration.js';

const BLOB = {
  version: 1,
  wrappedDK: 'd3JhcHBlZA==',
  salt: 'c2FsdA==',
  createdAt: 1718000000000,
};

describe('blobsEqual', () => {
  test('equal structured blobs', () => {
    expect(blobsEqual(BLOB, { ...BLOB })).toBe(true);
    expect(blobsEqual(BLOB, structuredClone(BLOB))).toBe(true);
  });

  test('any field divergence breaks equality', () => {
    expect(blobsEqual(BLOB, { ...BLOB, wrappedDK: 'XXXX' })).toBe(false);
    expect(blobsEqual(BLOB, { ...BLOB, createdAt: 1 })).toBe(false);
    expect(blobsEqual(BLOB, { ...BLOB, extra: true })).toBe(false);
    const { salt: _salt, ...missing } = BLOB;
    expect(blobsEqual(BLOB, missing)).toBe(false);
  });

  test('primitives and nulls', () => {
    expect(blobsEqual(undefined, undefined)).toBe(true);
    expect(blobsEqual(null, BLOB)).toBe(false);
    expect(blobsEqual(BLOB, null)).toBe(false);
    expect(blobsEqual(1, '1')).toBe(false);
    expect(blobsEqual([1], { 0: 1 })).toBe(false);
  });
});

describe('planVaultBlobMigration', () => {
  test('fresh install (neither copy): idb is the home, nothing to do', () => {
    expect(planVaultBlobMigration({ idbValue: undefined, kvValue: undefined }))
      .toEqual({ backend: 'idb', action: 'none' });
  });

  test('already migrated (idb only): no action', () => {
    expect(planVaultBlobMigration({ idbValue: BLOB, kvValue: undefined }))
      .toEqual({ backend: 'idb', action: 'none' });
  });

  test('legacy install (kv only): copy over', () => {
    expect(planVaultBlobMigration({ idbValue: undefined, kvValue: BLOB }))
      .toEqual({ backend: 'idb', action: 'copy' });
  });

  test('interrupted migration (both, equal): finish by deleting the kv copy', () => {
    expect(planVaultBlobMigration({ idbValue: structuredClone(BLOB), kvValue: BLOB }))
      .toEqual({ backend: 'idb', action: 'delete-kv' });
  });

  test('poisoned idb copy (both, unequal): kv stays the truth', () => {
    // Adopting a non-verified IDB record and deleting the kv original
    // could lose the vault permanently — the plan must never do it.
    expect(planVaultBlobMigration({ idbValue: { ...BLOB, wrappedDK: 'garbage' }, kvValue: BLOB }))
      .toEqual({ backend: 'kv', action: 'delete-idb' });
  });
});
