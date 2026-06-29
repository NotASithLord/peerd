// peerd-distributed/dht/provider-store.js — the content provider set.
//
// What a node holds of "who serves what": for each content key (H(content_addr))
// a set of self-signed provider claims, each with its own TTL. This is the
// directory half of Plane 2 — the DHT stores WHO has the bytes,
// never the bytes (the liability firewall, THREAT-MODEL §2). A provider re-PUTs
// periodically (BEP-44 self-healing); a provider that leaves stops re-PUTting and
// ages out — popularity = availability, enforced at the directory.
//
// Self-certifying: every entry is signed by its own provider, so a holder serves
// the set but can never fabricate a membership. IO is injected (omit for memory).

import { verifyProvider } from './records.js';

export const PROVIDER_TTL_MS = 60 * 60 * 1000; // 1h, then re-PUT
const MAX_KEYS = 4096;       // content keys one node will index
const MAX_PER_KEY = 64;      // providers tracked per key (the swarm only needs a few)

/**
 * @param {{ now?: () => number, ttl?: number, maxKeys?: number, maxPerKey?: number }} [opts]
 */
export const createProviderStore = ({ now = Date.now, ttl = PROVIDER_TTL_MS, maxKeys = MAX_KEYS, maxPerKey = MAX_PER_KEY } = {}) => {
  const byKey = new Map(); // key -> Map<providerDid, { ts, addedAt }>

  const live = (bucket) => {
    const t = now();
    for (const [did, v] of bucket) if (t - v.addedAt > ttl) bucket.delete(did);
    return bucket;
  };

  return {
    /** Apply an ADD_PROVIDER. Verifies the self-signature; TTL + caps enforced. */
    async add(entry) {
      if (!(await verifyProvider(entry))) return { ok: false, reason: 'bad-signature' };
      let bucket = byKey.get(entry.key);
      if (!bucket) {
        if (byKey.size >= maxKeys) return { ok: false, reason: 'full' };
        bucket = new Map();
        byKey.set(entry.key, bucket);
      }
      live(bucket);
      if (!bucket.has(entry.provider) && bucket.size >= maxPerKey) {
        // Evict the oldest to make room — a busy key keeps its freshest providers.
        let oldest = null;
        for (const [did, v] of bucket) if (!oldest || v.addedAt < oldest[1].addedAt) oldest = [did, v];
        if (oldest) bucket.delete(oldest[0]);
      }
      bucket.set(entry.provider, { ts: entry.ts, addedAt: now() });
      return { ok: true };
    },

    /** Live provider dids for a content key (expired entries dropped). */
    list(key) {
      const bucket = byKey.get(key);
      if (!bucket) return [];
      live(bucket);
      if (bucket.size === 0) { byKey.delete(key); return []; }
      return [...bucket.keys()];
    },

    sweep() { for (const [key, bucket] of byKey) { live(bucket); if (bucket.size === 0) byKey.delete(key); } },
    size: () => byKey.size,
  };
};
