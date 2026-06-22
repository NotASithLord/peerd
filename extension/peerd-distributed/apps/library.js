// @ts-check
// peerd-distributed/apps/library.js — the bounded discovery cache.
//
// Where DWAPP_META cards LAND (PROPAGATION.md, Plane 1). This is today's
// in-memory `heardDwapps` grown up: a bounded, no-downgrade, blocklist-gated
// store with the popularity=availability eviction rule. The host swaps the Map
// for an IDB-backed store with the SAME surface (the functional-core rule —
// gossip/sync.js does the same).
//
// Two rules carry the design:
//   - NO DOWNGRADE: a card is accepted only if its `seq` exceeds the one held
//     for that dwapp_id (the version-amendment / anti-rollback rule).
//   - POPULARITY = AVAILABILITY: when full, evict least-recently-announced and
//     ZERO-PROVIDER entries first — an app nobody seeds ages out and disappears.
//
// Pure: id derivation (async hashing) happens in the caller (discovery.js); the
// Library takes the derived id, so it stays synchronous and trivially testable.

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
 *   providers: number,
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
  // dwapp_id -> { id, item, publisher, slug, seq, lastSeen, providers, installed }
  /** @type {Map<string, LibraryEntry>} */
  const entries = new Map();

  const evictOne = () => {
    // Pick the worst: zero-provider, not-installed, least-recently-announced.
    // why prefer that order: an app the user installed is theirs to keep; an app
    // with live seeders is reachable; the rest is cold cache, oldest-first.
    /** @type {LibraryEntry | null} */
    let worst = null;
    for (const e of entries.values()) {
      if (e.installed) continue;
      if (worst === null) { worst = e; continue; }
      /** @param {LibraryEntry} a @param {LibraryEntry} b */
      const better = (a, b) => {
        if ((a.providers > 0) !== (b.providers > 0)) return a.providers === 0; // zero-provider first
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
        providers: prev?.providers ?? 0,
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
    // Discovery view rows (what the Library UI lists) — id + card + liveness.
    rows: () => [...entries.values()].map((e) => ({
      dwapp_id: e.id,
      publisher: e.publisher,
      slug: e.slug,
      name: e.item.value.name,
      description: e.item.value.description,
      head: e.item.value.head,
      seq: e.seq,
      providers: e.providers,
      installed: e.installed,
    })),
    // Liveness signals feed the eviction rule.
    /** @param {string} id @param {number} n */
    setProviders(id, n) { const e = entries.get(id); if (e) e.providers = Math.max(0, n | 0); },
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
      for (const [id, e] of [...entries]) if (e.publisher === did) entries.delete(id);
    },
  };
};
