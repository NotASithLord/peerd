// Vault passphrase-KDF (Argon2id, vault.v2) — the pure policy table in
// kdf.js plus the vault-level wrap/unlock/lazy-migration flow driven
// with a DETERMINISTIC fake Argon2 (values in, values out; the REAL
// vendored WASM path is covered by the in-browser suite at
// extension/tests/unit/peerd-egress/vault-kdf.test.js).
//
// Bun's WebCrypto carries the full AES-KW / PBKDF2 surface the vault
// uses, so these tests exercise the production wrap/unwrap code — only
// the Argon2 derive itself is faked (it's an injected dep by design).

import { describe, test, expect } from 'bun:test';
import {
  ARGON2_DEFAULT_PARAMS,
  ARGON2_MAX_MEM_KIB,
  isArgon2Params,
  isArgon2Descriptor,
  hasPassphraseWrap,
  planPassphraseUnlock,
  withPassphraseWrap,
} from '../../extension/peerd-egress/vault/kdf.js';
import { createVault } from '../../extension/peerd-egress/vault/vault.js';

// ---------------------------------------------------------------------------
// Pure policy (kdf.js)
// ---------------------------------------------------------------------------

describe('ARGON2_DEFAULT_PARAMS', () => {
  test('is 64 MiB-class, single-lane, multi-pass — and frozen', () => {
    expect(ARGON2_DEFAULT_PARAMS.algo).toBe('argon2id');
    expect(ARGON2_DEFAULT_PARAMS.memKiB).toBe(64 * 1024);
    expect(ARGON2_DEFAULT_PARAMS.parallelism).toBe(1); // no SAB in the SW
    expect(ARGON2_DEFAULT_PARAMS.iters).toBeGreaterThanOrEqual(2);
    expect(Object.isFrozen(ARGON2_DEFAULT_PARAMS)).toBe(true);
    expect(isArgon2Params(ARGON2_DEFAULT_PARAMS)).toBe(true);
  });
});

describe('isArgon2Descriptor', () => {
  const valid = { ...ARGON2_DEFAULT_PARAMS, salt: 'c2FsdHNhbHRzYWx0c2E=' };

  test('accepts a complete in-bounds descriptor', () => {
    expect(isArgon2Descriptor(valid)).toBe(true);
  });

  test('rejects unknown algos, bad lanes, out-of-bounds costs, missing salt', () => {
    const bad = [
      undefined,
      null,
      {},
      { ...valid, algo: 'argon2i' },                    // wrong variant
      { ...valid, algo: 'pbkdf2' },
      { ...valid, parallelism: 2 },                     // we never write >1 lane
      { ...valid, parallelism: 0 },
      { ...valid, memKiB: 4 },                          // below Argon2 spec floor
      { ...valid, memKiB: ARGON2_MAX_MEM_KIB + 1 },     // OOM-the-SW ceiling
      { ...valid, memKiB: 1024.5 },                     // non-integer
      { ...valid, iters: 0 },
      { ...valid, iters: 4096 },                        // hang-the-SW ceiling
      { ...valid, salt: '' },
      { ...valid, salt: undefined },
      { ...valid, salt: new Uint8Array(16) },           // descriptors store base64
    ];
    for (const d of bad) expect(isArgon2Descriptor(d)).toBe(false);
  });
});

