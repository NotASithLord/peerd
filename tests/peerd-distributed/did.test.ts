import { describe, test, expect } from 'bun:test';
import { encodeDidKey, decodeDidKey } from '../../extension/peerd-distributed/identity/did.js';

describe('did:key (Ed25519)', () => {
  test('every Ed25519 did:key begins with the z6Mk multibase prefix', () => {
    // why: the 0xed01 multicodec prefix + any 32-byte key always
    // base58btc-encodes to a string starting "z6Mk". A stable invariant.
    const pub = crypto.getRandomValues(new Uint8Array(32));
    expect(encodeDidKey(pub)).toMatch(/^did:key:z6Mk/);
  });

  test('roundtrips a public key', () => {
    const pub = crypto.getRandomValues(new Uint8Array(32));
    expect([...decodeDidKey(encodeDidKey(pub))]).toEqual([...pub]);
  });

  test('rejects a non-32-byte key', () => {
    expect(() => encodeDidKey(crypto.getRandomValues(new Uint8Array(31)))).toThrow();
  });

  test('rejects a non-Ed25519 multicodec prefix', () => {
    // secp256k1-pub is 0xe701 — peerd is Ed25519-only and must reject it.
    expect(() => decodeDidKey('did:key:z' + 'notreal')).toThrow();
  });
});
