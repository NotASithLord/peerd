// @ts-check
// Vault blob → IndexedDB migration lifecycle, against the REAL IDB
// wrapper (the decision table is Bun-tested in
// tests/peerd-egress/vault-blob-migration.test.ts; here we prove the
// IO: fresh install, migrated install, failed-write fallback, poisoned
// leftovers, and that both unlock paths + the session DK mirror are
// unaffected).
//
// Most cases use the PRF (passkey) factor — importPrfKEK is a cheap raw
// key import — so we only pay the 600k-iteration PBKDF2 once, in the
// dedicated passphrase-path test.

import { describe, it, expect } from '../../framework.js';
import { createVault, purgeVaultBlob, idb, deriveArgon2id } from '/peerd-egress/index.js';
import { makeMockKV } from '../../mocks/kv.js';

const VAULT_STORE = 'vault';
// Real WASM, small memory: fast enough for every test where the 64 MiB
// production cost isn't the thing under test.
const SMALL_PARAMS = Object.freeze({
  algo: 'argon2id', memKiB: 8 * 1024, iters: 2, parallelism: 1,
});

const VAULT_KEY = 'vault.v1';

const PRF = new Uint8Array(32).fill(7);
const prfArgs = () => ({
  prfOutput: PRF,
  credentialId: new Uint8Array([1, 2, 3]),
  prfSalt: new Uint8Array([9, 9, 9, 9]),
});

const cleanSlate = async () => {
  await idb.clear(VAULT_STORE);
  return makeMockKV();
};

// Build a LEGACY blob the way a pre-migration install would have: a
// kv-only vault (no idb dep) writes the blob to chrome.storage.local.
/** @param {ReturnType<typeof makeMockKV>} kv */
const seedLegacyBlob = async (kv) => {
  const legacy = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS, kv });
  await legacy.initializeWithPrfOnly(prfArgs());
  legacy.lock();
  return kv.get(VAULT_KEY);
};

