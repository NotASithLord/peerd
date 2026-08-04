// @ts-check
// DPoP proof-of-possession keypair ↔ REAL IndexedDB, in a real browser.
//
// why this tier and not Bun: the whole INV-15 claim rests on a
// non-extractable ECDSA CryptoKey being PERSISTED as a structured-clone
// HANDLE — the key survives an MV3 service-worker eviction without ever
// becoming bytes we hold. Bun's tests/peerd-egress/dpop.test.ts proves the
// shaping, the lifecycle rules, and that a FRESH key is non-extractable, but
// it stands the store up on a plain `Map`: the handle it "persists" keeps its
// object identity, so it never actually crosses IndexedDB's structured-clone
// boundary. fake-indexeddb can't help — it refuses to clone a CryptoKey at
// all. Only a real IndexedDB in a real browser answers the load-bearing
// question: does the handle come back on the OTHER side of a store→evict→load
// cycle still non-extractable, still unexportable, and still able to sign a
// proof that verifies against its persisted public key? That is the property a
// server-bound credential's survival across SW restarts depends on, and this
// is the only surface that can prove it.

import { describe, it, expect } from '../../framework.js';
import {
  idb, DPOP_KEY_STORE, generateDpopKeypair, makeDpopKeyStore,
  getOrCreateDpopKey, usableDpopPrivateKey, signDpopProof, dpopJkt,
} from '/peerd-egress/index.js';

// base64url → bytes, just enough to pull the raw r||s signature out of a
// compact JWS for verification. (The proof module owns the encode side; the
// test owns the decode side so it isn't grading the code with its own helper.)
/** @param {string} s @returns {Uint8Array} */
const b64urlToBytes = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

// Verify a compact-JWS DPoP proof against a public JWK, the way an RFC 9449
// server would: re-hash the `header.payload` signing input and check the raw
// ES256 signature (NOT DER — WebCrypto ECDSA verify takes raw r||s).
/** @param {string} proof @param {any} publicJwk @returns {Promise<boolean>} */
const proofVerifies = async (proof, publicJwk) => {
  const parts = proof.split('.');
  if (parts.length !== 3) return false;
  const pub = await crypto.subtle.importKey(
    'jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, pub,
    /** @type {BufferSource} */ (b64urlToBytes(parts[2])),
    /** @type {BufferSource} */ (new TextEncoder().encode(`${parts[0]}.${parts[1]}`)),
  );
};

const ORIGIN = 'https://api.dpop-idb-test.example.com';
const OTHER = 'https://other.dpop-idb-test.example.com';

// Read the raw persisted record straight from the store (not via the module),
// so an assertion sees exactly what IndexedDB handed back post-clone.
/** @param {string} origin */
const rawRecord = (origin) => idb.get(DPOP_KEY_STORE, origin);

