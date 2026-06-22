// @ts-check
// peerd-distributed/dht/routing-table.js — Kademlia k-buckets (PROTOCOL §5).
//
// 256 buckets keyed by shared-prefix length with self (dht/distance.js). Each
// bucket holds up to k contacts in least-recently-seen order. Kademlia's
// eviction prefers KEEPING long-lived nodes: when a bucket is full and a new
// contact arrives, we DON'T evict blindly — we surface the least-recently-seen
// incumbent so the caller can ping it; only if it fails to answer is it
// replaced. That LRS-preference doubles as cheap DoS resistance ("one cannot
// flush nodes' routing state by flooding with new nodes").
//
// REACHABLE-ONLY (Jimenez et al. 2009): the caller MUST only add a contact
// AFTER it has answered an inbound query — never on first hearing of it. In
// browsers, where most peers are behind NAT and many are send-only, inserting
// unreachable contacts is the dominant cause of dead routing tables. The table
// stores that discipline by contract; node.js enforces it.

import { bucketIndex, byDistanceTo } from './distance.js';

/**
 * @typedef {{ did: string, id: Uint8Array, hints?: any, seen: number }} Contact
 * An inbound contact before the table stamps it with a `seen` time.
 * @typedef {{ did: string, id: Uint8Array, hints?: any }} ContactInput
 */

/**
 * @param {{ selfId: Uint8Array, k?: number, now?: () => number }} opts
 */
export const createRoutingTable = ({ selfId, k = 8, now = Date.now }) => {
  const buckets = Array.from({ length: selfId.length * 8 }, () => /** @type {Contact[]} */ ([]));

  /** @param {Uint8Array} id */
  const bucketFor = (id) => buckets[bucketIndex(selfId, id)];

  return {
    k,
    /**
     * Record that `contact` answered us (reachable). Moves it to most-recently-
     * seen. Returns:
     *   { added:true }                 — inserted (room in the bucket)
     *   { added:false, evictCandidate} — bucket full; caller should ping the
     *                                    LRS candidate and call replace()/seen()
     *   { added:true, refreshed:true } — already known; bumped to MRU
     * @param {ContactInput} contact
     */
    seen(contact) {
      const bucket = bucketFor(contact.id);
      const i = bucket.findIndex((c) => c.did === contact.did);
      if (i >= 0) {
        const [existing] = bucket.splice(i, 1);
        existing.seen = now();
        if (contact.hints) existing.hints = contact.hints;
        bucket.push(existing); // MRU = end
        return { added: true, refreshed: true };
      }
      if (bucket.length < k) {
        bucket.push({ ...contact, seen: now() });
        return { added: true };
      }
      return { added: false, evictCandidate: bucket[0] }; // LRS = front
    },

    /**
     * Replace a dead LRS incumbent with a fresh contact (after a failed ping).
     * @param {string} deadDid
     * @param {ContactInput} contact
     */
    replace(deadDid, contact) {
      const bucket = bucketFor(contact.id);
      const i = bucket.findIndex((c) => c.did === deadDid);
      if (i < 0) return false;
      bucket.splice(i, 1);
      bucket.push({ ...contact, seen: now() });
      return true;
    },

    /** @param {string} did */
    remove(did) {
      for (const bucket of buckets) {
        const i = bucket.findIndex((c) => c.did === did);
        if (i >= 0) { bucket.splice(i, 1); return true; }
      }
      return false;
    },

    /** @param {string} did */
    has: (did) => buckets.some((b) => b.some((c) => c.did === did)),

    /**
     * The `count` contacts closest to `key` across all buckets.
     * @param {Uint8Array} key
     * @param {number} [count]
     */
    closest(key, count = k) {
      const all = buckets.flat();
      return byDistanceTo(key, all).slice(0, count);
    },

    all: () => buckets.flat(),
    size: () => buckets.reduce((n, b) => n + b.length, 0),
    /**
     * Buckets older than `staleMs` since their MRU contact — refresh targets.
     * @param {number} staleMs
     */
    staleBuckets(staleMs) {
      const t = now();
      return buckets
        .map((b, idx) => ({ idx, b }))
        .filter(({ b }) => b.length && t - b[b.length - 1].seen > staleMs)
        .map(({ idx }) => idx);
    },
  };
};
