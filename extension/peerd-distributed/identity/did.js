// @ts-check
// peerd-distributed/identity/did.js — did:key for Ed25519.
//
// why: did:key is peerd's identity representation (ARCHITECTURE §3.1).
// Format: "did:key:z" + base58btc( 0xed 0x01 || pubkey[32] ), where
// 0xed01 is the multicodec varint for an Ed25519 public key and 'z' is
// the multibase tag for base58btc. Ed25519 ONLY — secp256k1 is excluded
// from peerd entirely, so we reject any other multicodec prefix.

import { base58encode, base58decode } from '../codec/base58.js';

// Multicodec prefix for an Ed25519 public key (unsigned varint of 0xed).
const ED25519_PUB_PREFIX = Uint8Array.from([0xed, 0x01]);
const DID_PREFIX = 'did:key:z';

/** @param {Uint8Array} pubkey32 */
export const encodeDidKey = (pubkey32) => {
  if (!(pubkey32 instanceof Uint8Array) || pubkey32.length !== 32) {
    throw new Error('encodeDidKey: expected a 32-byte Ed25519 public key');
  }
  const tagged = new Uint8Array(2 + 32);
  tagged.set(ED25519_PUB_PREFIX, 0);
  tagged.set(pubkey32, 2);
  return DID_PREFIX + base58encode(tagged);
};

/** @param {string} did */
export const decodeDidKey = (did) => {
  if (typeof did !== 'string' || !did.startsWith(DID_PREFIX)) {
    throw new Error('decodeDidKey: not a did:key:z… string');
  }
  const tagged = base58decode(did.slice(DID_PREFIX.length));
  if (tagged.length !== 34 || tagged[0] !== 0xed || tagged[1] !== 0x01) {
    throw new Error('decodeDidKey: unsupported key type (peerd is Ed25519-only)');
  }
  return tagged.slice(2);
};
