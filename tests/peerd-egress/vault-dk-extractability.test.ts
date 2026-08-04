// Residual R11 — the vault's RESIDENT data key must not be exportable.
//
// The claim under test: the DK handle the vault holds while unlocked, and
// hands to the encrypt/decrypt primitives, is non-extractable, so a bug
// that leaks that reference cannot turn it into bytes. Extractable handles
// still exist — but only transiently, inside the vault, on the paths that
// must feed the DK to `wrapKey` (initialize, enrollment) or `exportKey`
// (the chrome.storage.session mirror).
//
// Bun ships real WebCrypto (AES-KW and AES-GCM both), so these exercise the
// production key plumbing end to end; only the Argon2id derive is faked
// (it's an injected dep by design — same posture as vault-kdf.test.ts).

import { describe, test, expect } from 'bun:test';
import {
  generateDK,
  generateRewrapKEK,
  wrapDK,
  unwrapDK,
  unwrapWrappableDK,
  importWrappableDK,
  exportRawDK,
  importRawKEK,
  encryptString,
  decryptString,
} from '../../extension/peerd-egress/vault/keys.js';
import { createVault } from '../../extension/peerd-egress/vault/vault.js';

const kekBytes = (fill: number) => new Uint8Array(32).fill(fill);
const VAULT_KEY = 'vault.v1';
const SESSION_DK_KEY = 'vault.unlocked.v1';
const PASS = 'correct-horse-battery-staple';

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

const makeSession = () => {
  const store = new Map<string, any>();
  return {
    store,
    sessionGet: async (k: string) => store.get(k),
    sessionSet: async (k: string, v: any) => { store.set(k, v); },
    sessionDelete: async (k: string) => { store.delete(k); },
  };
};