describe('DPoP key ↔ real IndexedDB (structured-clone handle)', () => {
  it('a non-extractable private key survives a real put→get round-trip, still sealed', async () => {
    await idb.clear(DPOP_KEY_STORE);
    const { privateKey, publicJwk } = await generateDpopKeypair();
    // Sanity: the freshly generated key is what INV-15 describes.
    expect(usableDpopPrivateKey(privateKey)).toBe(true);

    // Persist the HANDLE, then read it back in a SEPARATE transaction — a real
    // structured clone, a genuinely different CryptoKey object from the one we
    // put in (this is the crossing a Map can't reproduce).
    await idb.put(DPOP_KEY_STORE, { origin: ORIGIN, privateKey, publicJwk, createdAt: 1 });
    const back = await rawRecord(ORIGIN);

    expect(back.privateKey instanceof CryptoKey).toBe(true);
    expect(back.privateKey === privateKey).toBe(false);  // a real clone, not the same object
    // The seal held ACROSS the clone: still the exact key INV-15 requires.
    expect(usableDpopPrivateKey(back.privateKey)).toBe(true);
    expect(back.privateKey.extractable).toBe(false);
    // And still unreadable — exportKey REJECTS on the round-tripped handle, for
    // every format, exactly as it does on the original. This is "peerd cannot
    // see it" proven on the persisted copy, not just the freshly minted one.
    await expect(() => crypto.subtle.exportKey('pkcs8', back.privateKey)).toThrow();
    await expect(() => crypto.subtle.exportKey('jwk', back.privateKey)).toThrow();
    await expect(() => crypto.subtle.exportKey('raw', back.privateKey)).toThrow();
    // The persisted PUBLIC half is a public JWK — no private scalar rode along.
    expect(JSON.stringify(back.publicJwk).includes('"d"')).toBe(false);

    await idb.clear(DPOP_KEY_STORE);
  });

  it('the round-tripped handle still signs a proof that verifies against its persisted public key', async () => {
    await idb.clear(DPOP_KEY_STORE);
    const { privateKey, publicJwk } = await generateDpopKeypair();
    await idb.put(DPOP_KEY_STORE, { origin: ORIGIN, privateKey, publicJwk, createdAt: 1 });
    const back = await rawRecord(ORIGIN);

    // Mint through the REAL production signing path, using the persisted handle
    // + persisted public JWK — nothing from the pre-clone objects.
    const proof = await signDpopProof({
      privateKey: back.privateKey,
      publicJwk: back.publicJwk,
      method: 'POST',
      url: `${ORIGIN}/v1/charge`,
      jti: 'test-jti-abc',
      iatSeconds: 1_700_000_000,
    });
    expect(typeof proof).toBe('string');
    // The proof verifies: the persisted private handle and the persisted public
    // key are still a working pair after IndexedDB cloned them apart.
    expect(await proofVerifies(/** @type {string} */ (proof), back.publicJwk)).toBe(true);
    // A tampered signing input must not verify (the check has teeth).
    const tampered = /** @type {string} */ (proof).replace(/^[^.]+/, 'Zm9v');
    expect(await proofVerifies(tampered, back.publicJwk)).toBe(false);

    await idb.clear(DPOP_KEY_STORE);
  });

  it('getOrCreateDpopKey mints once, then reloads the SAME key from real IDB (SW-eviction resume)', async () => {
    await idb.clear(DPOP_KEY_STORE);
    const store = makeDpopKeyStore(idb);

    // First call: no record → mint + persist to real IndexedDB.
    const first = await getOrCreateDpopKey(ORIGIN, store);
    expect(first?.privateKey instanceof CryptoKey).toBe(true);
    const persisted = await rawRecord(ORIGIN);
    expect(persisted !== undefined).toBe(true);

    // Simulate a service-worker eviction: a brand-new store over the SAME real
    // IDB, no in-memory carryover. The key must come back FROM DISK, unchanged
    // in identity where it counts — the jkt the authorization server bound a
    // token to — and never be re-minted (a re-mint would silently 401 the user).
    const freshStore = makeDpopKeyStore(idb);
    const second = await getOrCreateDpopKey(ORIGIN, freshStore);
    expect(await dpopJkt(/** @type {any} */ (second).publicJwk))
      .toBe(await dpopJkt(/** @type {any} */ (first).publicJwk));
    // Still exactly one record — the load path took, nothing was overwritten.
    expect((await idb.getAll(DPOP_KEY_STORE)).length).toBe(1);
    // The reloaded private handle is still sealed after living in IDB.
    expect(usableDpopPrivateKey(second?.privateKey)).toBe(true);
    await expect(() => crypto.subtle.exportKey('pkcs8', /** @type {any} */ (second).privateKey)).toThrow();

    await idb.clear(DPOP_KEY_STORE);
  });

  it('a second origin persists its own independent key (no cross-origin sharing on disk)', async () => {
    await idb.clear(DPOP_KEY_STORE);
    const store = makeDpopKeyStore(idb);
    const a = await getOrCreateDpopKey(ORIGIN, store);
    const b = await getOrCreateDpopKey(OTHER, store);

    expect((await idb.getAll(DPOP_KEY_STORE)).length).toBe(2);
    // Distinct keys → distinct thumbprints: two integrations can't be
    // correlated by a shared jkt, and that separation survives on disk.
    const jktA = await dpopJkt(/** @type {any} */ (a).publicJwk);
    const jktB = await dpopJkt(/** @type {any} */ (b).publicJwk);
    expect(jktA === jktB).toBe(false);

    await idb.clear(DPOP_KEY_STORE);
  });
});
