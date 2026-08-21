// The identity capsule + credential wrappers: seal/open round-trips,
// per-credential unlock,
// tamper and wrong-passphrase failure. Pure WebCrypto — Bun territory.

import { describe, test, expect, setDefaultTimeout } from 'bun:test';
import {
  generateCapsuleKey, sealCapsule, openCapsule,
} from '../../extension/peerd-distributed/identity/capsule.js';
import {
  makePassphraseWrapper, openPassphraseWrapper,
} from '../../extension/peerd-distributed/identity/credential-wrapper.js';
import { mintKeypairMaterial } from '../../extension/peerd-distributed/identity/keypair.js';

// Exercise the production Argon2 parameters. Cold/contended CI runners can
// legitimately spend longer than Bun's generic 5 s unit-test default on one
// derivation; this is a functional crypto oracle, not the startup benchmark.
setDefaultTimeout(30_000);

describe('capsule', () => {
  test('seals and opens the same material', async () => {
    const material = await mintKeypairMaterial();
    const capK = await generateCapsuleKey();
    const capsule = await sealCapsule(material, capK);
    const back = await openCapsule(capsule, capK);
    expect(back.seed).toBe(material.seed);
    expect(back.pub).toBe(material.pub);
  });

  test('a wrong key or tampered ciphertext fails closed', async () => {
    const material = await mintKeypairMaterial();
    const capK = await generateCapsuleKey();
    const capsule = await sealCapsule(material, capK);
    await expect(openCapsule(capsule, await generateCapsuleKey())).rejects.toThrow();
    const tampered = `${capsule.slice(0, -4)}AAAA`;
    await expect(openCapsule(tampered, capK)).rejects.toThrow();
  });
});

describe('credential wrappers', () => {
  test('passphrase wrapper round-trips CapK and reopens the capsule', async () => {
    const material = await mintKeypairMaterial();
    const capK = await generateCapsuleKey();
    const capsule = await sealCapsule(material, capK);
    const wrapper = await makePassphraseWrapper(capK, 'correct horse battery');
    expect(wrapper.kind).toBe('passphrase');
    expect(wrapper.kdf?.name).toBe('Argon2id');
    const reopened = await openCapsule(capsule, await openPassphraseWrapper(wrapper, 'correct horse battery'));
    expect(reopened.pub).toBe(material.pub);
  });

  test('wrong passphrase fails at unwrap, not with garbage output', async () => {
    const capK = await generateCapsuleKey();
    const wrapper = await makePassphraseWrapper(capK, 'right');
    // AES-KW integrity check rejects a wrong KEK deterministically.
    await expect(openPassphraseWrapper(wrapper, 'wrong')).rejects.toThrow();
  });

  test('untrusted KDF work factors are refused before crypto', async () => {
    const capK = await generateCapsuleKey();
    const wrapper = await makePassphraseWrapper(capK, 'right');
    await expect(openPassphraseWrapper({
      ...wrapper,
      kdf: { ...wrapper.kdf!, iters: 999_999_999 },
    }, 'right')).rejects.toThrow(/unsupported-kdf/);
  });
});
