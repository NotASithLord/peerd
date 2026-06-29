// @ts-check
// Vault passphrase KDF — vault.v2 Argon2id wraps against the REAL
// vendored WASM (extension/vendor/argon2/), plus the lazy v1 → v2
// migration with the REAL 600k-iteration PBKDF2 verify.
//
// The pure policy table is Bun-tested (tests/peerd-egress/
// vault-kdf.test.ts, with a fake derive); what only a browser can prove
// is here: that hash-wasm's embedded WASM actually instantiates under
// the extension CSP (`wasm-unsafe-eval`), derives at the production
// parameters, and that the full enroll → lock → unlock → lazy-migrate →
// unlock-again loop round-trips with real crypto end to end.
//
// Cost honesty: the production-params test pays real 64 MiB Argon2id
// derives and the migration tests pay real 600k-PBKDF2 verifies —
// hundreds of ms each, same posture as vault.test.js ("the test cost is
// real and worth paying so we exercise the production parameters").
// Tests that don't need production cost use a small-but-real 8 MiB
// descriptor to keep the suite quick.

import { describe, it, expect } from '../../framework.js';
import {
  createVault, deriveArgon2id, ARGON2_DEFAULT_PARAMS, idb,
} from '/peerd-egress/index.js';
import { makeMockKV } from '../../mocks/kv.js';

const VAULT_KEY = 'vault.v1';
const VAULT_STORE = 'vault';
const PASS = 'correct-horse-battery-staple';

// Real WASM, small memory: fast enough to use everywhere the 64 MiB
// production cost isn't the thing under test.
const SMALL_PARAMS = Object.freeze({
  algo: 'argon2id', memKiB: 8 * 1024, iters: 2, parallelism: 1,
});

/**
 * @param {ReturnType<typeof makeMockKV>} kv
 * @param {Partial<Parameters<typeof createVault>[0]>} [extra]
 */
const newVault = (kv, extra = {}) =>
  createVault({ kv, argon2: deriveArgon2id, argon2Params: SMALL_PARAMS, autoLockMs: 0, ...extra });

// Seed a passphrase vault with a stored secret (kv-actor blob).
/** @param {ReturnType<typeof makeMockKV>} kv */
const seedVault = async (kv) => {
  const v = newVault(kv);
  await v.initialize(PASS);
  await v.setSecret('api_key', 'sk-survives');
  v.lock();
  return kv.get(VAULT_KEY);
};
// argon2 dep writes a v1 PBKDF2 wrap.
/** @param {ReturnType<typeof makeMockKV>} kv */
const seedLegacyVault = async (kv) => {
  const legacy = createVault({ kv, autoLockMs: 0 });
  await legacy.initialize(PASS);
  await legacy.setSecret('api_key', 'sk-survives-migration');
  legacy.lock();
  return kv.get(VAULT_KEY);
};