describe('vault blob in IndexedDB', () => {
  it('fresh install: the blob lands in IDB and never touches storage.local', async () => {
    const kv = await cleanSlate();
    const v = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS, kv, idb });
    await v.initializeWithPrfOnly(prfArgs());

    const rec = await idb.get(VAULT_STORE, VAULT_KEY);
    expect(rec?.value?.wrappedDK_prf !== undefined).toBe(true);
    expect(await kv.get(VAULT_KEY)).toBe(undefined);

    // Full lock/unlock cycle against the IDB-actor blob.
    v.lock();
    expect(v.isLocked()).toBe(true);
    await v.unlockWithPrf(PRF);
    expect(v.isLocked()).toBe(false);
  });

  it('migrated install: legacy storage.local blob moves to IDB, verified, original deleted', async () => {
    const kv = await cleanSlate();
    const legacyBlob = await seedLegacyBlob(kv);
    expect(legacyBlob !== undefined).toBe(true);

    const v = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS, kv, idb });
    await v.unlockWithPrf(PRF);          // first blob access runs the migration
    expect(v.isLocked()).toBe(false);

    const rec = await idb.get(VAULT_STORE, VAULT_KEY);
    expect(rec.value.wrappedDK_prf).toBe(legacyBlob.wrappedDK_prf);
    expect(rec.value.credentialId).toBe(legacyBlob.credentialId);
    expect(await kv.get(VAULT_KEY)).toBe(undefined); // original gone — but only after verify

    // Post-migration writes land in IDB, not back in storage.local.
    await v.enrollPrf(prfArgs());
    expect(await kv.get(VAULT_KEY)).toBe(undefined);
  });

  it('failed-write fallback: IDB put failure keeps storage.local authoritative, silently', async () => {
    const kv = await cleanSlate();
    await seedLegacyBlob(kv);
    const failingIdb = {
      get: idb.get,
      del: idb.del,
      put: async () => { throw new Error('quota / broken profile'); },
    };

    const v = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS, kv, idb: failingIdb });
    await v.unlockWithPrf(PRF);          // must not surface the failure
    expect(v.isLocked()).toBe(false);

    // The legacy copy is untouched and nothing landed in the real store.
    expect((await kv.get(VAULT_KEY))?.wrappedDK_prf !== undefined).toBe(true);
    expect(await idb.get(VAULT_STORE, VAULT_KEY)).toBe(undefined);
  });

  it('read-back verification failure: bad IDB copy scrubbed, storage.local kept', async () => {
    const kv = await cleanSlate();
    await seedLegacyBlob(kv);
    // A put that silently corrupts (what verification exists to catch).
    const corruptingIdb = {
      get: idb.get,
      del: idb.del,
      /** @param {string} store @param {any} record */
      put: (store, record) =>
        idb.put(store, { ...record, value: { ...record.value, wrappedDK_prf: 'Y29ycnVwdA==' } }),
    };

    const v = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS, kv, idb: corruptingIdb });
    await v.unlockWithPrf(PRF);          // unlock still served from storage.local
    expect(v.isLocked()).toBe(false);
    expect((await kv.get(VAULT_KEY))?.wrappedDK_prf !== undefined).toBe(true);
    // The unverified record was deleted so the next boot retries clean.
    expect(await idb.get(VAULT_STORE, VAULT_KEY)).toBe(undefined);
  });

  it('interrupted migration (equal copies on both sides) is finished: kv copy deleted', async () => {
    const kv = await cleanSlate();
    const blob = await seedLegacyBlob(kv);
    await idb.put(VAULT_STORE, { key: VAULT_KEY, value: blob }); // copy landed, delete didn't

    const v = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS, kv, idb });
    expect(await v.isInitialized()).toBe(true);
    expect(await kv.get(VAULT_KEY)).toBe(undefined);
    await v.unlockWithPrf(PRF);
    expect(v.isLocked()).toBe(false);
  });

  it('poisoned IDB leftover (unequal copies): storage.local wins, leftover scrubbed', async () => {
    const kv = await cleanSlate();
    await seedLegacyBlob(kv);
    // A divergent IDB record — adopting it would brick the vault.
    await idb.put(VAULT_STORE, {
      key: VAULT_KEY,
      value: { version: 1, wrappedDK_prf: 'anVuaw==', credentialId: 'anVuaw==', prfSalt: 'anVuaw==', createdAt: 1 },
    });

    const v = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS, kv, idb });
    await v.unlockWithPrf(PRF);          // only succeeds if served from kv
    expect(v.isLocked()).toBe(false);
    expect(await idb.get(VAULT_STORE, VAULT_KEY)).toBe(undefined);
  });

  it('passphrase path: recovery passphrase unlock works across the migration', async () => {
    const kv = await cleanSlate();
    const legacy = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS, kv });
    await legacy.initialize('correct-horse-battery-staple');
    legacy.lock();

    const v = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS, kv, idb });
    await v.unlock('correct-horse-battery-staple');
    expect(v.isLocked()).toBe(false);
    expect((await idb.get(VAULT_STORE, VAULT_KEY))?.value?.wrappedDK !== undefined).toBe(true);
    expect(await kv.get(VAULT_KEY)).toBe(undefined);
  });

  it('chrome.storage.session DK mirror is unaffected: resume works with the IDB blob', async () => {
    const kv = await cleanSlate();
    /** @type {Map<string, any>} */
    const session = new Map();
    const sessionCache = {
      /** @param {string} k */
      sessionGet: async (k) => session.get(k),
      /** @param {string} k @param {any} v */
      sessionSet: async (k, v) => { session.set(k, v); },
      /** @param {string} k */
      sessionDelete: async (k) => { session.delete(k); },
    };
    const v1 = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS, kv, idb, sessionCache, autoLockMs: 0 });
    await v1.initializeWithPrfOnly(prfArgs());
    await v1.setSecret('k', 'plaintext-value');
    await new Promise((r) => setTimeout(r, 0)); // _persistDK is fire-and-forget

    const v2 = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS, kv, idb, sessionCache, autoLockMs: 0 });
    expect(await v2.attemptResume()).toBe(true);
    expect(await v2.getSecret('k')).toBe('plaintext-value');
  });

  it('purgeVaultBlob clears BOTH backends (failed-init rollback path)', async () => {
    const kv = await cleanSlate();
    await seedLegacyBlob(kv);                                  // kv copy
    await idb.put(VAULT_STORE, { key: VAULT_KEY, value: { junk: true } }); // idb copy
    await purgeVaultBlob({ kv, idb });
    expect(await kv.get(VAULT_KEY)).toBe(undefined);
    expect(await idb.get(VAULT_STORE, VAULT_KEY)).toBe(undefined);

    // A fresh vault sees an uninitialized state again.
    const v = createVault({ argon2: deriveArgon2id, argon2Params: SMALL_PARAMS, kv, idb });
    expect(await v.isInitialized()).toBe(false);
    await idb.clear(VAULT_STORE); // leave the shared store clean
  });
});