describe('planPassphraseUnlock', () => {
  const argonKdf = { ...ARGON2_DEFAULT_PARAMS, salt: 'c2FsdA==' };

  test('no passphrase wrap (passkey-only or empty blob) → none', () => {
    expect(planPassphraseUnlock({ blob: undefined, argon2Available: true }).path).toBe('none');
    expect(planPassphraseUnlock({
      blob: { wrappedDK_prf: 'x', credentialId: 'y', prfSalt: 'z' },
      argon2Available: true,
    }).path).toBe('none');
  });

  test('absent descriptor (the deleted pre-release v1 shape) → unsupported', () => {
    // No PBKDF2 path exists anymore: a blob with a bare legacy `salt`
    // has a wrap we can no longer verify — surface unsupported (a lie
    // about "wrong passphrase" would be worse).
    const blob = { wrappedDK: 'AAAA', salt: 'AAAA' };
    expect(planPassphraseUnlock({ blob, argon2Available: true }).path).toBe('unsupported');
    expect(planPassphraseUnlock({ blob, argon2Available: false }).path).toBe('unsupported');
  });

  test('v2 blob with a valid descriptor → argon2id (descriptor passed through)', () => {
    const plan = planPassphraseUnlock({
      blob: { version: 2, wrappedDK: 'x', kdf: argonKdf },
      argon2Available: true,
    });
    expect(plan.path).toBe('argon2id');
    expect(plan.kdf).toEqual(argonKdf);
  });

  test('v2 blob without an argon2 impl wired → unavailable', () => {
    expect(planPassphraseUnlock({
      blob: { version: 2, wrappedDK: 'x', kdf: argonKdf },
      argon2Available: false,
    }).path).toBe('unavailable');
  });

  test('unknown or out-of-bounds descriptor → unsupported (tamper/downgrade rail)', () => {
    for (const kdf of [
      { ...argonKdf, algo: 'argon3' },
      { ...argonKdf, memKiB: 1 << 30 },
      { ...argonKdf, parallelism: 4 },
    ]) {
      expect(planPassphraseUnlock({
        blob: { version: 2, wrappedDK: 'x', kdf },
        argon2Available: true,
      }).path).toBe('unsupported');
    }
  });
});

describe('withPassphraseWrap', () => {
  const argonKdf = { ...ARGON2_DEFAULT_PARAMS, salt: 'bmV3LXNhbHQ=' };
  const prfFields = {
    wrappedDK_prf: 'prf-wrap', credentialId: 'cred', prfSalt: 'prf-salt',
  };

  test('v2 wrap: sets kdf + version 2, removes the legacy salt, keeps PRF fields', () => {
    const blob = { version: 1, wrappedDK: 'old', salt: 'old-salt', createdAt: 7, ...prfFields };
    const next = withPassphraseWrap(blob, { wrappedDK: 'new', kdf: argonKdf });
    expect(next.version).toBe(2);
    expect(next.wrappedDK).toBe('new');
    expect(next.kdf).toEqual(argonKdf);
    expect('salt' in next).toBe(false);
    expect(next.createdAt).toBe(7);
    expect(next.wrappedDK_prf).toBe('prf-wrap');
    expect(next.credentialId).toBe('cred');
    expect(next.prfSalt).toBe('prf-salt');
    // input not mutated
    expect(blob.wrappedDK).toBe('old');
    expect(blob.salt).toBe('old-salt');
  });

  test('scrubs a stray legacy salt field', () => {
    const out = withPassphraseWrap({ salt: 'stale', wrappedDK: 'old' },
      { wrappedDK: 'new', kdf: argonKdf });
    expect(out.salt).toBeUndefined();
    expect(out.version).toBe(2);
  });
});

