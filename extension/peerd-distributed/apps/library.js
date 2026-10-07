// @ts-check
// peerd-distributed/apps/library.js — the bounded discovery cache.
//
// Where DWAPP_META cards LAND (PROPAGATION.md, Plane 1). This is today's
// in-memory `heardDwapps` grown up: a bounded, no-downgrade, blocklist-gated
// store with a recent verified-contribution eviction hint. The host swaps the Map
// for an IDB-backed store with the SAME surface (the functional-core rule —
// gossip/sync.js does the same).
//
// Two rules carry the design:
//   - NO DOWNGRADE: a card is accepted only if its `seq` exceeds the one held
//     for that dwapp_id (the version-amendment / anti-rollback rule).
//   - RECENT CONTRIBUTIONS: prefer retaining versions whose bytes were recently
//     received and verified locally; this is not a live or complete-seeder count.
//
// Pure: id derivation (async hashing) happens in the caller (discovery.js); the
// Library takes the derived id, so it stays synchronous and trivially testable.

import { parsePeerdUri } from '../content/uri.js';

export const CONTRIBUTION_TTL_MS = 5 * 60_000;
export const MAX_RECENT_CONTRIBUTORS = 8;

export const DEFAULT_CAP = 10_000;

/**
 * A verified DWAPP_META card (the same signed-DHT-item shape apps/meta.js builds).
 * @typedef {{
 *   publisher: string,
 *   salt?: string,
 *   seq: number,
 *   value: { name: string, description?: string, head?: any, [k: string]: any },
 *   [k: string]: any,
 * }} MetaItem
 */

/**
 * @typedef {{
 *   id: string,
 *   item: MetaItem,
 *   publisher: string,
 *   slug?: string,
 *   seq: number,
 *   lastSeen: number,
 *   contributors: Map<string, number>,
 *   installed: boolean,
 * }} LibraryEntry
 */

/**
 * @param {{
 *   cap?: number,
 *   isBlocked?: (did: string) => boolean,
 *   now?: () => number,
 * }} [opts]
 */
