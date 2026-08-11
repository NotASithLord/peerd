// The portable identity record (docs/design/portable-identity/ 02):
// build → open across independent credentials, structural validation,
// the did-binding tamper check, and the adoption decision table an
// import runs (existing did wins; same did merges; no credential → no
// identity). This is the Phase-1 exit proof at the values level: the
// SAME did comes out on the other side.

import { describe, test, expect } from 'bun:test';
import {
  buildIdentityRecord, openIdentityRecord, adoptIdentityRecord, validateIdentityRecord,
  RECORD_FORMAT, RECORD_VERSION,
} from '../../extension/peerd-distributed/identity/recovery-record.js';
import { mintKeypairMaterial, identityFromMaterial, verifySignature } from '../../extension/peerd-distributed/identity/keypair.js';
import { generateCapsuleKey, sealCapsule } from '../../extension/peerd-distributed/identity/capsule.js';
import { makePassphraseWrapper } from '../../extension/peerd-distributed/identity/credential-wrapper.js';

describe('buildIdentityRecord / openIdentityRecord', () => {
  test('round-trips the SAME did through a passphrase wrapper', async () => {
    const material = await mintKeypairMaterial();
    const record = await buildIdentityRecord({
      material, wrappers: [{ kind: 'passphrase', passphrase: 'export-pass-123' }], now: 1000,
    });
    expect(record.format).toBe(RECORD_FORMAT);
    expect(record.version).toBe(RECORD_VERSION);
    expect(record.did).toBe(material.did);
    expect(record.updatedAt).toBe(1000);
    const back = await openIdentityRecord(record, { passphrase: 'export-pass-123' });
    expect(back.did).toBe(material.did);
    expect(back.seed).toBe(material.seed);
  });

  test('a recovered identity SIGNS verifiably under the original did', async () => {
    const material = await mintKeypairMaterial();
    const record = await buildIdentityRecord({
      material, wrappers: [{ kind: 'passphrase', passphrase: 'pw-pw-pw' }],
    });
    const recovered = await openIdentityRecord(record, { passphrase: 'pw-pw-pw' });
    const identity = await identityFromMaterial(recovered);
    const bytes = new TextEncoder().encode('hello from the new install');
    const sig = await identity.sign(bytes);
    expect(await verifySignature(material.did, sig, bytes)).toBe(true);
  });

  test('a swapped did (capsule/did mismatch) is refused after decryption', async () => {
    const material = await mintKeypairMaterial();
    const other = await mintKeypairMaterial();
    const record = await buildIdentityRecord({
      material, wrappers: [{ kind: 'passphrase', passphrase: 'pw' }],
    });
    const forged = { ...record, did: other.did };
    expect(openIdentityRecord(forged, { passphrase: 'pw' })).rejects.toThrow(/does not match/);
  });

  test('a seed paired with another public key is refused before adoption', async () => {
    const a = await mintKeypairMaterial();
    const b = await mintKeypairMaterial();
    const capsuleKey = await generateCapsuleKey();
    const record = {
      format: RECORD_FORMAT,
      version: RECORD_VERSION,
      did: b.did,
      capsule: await sealCapsule({ seed: a.seed, pub: b.pub }, capsuleKey),
      wrappers: [await makePassphraseWrapper(capsuleKey, 'pw')],
      updatedAt: 1,
    };
    expect(openIdentityRecord(record, { passphrase: 'pw' })).rejects.toThrow(/valid keypair/);
  });

  test('unknown wrapper kinds are skipped, not fatal (forward compat)', async () => {
    const material = await mintKeypairMaterial();
    const record = await buildIdentityRecord({
      material, wrappers: [{ kind: 'passphrase', passphrase: 'pw' }],
    });
    const future = { ...record, wrappers: [{ kind: 'post-quantum-lattice', wrappedKey: 'AAAA' }, ...record.wrappers] };
    const back = await openIdentityRecord(future, { passphrase: 'pw' });
    expect(back.did).toBe(material.did);
  });

  test('version 1 refuses more than one passphrase wrapper', async () => {
    const material = await mintKeypairMaterial();
    await expect(buildIdentityRecord({
      material,
      wrappers: [
        { kind: 'passphrase', passphrase: 'one' },
        { kind: 'passphrase', passphrase: 'two' },
      ],
    })).rejects.toMatchObject({ code: 'too-many-passphrase-wrappers' });
  });
});

describe('validateIdentityRecord', () => {
  test('names the defect instead of throwing', async () => {
    expect(validateIdentityRecord(null)).toBe('not-a-record');
    expect(validateIdentityRecord({ format: 'nope' })).toBe('wrong-format');
    expect(validateIdentityRecord({ format: RECORD_FORMAT, version: 99 })).toBe('unsupported-version-99');
    const material = await mintKeypairMaterial();
    const good = await buildIdentityRecord({ material, wrappers: [{ kind: 'passphrase', passphrase: 'pw' }] });
    expect(validateIdentityRecord(good)).toBeNull();
    expect(validateIdentityRecord({ ...good, wrappers: Array(9).fill(good.wrappers[0]) })).toBe('too-many-wrappers');
    expect(validateIdentityRecord({ ...good, wrappers: [good.wrappers[0], good.wrappers[0]] }))
      .toBe('too-many-passphrase-wrappers');
    expect(validateIdentityRecord({ ...good, did: `did:key:z${'1'.repeat(1_000_000)}` }))
      .toBe('bad-did');
    expect(validateIdentityRecord({
      ...good,
      wrappers: [{ ...good.wrappers[0], kdf: { ...good.wrappers[0].kdf, iters: 999_999_999 } }],
    })).toBe('bad-wrapper-unsupported-kdf');
  });
});

