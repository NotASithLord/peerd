// peerd-distributed/dht/store.js — the local DHT item store (PROTOCOL §5).
//
// What a node holds of the network's directory: signed items it is among the
// k-closest to. Enforces the storage rules every STORE must pass — valid
// signature, no seq downgrade, size cap, the key matching the publisher — and
// an expiry (items must be periodically re-PUT, BEP-44 self-healing). IO is
// injected: pass a persistent kv (IndexedDB) in production, omit for an
// in-memory store in tests.

import { toHex } from '/shared/bundle/bytes.js';
import { verifyItem, itemKey, itemWellFormed } from './records.js';

export const ITEM_TTL_MS = 60 * 60 * 1000; // 1h, then it must be re-PUT
const MAX_KEYS = 4096; // a single browser node's directory shard ceiling

/**
 * @param {{ now?: () => number, persist?: { load: () => Promise<any>, save: (s: any) => Promise<void> } }} opts
 */
export const createDhtStore = ({ now = Date.now, persist = null } = {}) => {
  const items = new Map(); // hexKey -> { item, storedAt }
  let loaded = !persist;

  const load = async () => {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await persist.load();
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) items.set(k, v);
      }
    } catch { /* fresh */ }
  };
  const flush = () => { if (persist) persist.save(Object.fromEntries(items)).catch(() => {}); };

  const evictExpired = () => {
    const t = now();
    for (const [k, v] of items) if (t - v.storedAt > ITEM_TTL_MS) items.delete(k);
  };

  return {
    /**
     * Apply a STORE. Returns { ok, reason? }. Rejects on: malformed, bad sig,
     * key mismatch, seq downgrade, or capacity. Idempotent re-PUT of the same
     * seq refreshes the TTL (self-healing).
     */
    async put(item) {
      await load();
      if (!itemWellFormed(item)) return { ok: false, reason: 'malformed' };
      const keyBytes = await itemKey(item);
      const key = toHex(keyBytes);
      const existing = items.get(key);
      if (existing && item.seq < existing.item.seq) return { ok: false, reason: 'seq-downgrade' };
      if (!(await verifyItem(item))) return { ok: false, reason: 'bad-signature' };
      if (!existing && items.size >= MAX_KEYS) { evictExpired(); if (items.size >= MAX_KEYS) return { ok: false, reason: 'full' }; }
      items.set(key, { item, storedAt: now() });
      flush();
      return { ok: true };
    },

    /** Get a stored item by its hex key, or null if absent/expired. */
    get(hexKey) {
      const v = items.get(hexKey);
      if (!v) return null;
      if (now() - v.storedAt > ITEM_TTL_MS) { items.delete(hexKey); return null; }
      return v.item;
    },

    has: (hexKey) => Boolean(items.get(hexKey)) && now() - items.get(hexKey).storedAt <= ITEM_TTL_MS,
    sweep: () => { evictExpired(); flush(); },
    size: () => items.size,
    keys: () => [...items.keys()],
  };
};