// Deterministic stand-in for the vendored WASM derive (see vault-kdf.test.ts).
const fakeArgon2 = async ({ passphrase, salt, memKiB, iters, parallelism }: any) => {
  const head = new TextEncoder().encode(`${passphrase}|${memKiB}|${iters}|${parallelism}|`);
  const buf = new Uint8Array(head.length + salt.length);
  buf.set(head);
  buf.set(salt, head.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
};

const PRF = {
  prfOutput: new Uint8Array(32).fill(0xab),
  credentialId: new Uint8Array([1, 2, 3]),
  prfSalt: new Uint8Array(32).fill(0x42),
};

/**
 * Capture the CryptoKey the vault actually encrypts/decrypts secrets with.
 * why a spy rather than an accessor: the vault deliberately exposes no way
 * to reach its DK, and adding one to make it testable would be the very
 * leak this test exists to rule out. Spying on the WebCrypto call the vault
 * makes reads the real resident handle without opening a door in the vault.
 */
const captureVaultKeys = async <T>(body: () => Promise<T>): Promise<{ result: T, keys: CryptoKey[] }> => {
  const subtle = crypto.subtle as any;
  const realEncrypt = subtle.encrypt.bind(subtle);
  const realDecrypt = subtle.decrypt.bind(subtle);
  const keys: CryptoKey[] = [];
  subtle.encrypt = (algo: any, key: CryptoKey, data: any) => { keys.push(key); return realEncrypt(algo, key, data); };
  subtle.decrypt = (algo: any, key: CryptoKey, data: any) => { keys.push(key); return realDecrypt(algo, key, data); };
  try {
    return { result: await body(), keys };
  } finally {
    delete subtle.encrypt;
    delete subtle.decrypt;
  }
};

const expectSealed = async (key: CryptoKey) => {
  expect(key.extractable).toBe(false);
  // The load-bearing assertion: no in-origin code can turn this handle
  // back into key material.
  await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  await expect(crypto.subtle.exportKey('jwk', key)).rejects.toThrow();
};

// ---------------------------------------------------------------------------
// The primitives (keys.js)
// ---------------------------------------------------------------------------

describe('unwrapDK', () => {
  test('yields a NON-EXTRACTABLE data key whose export rejects', async () => {
    const kek = await importRawKEK(kekBytes(7));
    const wrapped = await wrapDK(await generateDK(), kek);
    const resident = await unwrapDK(wrapped, kek);
    await expectSealed(resident);
    expect([...resident.usages].sort()).toEqual(['decrypt', 'encrypt']);
  });

  test('still opens what the original data key sealed', async () => {
    const dk = await generateDK();
    const kek = await importRawKEK(kekBytes(8));
    const blob = await encryptString(dk, 'anthropic key: sk-test-123');
    const resident = await unwrapDK(await wrapDK(dk, kek), kek);
    expect(await decryptString(resident, blob)).toBe('anthropic key: sk-test-123');
    // …and seals what the original opens: the round trip works both ways.
    expect(await decryptString(dk, await encryptString(resident, 'x'))).toBe('x');
  });
});

describe('unwrapWrappableDK', () => {
  test('yields an EXTRACTABLE handle on the same key — the wrapKey seam', async () => {
    const dk = await generateDK();
    const kek = await importRawKEK(kekBytes(9));
    const wrappable = await unwrapWrappableDK(await wrapDK(dk, kek), kek);
    expect(wrappable.extractable).toBe(true);
    // It is the SAME key: its raw bytes match the original's, and it can
    // be re-wrapped under a different factor (what enrollment needs).
    expect(await exportRawDK(wrappable)).toEqual(await exportRawDK(dk));
    const other = await importRawKEK(kekBytes(10));
    await expect(wrapDK(wrappable, other)).resolves.toBeInstanceOf(Uint8Array);
  });

  test('a non-extractable handle cannot be re-wrapped — why the seam exists', async () => {
    const kek = await importRawKEK(kekBytes(11));
    const resident = await unwrapDK(await wrapDK(await generateDK(), kek), kek);
    await expect(wrapDK(resident, await importRawKEK(kekBytes(12)))).rejects.toThrow();
  });
});

describe('generateRewrapKEK', () => {
  test('is a non-extractable AES-KW key that only wraps and unwraps', async () => {
    const kek = await generateRewrapKEK();
    expect(kek.extractable).toBe(false);
    expect([...kek.usages].sort()).toEqual(['unwrapKey', 'wrapKey']);
    expect((kek.algorithm as AesKeyAlgorithm).name).toBe('AES-KW');
    await expect(crypto.subtle.exportKey('raw', kek)).rejects.toThrow();
  });

  test('is fresh per call, so one instance cannot open another\'s ciphertext', async () => {
    const dk = await generateDK();
    const wrapped = await wrapDK(dk, await generateRewrapKEK());
    await expect(unwrapDK(wrapped, await generateRewrapKEK())).rejects.toThrow();
  });
});

describe('importWrappableDK and exportRawDK', () => {
  test('round-trip the raw bytes of a data key', async () => {
    const dk = await generateDK();
    const raw = await exportRawDK(dk);
    expect(raw).toBeInstanceOf(Uint8Array);
    expect(raw.byteLength).toBe(32);
    const restored = await importWrappableDK(raw);
    expect(await exportRawDK(restored)).toEqual(raw);
  });

  test('importWrappableDK refuses material that is not exactly 32 bytes', () => {
    expect(() => importWrappableDK(new Uint8Array(31))).toThrow(
      'crypto: DK material must be exactly 32 bytes',
    );
    expect(() => importWrappableDK(new Uint8Array(33))).toThrow(
      'crypto: DK material must be exactly 32 bytes',
    );
  });

  test('exportRawDK rejects a sealed key — it is only ever handed a transient one', async () => {
    const kek = await importRawKEK(kekBytes(13));
    const resident = await unwrapDK(await wrapDK(await generateDK(), kek), kek);
    await expect(exportRawDK(resident)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The vault: the key it actually uses is sealed, on every entry path
// ---------------------------------------------------------------------------

describe('the resident DK the vault encrypts with', () => {
  test('is sealed after a passphrase unlock, and the secret still round-trips', async () => {
    const kv = makeKV();
    const seed = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await seed.initialize(PASS);
    seed.lock();

    const v = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    const { result, keys } = await captureVaultKeys(async () => {
      await v.unlock(PASS);
      await v.setSecret('anthropic', 'sk-ant-round-trip');
      return v.getSecret('anthropic');
    });
    expect(result).toBe('sk-ant-round-trip');
    expect(keys.length).toBeGreaterThanOrEqual(2);   // one encrypt, one decrypt
    for (const key of keys) await expectSealed(key);
  });

  test('is sealed after a WebAuthn-PRF unlock, and the secret still round-trips', async () => {
    const kv = makeKV();
    const seed = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await seed.initializeWithPrfOnly(PRF);
    await seed.setSecret('openai', 'sk-oai-prf');
    seed.lock();

    const v = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    const { result, keys } = await captureVaultKeys(async () => {
      await v.unlockWithPrf(PRF.prfOutput);
      return v.getSecret('openai');
    });
    expect(result).toBe('sk-oai-prf');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) await expectSealed(key);
  });

  test('is sealed right after initialize, before any lock cycle', async () => {
    const v = createVault({ kv: makeKV(), argon2: fakeArgon2, autoLockMs: 0 });
    await v.initialize(PASS);
    const { keys } = await captureVaultKeys(async () => {
      await v.setSecret('k', 'fresh-vault');
      return v.getSecret('k');
    });
    for (const key of keys) await expectSealed(key);
  });

  test('is sealed after a service-worker-restart resume from session storage', async () => {
    const kv = makeKV();
    const sessionCache = makeSession();
    const first = createVault({ kv, sessionCache, argon2: fakeArgon2, autoLockMs: 0 });
    await first.initialize(PASS);
    await first.setSecret('k', 'survives-sw-restart');
    // _persistDK is fire-and-forget; let the microtask land.
    await new Promise((r) => setTimeout(r, 0));

    const revived = createVault({ kv, sessionCache, argon2: fakeArgon2, autoLockMs: 0 });
    const { result, keys } = await captureVaultKeys(async () => {
      expect(await revived.attemptResume()).toBe(true);
      return revived.getSecret('k');
    });
    expect(result).toBe('survives-sw-restart');
    for (const key of keys) await expectSealed(key);
  });
});

// ---------------------------------------------------------------------------
// The re-wrap seam: every path that must WRAP the live DK still works
// ---------------------------------------------------------------------------

describe('re-wrapping the live DK under a new factor', () => {
  test('enrollPrf after a passphrase unlock produces a working PRF factor', async () => {
    const kv = makeKV();
    const seed = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await seed.initialize(PASS);
    await seed.setSecret('k', 'same-dk-both-ways');
    seed.lock();

    const v = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await v.unlock(PASS);
    await v.enrollPrf(PRF);
    expect((await v.prfStatus()).enrolled).toBe(true);
    v.lock();

    const viaPrf = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await viaPrf.unlockWithPrf(PRF.prfOutput);
    expect(await viaPrf.getSecret('k')).toBe('same-dk-both-ways');
  });

  test('setRecoveryPassphrase after a PRF unlock produces a working passphrase factor', async () => {
    const kv = makeKV();
    const seed = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await seed.initializeWithPrfOnly(PRF);
    await seed.setSecret('k', 'recovery-works');
    seed.lock();

    const v = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await v.unlockWithPrf(PRF.prfOutput);
    expect(await v.hasRecoveryPassphrase()).toBe(false);
    await v.setRecoveryPassphrase(PASS);
    expect(await v.hasRecoveryPassphrase()).toBe(true);
    v.lock();

    const viaPass = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await viaPass.unlock(PASS);
    expect(await viaPass.getSecret('k')).toBe('recovery-works');
  });

  test('enrollment works after a RESUME too — the seam is rebuilt on every adopt', async () => {
    // why this case: the resume path never sees a KEK, so if the re-wrap
    // material were only minted during unlock, enrolling a passkey after
    // an MV3 service-worker restart would silently fail.
    const kv = makeKV();
    const sessionCache = makeSession();
    const first = createVault({ kv, sessionCache, argon2: fakeArgon2, autoLockMs: 0 });
    await first.initialize(PASS);
    await first.setSecret('k', 'enrolled-after-resume');
    await new Promise((r) => setTimeout(r, 0));

    const revived = createVault({ kv, sessionCache, argon2: fakeArgon2, autoLockMs: 0 });
    expect(await revived.attemptResume()).toBe(true);
    await revived.enrollPrf(PRF);
    await revived.setRecoveryPassphrase('a-different-passphrase-entirely');
    revived.lock();

    const viaPrf = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await viaPrf.unlockWithPrf(PRF.prfOutput);
    expect(await viaPrf.getSecret('k')).toBe('enrolled-after-resume');
    const viaNewPass = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await viaNewPass.unlock('a-different-passphrase-entirely');
    expect(await viaNewPass.getSecret('k')).toBe('enrolled-after-resume');
  });

  test('the session mirror still holds the DK bytes a resume can use', async () => {
    // Documented residual, asserted so it cannot change silently: the
    // non-extractable resident handle does NOT remove the storage.session
    // copy (see the "DK persistence" note in vault.js).
    const kv = makeKV();
    const sessionCache = makeSession();
    const v = createVault({ kv, sessionCache, argon2: fakeArgon2, autoLockMs: 0 });
    await v.initialize(PASS);
    await new Promise((r) => setTimeout(r, 0));
    const stored = sessionCache.store.get(SESSION_DK_KEY);
    expect(typeof stored.dk).toBe('string');
    expect(Uint8Array.from(atob(stored.dk), (c) => c.charCodeAt(0)).byteLength).toBe(32);
    // …carried with the deadline that now bounds how long it is usable.
    expect(stored.unlockedAt).toBeGreaterThan(0);
    expect(stored.autoLockMs).toBe(0);   // this vault opted out of auto-lock
  });

  test('lock() drops the re-wrap material, so enrollment refuses while locked', async () => {
    const v = createVault({ kv: makeKV(), argon2: fakeArgon2, autoLockMs: 0 });
    await v.initialize(PASS);
    v.lock();
    await expect(v.enrollPrf(PRF)).rejects.toMatchObject({ name: 'VaultLockedError' });
    await expect(v.setRecoveryPassphrase(PASS)).rejects.toMatchObject({ name: 'VaultLockedError' });
  });
});

// ---------------------------------------------------------------------------
// Failure paths are unchanged by the sealing
// ---------------------------------------------------------------------------

describe('a failed unlock', () => {
  test('throws WrongPassphraseError, stays locked, and never rewrites the blob', async () => {
    const kv = makeKV();
    const seed = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await seed.initialize(PASS);
    seed.lock();
    const before = structuredClone(kv.store.get(VAULT_KEY));

    const v = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await expect(v.unlock('not-the-passphrase')).rejects.toMatchObject({ name: 'WrongPassphraseError' });
    expect(v.isLocked()).toBe(true);
    expect(kv.store.get(VAULT_KEY)).toEqual(before);
    // A locked vault has no re-wrap material either — nothing half-adopted.
    await expect(v.enrollPrf(PRF)).rejects.toMatchObject({ name: 'VaultLockedError' });
  });

  test('does not distinguish a wrong passphrase from a tampered wrap', async () => {
    const kv = makeKV();
    const seed = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await seed.initialize(PASS);
    seed.lock();

    const wrong = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    const wrongErr = await wrong.unlock('not-the-passphrase').catch((e) => e);

    // Flip a byte of the wrapped DK, keeping the KDF descriptor intact so
    // the same code path runs with the CORRECT passphrase.
    const blob = kv.store.get(VAULT_KEY);
    const bytes = Uint8Array.from(atob(blob.wrappedDK), (c) => c.charCodeAt(0));
    bytes[0] ^= 0xff;
    kv.store.set(VAULT_KEY, { ...blob, wrappedDK: btoa(String.fromCharCode(...bytes)) });

    const tampered = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    const tamperedErr = await tampered.unlock(PASS).catch((e) => e);

    expect(tamperedErr.name).toBe(wrongErr.name);
    expect(tamperedErr.message).toBe(wrongErr.message);
    expect(tampered.isLocked()).toBe(true);
  });

  test('a failed PRF unlock stays locked and surfaces PrfUnlockFailedError', async () => {
    const kv = makeKV();
    const seed = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await seed.initializeWithPrfOnly(PRF);
    seed.lock();

    const v = createVault({ kv, argon2: fakeArgon2, autoLockMs: 0 });
    await expect(v.unlockWithPrf(new Uint8Array(32).fill(0xcd)))
      .rejects.toMatchObject({ name: 'PrfUnlockFailedError' });
    expect(v.isLocked()).toBe(true);
  });
});