describe('adoptIdentityRecord — the import decision', () => {
  test('fresh install + right passphrase → recovered, material matches keypair.js layout', async () => {
    const material = await mintKeypairMaterial();
    const record = await buildIdentityRecord({ material, wrappers: [{ kind: 'passphrase', passphrase: 'pw123456' }] });
    const outcome = await adoptIdentityRecord({ record, passphrase: 'pw123456', existingMaterial: null });
    expect(outcome.adopted).toBe(true);
    expect(outcome.reason).toBe('recovered');
    expect(outcome.did).toBe(material.did);
    const stored = JSON.parse(outcome.material as string);
    expect(stored).toEqual({ v: 1, seed: material.seed, pub: material.pub });
  });

  test('existing identity with the SAME did → keep local seed, no material write', async () => {
    const material = await mintKeypairMaterial();
    const record = await buildIdentityRecord({ material, wrappers: [{ kind: 'passphrase', passphrase: 'pw' }] });
    const existing = JSON.stringify({ v: 1, seed: material.seed, pub: material.pub });
    const outcome = await adoptIdentityRecord({ record, passphrase: 'pw', existingMaterial: existing });
    expect(outcome.adopted).toBe(true);
    expect(outcome.reason).toBe('already-present');
    expect(outcome.material).toBeNull();
  });

  test('same-did metadata is not enough: the wrapper must authenticate', async () => {
    const material = await mintKeypairMaterial();
    const record = await buildIdentityRecord({ material, wrappers: [{ kind: 'passphrase', passphrase: 'right' }] });
    const existing = JSON.stringify({ v: 1, seed: material.seed, pub: material.pub });
    const outcome = await adoptIdentityRecord({ record, passphrase: 'wrong', existingMaterial: existing });
    expect(outcome.adopted).toBe(false);
    expect(outcome.reason).toBe('no-openable-wrapper');
  });

  test('existing identity with a DIFFERENT did → refused (the did invariant beats the import)', async () => {
    const material = await mintKeypairMaterial();
    const local = await mintKeypairMaterial();
    const record = await buildIdentityRecord({ material, wrappers: [{ kind: 'passphrase', passphrase: 'pw' }] });
    const existing = JSON.stringify({ v: 1, seed: local.seed, pub: local.pub });
    const outcome = await adoptIdentityRecord({ record, passphrase: 'pw', existingMaterial: existing });
    expect(outcome.adopted).toBe(false);
    expect(outcome.reason).toBe('did-conflict');
    expect(outcome.did).toBe(local.did);
    expect(outcome.existingDid).toBe(local.did);
    expect(outcome.incomingDid).toBe(material.did);
  });

  test('a different identity is replaced only with explicit approval', async () => {
    const material = await mintKeypairMaterial();
    const local = await mintKeypairMaterial();
    const record = await buildIdentityRecord({ material, wrappers: [{ kind: 'passphrase', passphrase: 'pw' }] });
    const existing = JSON.stringify({ v: 1, seed: local.seed, pub: local.pub });
    const outcome = await adoptIdentityRecord({
      record, passphrase: 'pw', existingMaterial: existing, replaceExisting: true,
    });
    expect(outcome.adopted).toBe(true);
    expect(outcome.reason).toBe('replaced');
    expect(outcome.did).toBe(material.did);
    expect(JSON.parse(outcome.material as string).pub).toBe(material.pub);
  });

  test('an unreadable local identity requires explicit replacement', async () => {
    const material = await mintKeypairMaterial();
    const record = await buildIdentityRecord({
      material, wrappers: [{ kind: 'passphrase', passphrase: 'pw' }],
    });
    const conflict = await adoptIdentityRecord({
      record, passphrase: 'pw', existingMaterial: '{broken',
    });
    expect(conflict).toMatchObject({
      adopted: false, reason: 'invalid-local-identity', incomingDid: material.did,
    });
    const repaired = await adoptIdentityRecord({
      record, passphrase: 'pw', existingMaterial: '{broken', replaceExisting: true,
    });
    expect(repaired).toMatchObject({
      adopted: true, reason: 'replaced-invalid-local', did: material.did,
    });
  });

  test('no openable wrapper (wrong passphrase) → not adopted, no leak of why per-wrapper', async () => {
    const material = await mintKeypairMaterial();
    const record = await buildIdentityRecord({ material, wrappers: [{ kind: 'passphrase', passphrase: 'right' }] });
    const outcome = await adoptIdentityRecord({ record, passphrase: 'wrong', existingMaterial: null });
    expect(outcome.adopted).toBe(false);
    expect(outcome.reason).toBe('no-openable-wrapper');
    expect(outcome.material).toBeNull();
  });

  test('structurally invalid record → named refusal', async () => {
    const outcome = await adoptIdentityRecord({ record: { format: 'junk' }, passphrase: 'pw' });
    expect(outcome.adopted).toBe(false);
    expect(outcome.reason).toBe('wrong-format');
  });
});
