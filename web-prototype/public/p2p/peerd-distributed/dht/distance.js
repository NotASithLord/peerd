// peerd-distributed/dht/distance.js — the Kademlia keyspace (PROTOCOL §5).
//
// 256-bit keyspace, XOR distance (Maymounkov & Mazières 2002). Node IDs are
// SHA-256 of the raw Ed25519 public key (so an attacker can't trivially pick
// an ID near a victim key — it's the hash, not the key); content/record keys
// are SHA-256 of their bytes. Distances are 32-byte big-endian integers; the
// "closest" peers to a key are those with the smallest XOR.
//
// Everything here is pure and synchronous EXCEPT the two id-derivations, which
// hash (async). Compute ids once, then compare cheaply.

import { decodeDidKey } from '../identity/did.js';

const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

/** Node ID for a did:key — SHA-256 of its raw 32-byte ed25519 pubkey. */
export const nodeIdOf = async (did) => sha256(decodeDidKey(did));

/** A content/record key from arbitrary bytes (e.g. a utf8 "dwapp:<id>"). */
export const keyOf = async (bytes) => sha256(bytes);

/** XOR of two equal-length byte arrays. */
export const xor = (a, b) => {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
};

/** Big-endian compare of two equal-length byte arrays: -1 if a<b, 1 if a>b, 0. */
export const compareBytes = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
};

/** Is `a` closer to `target` than `b`? -1 (a closer), 1 (b closer), 0 (tie). */
export const closerTo = (target, a, b) => compareBytes(xor(a, target), xor(b, target));

/**
 * The k-bucket index for `id` relative to `selfId`: the length of their shared
 * leading-bit prefix (0..255). Contacts that differ from us at the very first
 * bit land in bucket 0 (the farthest half of the space); contacts sharing 255
 * bits land in bucket 255 (nearest). The split-by-common-prefix convention.
 */
export const bucketIndex = (selfId, id) => {
  for (let i = 0; i < selfId.length; i++) {
    const diff = selfId[i] ^ id[i];
    if (diff) {
      let bit = 0;
      for (let mask = 0x80; mask; mask >>= 1) { if (diff & mask) break; bit++; }
      return i * 8 + bit;
    }
  }
  return selfId.length * 8 - 1; // identical to self — clamp into the last bucket
};

/** Sort a copy of `contacts` (each carrying `.id` bytes) by distance to key. */
export const byDistanceTo = (key, contacts) =>
  [...contacts].sort((a, b) => compareBytes(xor(a.id, key), xor(b.id, key)));