describe('hasPassphraseWrap', () => {
  test('recognizes both wrap generations and rejects PRF-only blobs', () => {
    expect(hasPassphraseWrap({ wrappedDK: 'x', salt: 'y' })).toBe(true);
    expect(hasPassphraseWrap({ wrappedDK: 'x', kdf: { algo: 'argon2id' } })).toBe(true);
    expect(hasPassphraseWrap({ wrappedDK_prf: 'x' })).toBe(false);
    expect(hasPassphraseWrap({ wrappedDK: 'x' })).toBe(false);
    expect(hasPassphraseWrap(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Vault-level flow with a deterministic fake Argon2
// ---------------------------------------------------------------------------

const VAULT_KEY = 'vault.v1';

const makeKV = () => {
  const store = new Map<string, any>();
  return {
    store,
    get: async (k: string) => store.get(k),
    set: async (k: string, v: any) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
    list: async (prefix = '') => {
      const out: Record<string, any> = {};
      for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
      return out;
    },
    clear: async () => { store.clear(); },
  };
};

// Deterministic stand-in for the WASM derive: SHA-256 over passphrase,
// params, and salt. Keyed on the same inputs as the real thing, so a
// wrong passphrase or a different salt yields a different KEK, and the
// call count tells us WHICH unlock path ran.
const makeFakeArgon2 = () => {
  let calls = 0;
  const fn = async ({ passphrase, salt, memKiB, iters, parallelism }: any) => {
    calls += 1;
    const head = new TextEncoder().encode(`${passphrase}|${memKiB}|${iters}|${parallelism}|`);
    const buf = new Uint8Array(head.length + salt.length);
    buf.set(head);
    buf.set(salt, head.length);
    return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  };
  fn.calls = () => calls;
  return fn;
};

const PASS = 'correct-horse-battery-staple';

describe('vault.v2 wrap (fake argon2)', () => {
  test('initialize with argon2 wired writes a v2 blob with a per-wrap descriptor', async () => {
    const kv = makeKV();
    const argon2 = makeFakeArgon2();
    const v = createVault({ kv, argon2, autoLockMs: 0 });
    await v.initialize(PASS);

    const blob = kv.store.get(VAULT_KEY);
    expect(blob.version).toBe(2);
    expect(blob.salt).toBeUndefined();
    expect(blob.kdf.algo).toBe('argon2id');
    expect(blob.kdf.memKiB).toBe(ARGON2_DEFAULT_PARAMS.memKiB);
    expect(blob.kdf.parallelism).toBe(1);
    expect(typeof blob.kdf.salt).toBe('string');
    expect(blob.kdf.salt.length).toBeGreaterThan(0);

    // Round-trip: lock → unlock → secrets readable; wrong passphrase rejected.
    await v.setSecret('k', 'sk-test-value');
    v.lock();
    const v2 = createVault({ kv, argon2, autoLockMs: 0 });
    await expect(v2.unlock('wrong-passphrase')).rejects.toMatchObject({ name: 'WrongPassphraseError' });
    expect(v2.isLocked()).toBe(true);
    await v2.unlock(PASS);
    expect(await v2.getSecret('k')).toBe('sk-test-value');
  });

  test('custom argon2Params are recorded as data in the descriptor', async () => {
    const kv = makeKV();
    const params = { algo: 'argon2id', memKiB: 8192, iters: 2, parallelism: 1 };
    const v = createVault({ kv, argon2: makeFakeArgon2(), argon2Params: params, autoLockMs: 0 });
    await v.initialize(PASS);
    expect(kv.store.get(VAULT_KEY).kdf.memKiB).toBe(8192);
    expect(kv.store.get(VAULT_KEY).kdf.iters).toBe(2);
  });

  test('invalid argon2Params fail at construction, not at first unlock', () => {
    expect(() => createVault({
      kv: makeKV(),
      argon2: makeFakeArgon2(),
      argon2Params: { algo: 'argon2id', memKiB: 4, iters: 3, parallelism: 1 },
    })).toThrow(TypeError);
  });

  test('no argon2 wired → passphrase initialize refuses (PRF-only vault contract)', async () => {
    // Argon2id is the ONLY passphrase KDF — there is no PBKDF2 fallback
    // and no migration path (pre-release deletion, 2026-06-12). A vault
    // built without the dep cannot create a passphrase factor at all.
    const kv = makeKV();
    const v = createVault({ kv, autoLockMs: 0 });
    await expect(v.initialize(PASS)).rejects.toMatchObject({ name: 'KdfUnavailableError' });
    expect(kv.store.get(VAULT_KEY)).toBeUndefined();   // nothing half-written
  });

  test('a FAILED unlock never rewrites the blob', async () => {
    const kv = makeKV();
    const argon2 = makeFakeArgon2();
    const seed = createVault({ kv, argon2, autoLockMs: 0 });
    await seed.initialize(PASS);
    seed.lock();
    const before = kv.store.get(VAULT_KEY);

    const v = createVault({ kv, argon2, autoLockMs: 0 });
    await expect(v.unlock('wrong-passphrase')).rejects.toMatchObject({ name: 'WrongPassphraseError' });
    expect(kv.store.get(VAULT_KEY)).toEqual(before);
  });

  test('v2 blob with no argon2 wired → KdfUnavailableError (not WrongPassphrase)', async () => {
    const kv = makeKV();
    const v = createVault({ kv, argon2: makeFakeArgon2(), autoLockMs: 0 });
    await v.initialize(PASS);
    v.lock();

    const noArgon = createVault({ kv, autoLockMs: 0 });
    await expect(noArgon.unlock(PASS)).rejects.toMatchObject({ name: 'KdfUnavailableError' });
    expect(noArgon.isLocked()).toBe(true);
  });

  test('tampered descriptor (absurd memKiB) → KdfUnavailableError before any derive', async () => {
    const kv = makeKV();
    const argon2 = makeFakeArgon2();
    const v = createVault({ kv, argon2, autoLockMs: 0 });
    await v.initialize(PASS);
    v.lock();
    const blob = kv.store.get(VAULT_KEY);
    kv.store.set(VAULT_KEY, { ...blob, kdf: { ...blob.kdf, memKiB: 1 << 30 } });

    const callsBefore = argon2.calls();
    const v2 = createVault({ kv, argon2, autoLockMs: 0 });
    await expect(v2.unlock(PASS)).rejects.toMatchObject({ name: 'KdfUnavailableError' });
    expect(argon2.calls()).toBe(callsBefore);   // the rail fires BEFORE the wasm would run
  });

  test('setRecoveryPassphrase on a PRF-only vault creates an argon2 wrap; PRF fields survive migration', async () => {
    const kv = makeKV();
    const prfArgs = {
      prfOutput: new Uint8Array(32).fill(0xab),
      credentialId: new Uint8Array([1, 2, 3]),
      prfSalt: new Uint8Array(32).fill(0x42),
    };

    // PRF-only init, then add a recovery passphrase with argon2 wired.
    const v = createVault({ kv, argon2: makeFakeArgon2(), autoLockMs: 0 });
    await v.initializeWithPrfOnly(prfArgs);
    await v.setSecret('k', 'both-paths-same-dk');
    expect(await v.hasRecoveryPassphrase()).toBe(false);
    await v.setRecoveryPassphrase(PASS);
    expect(await v.hasRecoveryPassphrase()).toBe(true);
    const blob = kv.store.get(VAULT_KEY);
    expect(blob.kdf.algo).toBe('argon2id');
    expect(blob.wrappedDK_prf).toBeDefined();
    v.lock();

    // Both unlock paths recover the SAME DK.
    const viaPass = createVault({ kv, argon2: makeFakeArgon2(), autoLockMs: 0 });
    await viaPass.unlock(PASS);
    expect(await viaPass.getSecret('k')).toBe('both-paths-same-dk');
    viaPass.lock();
    const viaPrf = createVault({ kv, argon2: makeFakeArgon2(), autoLockMs: 0 });
    await viaPrf.unlockWithPrf(prfArgs.prfOutput);
    expect(await viaPrf.getSecret('k')).toBe('both-paths-same-dk');
  });

  test('disablePrf accepts a v2 passphrase wrap as the remaining factor', async () => {
    const kv = makeKV();
    const v = createVault({ kv, argon2: makeFakeArgon2(), autoLockMs: 0 });
    await v.initialize(PASS);
    await v.enrollPrf({
      prfOutput: new Uint8Array(32).fill(1),
      credentialId: new Uint8Array([9]),
      prfSalt: new Uint8Array(32).fill(2),
    });
    // Pre-fix this threw RecoveryPassphraseNotSetError on migrated blobs
    // (the guard only knew the legacy `salt` field).
    await v.disablePrf();
    expect((await v.prfStatus()).enrolled).toBe(false);
    expect(await v.hasRecoveryPassphrase()).toBe(true);
  });
});