export const createLibrary = ({ cap = DEFAULT_CAP, isBlocked = () => false, now = Date.now } = {}) => {
  // Evidence lives only inside bounded catalog entries, never a second hash index.
  /** @type {Map<string, LibraryEntry>} */
  const entries = new Map();

  /** @param {LibraryEntry} entry */
  const pruneContributors = (entry) => {
    const time = now();
    for (const [did, observedAt] of entry.contributors) {
      if (!Number.isFinite(time) || time < observedAt || time - observedAt >= CONTRIBUTION_TTL_MS || isBlocked(did)) {
        entry.contributors.delete(did);
      }
    }
    return entry.contributors.size;
  };

  const evictOne = () => {
    // Pick the worst: no recent contribution, not-installed, oldest announcement.
    // why prefer that order: an app the user installed is theirs to keep; an app
    // with recent verified contributions has some historical evidence; neither
    // a contribution nor its absence establishes current reachability.
    /** @type {LibraryEntry | null} */
    let worst = null;
    for (const e of entries.values()) {
      pruneContributors(e);
      if (e.installed) continue;
      if (worst === null) { worst = e; continue; }
      /** @param {LibraryEntry} a @param {LibraryEntry} b */
      const better = (a, b) => {
        if ((a.contributors.size > 0) !== (b.contributors.size > 0)) return a.contributors.size === 0; // no recent contribution first
        return a.lastSeen < b.lastSeen;                                        // then oldest
      };
      if (better(e, worst)) worst = e;
    }
    if (worst) entries.delete(worst.id);
    return !!worst;
  };

  return {
    /**
     * Ingest a verified card. Returns true if it was newly stored or upgraded a
     * version (i.e. is FRESH and should be relayed onward), false otherwise.
     * @param {string} id  the derived, verified dwapp_id
     * @param {MetaItem} item   a verified DWAPP_META
     */
    put(id, item) {
      if (isBlocked(item.publisher)) return false;
      const prev = entries.get(id);
      if (prev && item.seq <= prev.seq) return false; // no downgrade / duplicate
      if (!prev && entries.size >= cap && !evictOne()) return false; // full of installed apps
      entries.set(id, {
        id,
        item,
        publisher: item.publisher,
        slug: item.salt,
        seq: item.seq,
        lastSeen: now(),
        // why: amendments to the same immutable head may retain history;
        // another version (even of the same app) has no inherited evidence.
        contributors: prev?.publisher === item.publisher
          && prev.item.value.head?.version_id === item.value.head?.version_id
          && prev.item.value.head?.content_addr === item.value.head?.content_addr
          ? prev.contributors : new Map(),
        installed: prev?.installed ?? false,
      });
      return true;
    },
    /** @param {string} id */
    get: (id) => entries.get(id)?.item ?? null,
    /** @param {string} id */
    has: (id) => entries.has(id),
    size: () => entries.size,
    // The cards a fresh subscriber gets, newest-announced first (so a capped
    // snapshot carries the most-relevant tail). Returns the raw signed items.
    list: () => [...entries.values()].sort((a, b) => b.lastSeen - a.lastSeen).map((e) => e.item),
    // Stable key order keeps a cursor valid when announcements update recency.
    // New entries before the cursor arrive through the live feed or next sweep.
    /** @param {string} after @param {number} limit */
    page(after, limit) {
      const rows = [...entries.values()].filter((entry) => entry.id > after)
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const selected = rows.slice(0, limit);
      return {
        items: selected.map((entry) => entry.item),
        next: rows.length > selected.length ? selected.at(-1)?.id ?? null : null,
      };
    },
    // Discovery rows: providers is a legacy local hint, counting recent verified
    // chunk contributors, not advertised, complete-bundle, or currently live peers.
    rows: () => [...entries.values()].map((e) => ({
      dwapp_id: e.id,
      publisher: e.publisher,
      slug: e.slug,
      name: e.item.value.name,
      description: e.item.value.description,
      head: e.item.value.head,
      seq: e.seq,
      providers: pruneContributors(e),
      installed: e.installed,
    })),
    // Called only after a successful verified bundle fetch. Ads and failed
    // transfers must never reach this local evidence seam.
    /** @param {string} publisher @param {string} hash @param {string[]} contributors */
    observeContributors(publisher, hash, contributors) {
      const observedAt = now();
      if (!Number.isFinite(observedAt) || isBlocked(publisher)) return;
      for (const entry of entries.values()) {
        const head = entry.item.value.head;
        if (entry.publisher !== publisher || head?.version_id !== hash) continue;
        try {
          const address = parsePeerdUri(head.content_addr);
          if (address.did !== publisher || address.hash !== hash || address.path !== undefined) continue;
        } catch { continue; }
        pruneContributors(entry);
        for (const did of contributors) {
          if (typeof did !== 'string' || !did || did.length > 256 || isBlocked(did)) continue;
          entry.contributors.delete(did);
          if (entry.contributors.size >= MAX_RECENT_CONTRIBUTORS) {
            const oldest = entry.contributors.keys().next().value;
            if (oldest !== undefined) entry.contributors.delete(oldest);
          }
          entry.contributors.set(did, observedAt);
        }
      }
    },
    clearContributors() { for (const entry of entries.values()) entry.contributors.clear(); },
    /** @param {string} id @param {boolean} [on] */
    markInstalled(id, on = true) { const e = entries.get(id); if (e) e.installed = !!on; },
    /** @param {string} id */
    touch(id) { const e = entries.get(id); if (e) e.lastSeen = now(); },
    /** @param {string} id */
    remove: (id) => entries.delete(id),
    // Drop everything from a now-blocked publisher (a ban shouldn't leave their
    // cards sitting in the cache, re-served on the next snapshot).
    /** @param {string} did */
    purgePublisher(did) {
      for (const [id, e] of entries) {
        if (e.publisher === did) entries.delete(id);
        else e.contributors.delete(did);
      }
    },
  };
};