describe('vault.kdf (argon2id, real WASM)', () => {
  it('production params: enroll → lock → unlock → unlock again, v2 blob throughout', async () => {
    const kv = makeMockKV();
    const v = createVault({ kv, argon2: deriveArgon2id, autoLockMs: 0 });
    await v.initialize(PASS);

    // The blob is v2 with the full production descriptor recorded as data.
    const blob = await kv.get(VAULT_KEY);
    expect(blob.version).toBe(2);
    expect(blob.salt).toBe(undefined);
    expect(blob.kdf.algo).toBe('argon2id');
    expect(blob.kdf.memKiB).toBe(ARGON2_DEFAULT_PARAMS.memKiB);
    expect(blob.kdf.iters).toBe(ARGON2_DEFAULT_PARAMS.iters);
    expect(blob.kdf.parallelism).toBe(1);
    expect(typeof blob.kdf.salt).toBe('string');

    await v.setSecret('api_key', 'sk-argon2-roundtrip');
    v.lock();

    // Unlock on a fresh instance (SW-restart shape), then once more —
    // repeat derives against the same descriptor must keep working.
    const v2 = newVault(kv);
    await v2.unlock(PASS);
    expect(await v2.getSecret('api_key')).toBe('sk-argon2-roundtrip');
    v2.lock();
    const v3 = newVault(kv);
    await v3.unlock(PASS);
    expect(await v3.getSecret('api_key')).toBe('sk-argon2-roundtrip');
    // No rewrap churn: the descriptor (incl. salt) is stable across unlocks.
    expect((await kv.get(VAULT_KEY)).kdf.salt).toBe(blob.kdf.salt);
  });

  it('rejects a wrong passphrase on an argon2 blob and leaves it unchanged', async () => {
    const kv = makeMockKV();
    const v = newVault(kv);
    await v.initialize(PASS);
    v.lock();
    const before = await kv.get(VAULT_KEY);

    const v2 = newVault(kv);
    await expect(() => v2.unlock('not-the-passphrase'))
      .toThrow((e) => e.name === 'WrongPassphraseError');
    expect(v2.isLocked()).toBe(true);
    expect(await kv.get(VAULT_KEY)).toEqual(before);
  });

  it('a v1-shaped blob (bare salt, no descriptor) is refused, not misread', async () => {
    // The pre-release PBKDF2 path is deleted (0.x, no installs, no
    // compat) — a blob carrying the old shape must surface
    // KdfUnavailableError, never WrongPassphraseError.
    const kv = makeMockKV();
    await kv.set(VAULT_KEY, { version: 1, wrappedDK: 'AAAA', salt: 'AAAA' });
    const v = newVault(kv);
    /** @type {{ name?: string } | null} */
    let err = null;
    try { await v.unlock(PASS); } catch (e) { err = /** @type {{ name?: string }} */ (e); }
    expect(err?.name).toBe('KdfUnavailableError');
  });

  it('PRF wrap and passphrase wrap stay independent: re-setting the passphrase preserves PRF bytes', async () => {
    const kv = makeMockKV();
    const PRF_OUTPUT = new Uint8Array(32).fill(0xab);
    const v = newVault(kv);
    await v.initialize(PASS);
    await v.setSecret('api_key', 'sk-prf-unaffected');
    await v.enrollPrf({
      prfOutput: PRF_OUTPUT,
      credentialId: new Uint8Array([1, 2, 3, 4]),
      prfSalt: new Uint8Array(32).fill(0x42),
    });
    const before = await kv.get(VAULT_KEY);

    // Re-wrap the passphrase factor (fresh salt + KEK); PRF fields must
    // survive byte-for-byte and still recover the SAME DK.
    await v.setRecoveryPassphrase('a-new-passphrase');
    const after = await kv.get(VAULT_KEY);
    expect(after.wrappedDK === before.wrappedDK).toBe(false);
    expect(after.wrappedDK_prf).toBe(before.wrappedDK_prf);
    expect(after.credentialId).toBe(before.credentialId);
    expect(after.prfSalt).toBe(before.prfSalt);
    v.lock();

    const viaPrf = newVault(kv);
    await viaPrf.unlockWithPrf(PRF_OUTPUT);
    expect(await viaPrf.getSecret('api_key')).toBe('sk-prf-unaffected');
  });

  it('blob-home migration carries a passphrase vault kv → IDB intact', async () => {
    await idb.clear(VAULT_STORE);
    const kv = makeMockKV();
    await seedVault(kv);

    // idb wired: first blob access migrates the kv-actor blob into
    // IDB (verified copy) and the passphrase still unlocks against it.
    const v = newVault(kv, { idb });
    await v.unlock(PASS);
    const rec = await idb.get(VAULT_STORE, VAULT_KEY);
    expect(rec?.value?.kdf?.algo).toBe('argon2id');
    expect(await kv.get(VAULT_KEY)).toBe(undefined);
    expect(await v.getSecret('api_key')).toBe('sk-survives');
    await idb.clear(VAULT_STORE);
  });
});
