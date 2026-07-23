import { describe, test, expect } from 'bun:test';
import {
  IV_BYTES,
  SALT_BYTES,
  generateDK,
  wrapDK,
  unwrapDK,
  encryptString,
  decryptString,
  generateSalt,
  importRawKEK,
  importPrfKEK,
} from '../../extension/peerd-egress/vault/keys.js';

// Direct unit tests for the vault's SubtleCrypto surface. The vault suite
// exercises these through createVault; these pin the primitives themselves:
// the IV || ciphertext layout, the wrap round-trip, and the length guards.

const kekBytes = (fill: number) => new Uint8Array(32).fill(fill);

describe('generateDK', () => {
  test('mints an extractable AES-GCM key for encrypt and decrypt', async () => {
    const dk = await generateDK();
    expect(dk.type).toBe('secret');
    // extractable is required for wrapKey; see the file header.
    expect(dk.extractable).toBe(true);
    expect([...dk.usages].sort()).toEqual(['decrypt', 'encrypt']);
    expect((dk.algorithm as AesKeyAlgorithm).name).toBe('AES-GCM');
    expect((dk.algorithm as AesKeyAlgorithm).length).toBe(256);
  });
});

describe('encryptString and decryptString', () => {
  test('round-trips a utf-8 string', async () => {
    const dk = await generateDK();
    const blob = await encryptString(dk, 'anthropic key: sk-test-123 🎬');
    expect(await decryptString(dk, blob)).toBe('anthropic key: sk-test-123 🎬');
  });

  test('round-trips an empty string', async () => {
    const dk = await generateDK();
    const blob = await encryptString(dk, '');
    expect(await decryptString(dk, blob)).toBe('');
  });

  test('prepends the iv, so the blob always carries iv plus tag', async () => {
    const dk = await generateDK();
    const blob = await encryptString(dk, 'x');
    expect(blob).toBeInstanceOf(Uint8Array);
    expect(blob.byteLength).toBeGreaterThanOrEqual(IV_BYTES + 16);
  });

  test('uses a fresh iv per call, so the same plaintext encrypts differently', async () => {
    const dk = await generateDK();
    const first = await encryptString(dk, 'same plaintext');
    const second = await encryptString(dk, 'same plaintext');
    expect(first.slice(0, IV_BYTES)).not.toEqual(second.slice(0, IV_BYTES));
    expect(first).not.toEqual(second);
    expect(await decryptString(dk, first)).toBe('same plaintext');
    expect(await decryptString(dk, second)).toBe('same plaintext');
  });

  test('rejects a blob too short to hold an iv and a tag', async () => {
    const dk = await generateDK();
    await expect(
      decryptString(dk, new Uint8Array(IV_BYTES + 15)),
    ).rejects.toThrow('crypto: ciphertext too short');
  });

  test('rejects a blob encrypted under a different data key', async () => {
    const dk = await generateDK();
    const other = await generateDK();
    const blob = await encryptString(dk, 'secret');
    await expect(decryptString(other, blob)).rejects.toThrow();
  });

  test('rejects a blob whose ciphertext was tampered with', async () => {
    const dk = await generateDK();
    const blob = await encryptString(dk, 'secret');
    blob[blob.length - 1] ^= 0xff;
    await expect(decryptString(dk, blob)).rejects.toThrow();
  });
});

describe('wrapDK and unwrapDK', () => {
  test('round-trips the data key through a kek', async () => {
    const dk = await generateDK();
    const kek = await importRawKEK(kekBytes(7));
    const wrapped = await wrapDK(dk, kek);
    expect(wrapped).toBeInstanceOf(Uint8Array);

    const restored = await unwrapDK(wrapped, kek);
    const blob = await encryptString(dk, 'vault secret');
    // The unwrapped key is the same DK, so it opens what the original sealed.
    expect(await decryptString(restored, blob)).toBe('vault secret');
  });

  test('rejects an unwrap under the wrong kek', async () => {
    const dk = await generateDK();
    const wrapped = await wrapDK(dk, await importRawKEK(kekBytes(1)));
    await expect(
      unwrapDK(wrapped, await importRawKEK(kekBytes(2))),
    ).rejects.toThrow();
  });

  test('rejects an unwrap of tampered bytes', async () => {
    const dk = await generateDK();
    const kek = await importRawKEK(kekBytes(3));
    const wrapped = await wrapDK(dk, kek);
    wrapped[0] ^= 0xff;
    await expect(unwrapDK(wrapped, kek)).rejects.toThrow();
  });
});

describe('generateSalt', () => {
  test('returns SALT_BYTES of randomness by default', () => {
    const salt = generateSalt();
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.byteLength).toBe(SALT_BYTES);
  });

  test('uses the injected randomBytes seam', () => {
    const asked: number[] = [];
    const salt = generateSalt((n) => {
      asked.push(n);
      return new Uint8Array(n).fill(9);
    });
    expect(asked).toEqual([SALT_BYTES]);
    expect(salt).toEqual(new Uint8Array(SALT_BYTES).fill(9));
  });
});

describe('importRawKEK', () => {
  test('imports 32 bytes as a non-extractable AES-KW kek', async () => {
    const kek = await importRawKEK(kekBytes(3));
    expect(kek.extractable).toBe(false);
    expect([...kek.usages].sort()).toEqual(['unwrapKey', 'wrapKey']);
    expect((kek.algorithm as AesKeyAlgorithm).name).toBe('AES-KW');
  });

  test('refuses material that is not exactly 32 bytes', () => {
    expect(() => importRawKEK(new Uint8Array(31))).toThrow(
      'crypto: KEK material must be exactly 32 bytes',
    );
    expect(() => importRawKEK(new Uint8Array(33))).toThrow(
      'crypto: KEK material must be exactly 32 bytes',
    );
  });
});

describe('importPrfKEK', () => {
  test('accepts a 32-byte prf output and yields a working kek', async () => {
    const kek = await importPrfKEK(kekBytes(5));
    const dk = await generateDK();
    const wrapped = await wrapDK(dk, kek);
    await expect(unwrapDK(wrapped, kek)).resolves.toBeDefined();
  });

  test('refuses a prf output of the wrong length with its own message', () => {
    expect(() => importPrfKEK(new Uint8Array(16))).toThrow(
      'crypto: PRF output must be exactly 32 bytes',
    );
  });
});
