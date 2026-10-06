// @ts-check
// peerd-distributed/apps/discovery.js — the sovereign metadata subscription plane.
//
// Plane 1 of PROPAGATION.md, and the spine of the whole propagation model: a
// node NEVER receives discovery metadata it didn't ask for. There is no ambient
// flood. A peer SUBSCRIBES to a neighbor's discovery feed; the neighbor replies
// with a SNAPSHOT (the whole Library it's willing to share) and from then on
// streams each new card it accepts. Either side can UNSUBSCRIBE ("stop") or ban
// the other (unilaterally, any reason). This makes spam-resistance STRUCTURAL —
// there is simply no edge over which to deliver unsolicited metadata.
//
// Wire model (mirrors gossip/sync.js's link-local carriers): frames ride a
// dedicated channel (ch=5) and are LINK-LOCAL — the carrier is signed by the
// neighbor itself (env.from === via), so the mesh's non-ch4 attribution rule
// accepts them. The INNER card is publisher-signed and verified independently
// (a neighbor can carry history, never fabricate it).
//
// Reach is transitive over CONSENTED edges: you subscribe to your peers, they
// forward everything THEY accept (from THEIR subscriptions), so a card still
// saturates the connected mesh hop-by-hop — every hop now revocable. Loops die
// on the Library's no-downgrade rule (a re-heard card is not "fresh", so it is
// not re-forwarded — the same role the gossip seen-cache plays).

import { verifyMeta, metaDwappId, metaWellFormed } from './meta.js';

export const DISCOVERY = Object.freeze({ CH: 5, SUB: 0, SNAPSHOT: 1, ITEM: 2, UNSUB: 3 });

// Reasoned defaults (PROPAGATION.md caps table) — validate under load.
const DEFAULTS = Object.freeze({
  relayPerMin: 60,    // distinct new cards accepted from one peer per minute
  snapshotMax: 200,   // cards served in a snapshot (the most-recent tail)
});

/**
 * @param {{
 *   mesh: any,
 *   identity: { did: string },
 *   library: ReturnType<typeof import('./library.js').createLibrary>,
 *   isBlocked?: (did: string) => boolean,
 *   block?: ((did: string, reason?: string) => void) | null,
 *   audit?: ((type: string, detail?: any) => void) | null,
 *   now?: () => number,
 *   caps?: { relayPerMin?: number, snapshotMax?: number },
 *   onCard?: ((card: any) => void) | null,
 *   admitMeta?: ((candidate: { dwappId: string, publisher: string, seq: number, versionId: string }) => Promise<boolean>) | null,
 * }} opts
 */
export const createDiscovery = ({
  mesh, identity, library, isBlocked = () => false, block = null, audit = null, now = Date.now, caps = {}, onCard = null,
  admitMeta = null,
} = /** @type {{ mesh: any, identity: { did: string }, library: any }} */ ({})) => {
  const relayPerMin = caps.relayPerMin ?? DEFAULTS.relayPerMin;
  const snapshotMax = caps.snapshotMax ?? DEFAULTS.snapshotMax;

  /** @type {Set<string>} */
  const subscribers = new Set();     // dids who subscribed to OUR feed (we serve them)
  // Object identity fences asynchronous verification/signing against an
  // unsubscribe followed by a new subscription to the same peer.
  /** @type {Map<string, object>} */
  const upstreams = new Map();
  /** @type {Set<string>} */
  const unsubscribed = new Set();
  /** @type {Map<string, { count: number, windowStart: number }>} */
  const buckets = new Map();         // did -> { count, windowStart } inbound rate
  /** @type {Set<string>} */
  const tombstoned = new Set();      // dwapp_ids we un-shared — refuse to re-ingest
  let autoSubscribe = true;          // the global "discovery on/off" sovereign switch
  let closed = false;

  /** @param {string} did @param {object | undefined} subscription */
  const receiving = (did, subscription) => !closed && autoSubscribe
    && !!subscription && upstreams.get(did) === subscription && !isBlocked(did);

  /** @param {string} did */
  const allow = (did) => {
    const t = now();
    let b = buckets.get(did);
    if (!b || t - b.windowStart > 60_000) { b = { count: 0, windowStart: t }; buckets.set(did, b); }
    if (b.count >= relayPerMin) return false;
    b.count += 1;
    return true;
  };

  // Send each subscriber a fresh card — except whoever we just heard it from
  // (they already have it). Our OWN announces use exceptVia = null.
  /** @param {any} item @param {string | null} [exceptVia] */
  const forward = async (item, exceptVia = null) => {
    if (subscribers.size === 0) return true;
    const env = await mesh.sign(DISCOVERY.CH, DISCOVERY.ITEM, { item });
    let propagated = true;
    for (const did of subscribers) {
      if (!closed && !isBlocked(did) && did !== exceptVia && !mesh.send(did, env)) propagated = false;
    }
    return propagated;
  };

  /** @param {string} id @param {any} item @param {string | null} via */
  const propagateCommitted = async (id, item, via) => {
    let propagated = true;
    try { onCard?.({ dwapp_id: id, ...item }); }
    catch { propagated = false; }
    try { if (!await forward(item, via)) propagated = false; }
    catch { propagated = false; }
    if (!propagated) {
      try { audit?.('discovery_card_propagation_failed', { dwapp_id: id }); }
      catch { /* observers cannot change committed discovery custody */ }
    }
    return propagated;
  };

  // Verify → blocklist → no-downgrade store → (if fresh) relay to our subscribers.
  // Returns whether the card was newly stored/upgraded.
  /** @param {any} item @param {string | null} [via] @param {object | undefined} [subscription] */
  const ingest = async (item, via = null, subscription = via ? upstreams.get(via) : undefined) => {
    const current = () => !closed && (via === null || receiving(via, subscription));
    if (!current()) return false;
    if (!metaWellFormed(item)) return false;
    const id = await metaDwappId(item);
    if (!current()) return false;
    // A known version cannot change local state. Drop it before spending the
    // new-card budget or verifying its signature, so repeated snapshots leave
    // room for the unseen tail. Unverified claims can only discard themselves.
    const known = library.get(id);
    if (known && item.seq <= known.seq) return false;
    if (via !== null && !allow(via)) {
      audit?.('discovery_rate_limited', { did: via });
      return false;
    }
    if (!(await verifyMeta(item))) { audit?.('discovery_card_invalid', { via }); return false; }
    if (!current() || isBlocked(item.publisher)) return false;
    // Refuse a card we un-shared, even if a peer who cached it re-sends it in a
    // SNAPSHOT — otherwise our own deleted app keeps re-infecting our Library (it'd
    // pop back into Discover as "by you · in your Library"). Cleared on re-share.
    if (tombstoned.has(id)) return false;
    if (admitMeta && !await admitMeta({
      dwappId: id,
      publisher: item.publisher,
      seq: item.seq,
      versionId: item.value.head.version_id,
    })) {
      audit?.('discovery_card_rollback_refused', { via, dwapp_id: id, seq: item.seq });
      return false;
    }
    // A consent change can race the durable version check as well as crypto.
    if (!current() || isBlocked(item.publisher) || tombstoned.has(id)) return false;
    const fresh = library.put(id, item);
    if (fresh) await propagateCommitted(id, item, via);
    return fresh;
  };

  /** @param {string} did */
  const sendSnapshot = async (did) => {
    const items = library.list().slice(0, snapshotMax); // newest-announced tail, capped
    const env = await mesh.sign(DISCOVERY.CH, DISCOVERY.SNAPSHOT, { items });
    if (!closed && subscribers.has(did) && !isBlocked(did)) mesh.send(did, env);
  };

  const offEnvelope = mesh.onEnvelope(async (/** @type {{ env: any, via: string }} */ { env, via }) => {
    if (closed || env.ch !== DISCOVERY.CH) return;
    if (env.from !== via) return; // link-local: the carrier MUST be the neighbor
    switch (env.typ) {
      case DISCOVERY.SUB:
        if (isBlocked(via)) return;
        subscribers.add(via);
        audit?.('discovery_subscriber_added', { did: via });
        await sendSnapshot(via);
        return;
      case DISCOVERY.UNSUB:
        subscribers.delete(via);
        return;
      case DISCOVERY.SNAPSHOT: {
        const subscription = upstreams.get(via);
        if (!receiving(via, subscription)) return;
        const items = Array.isArray(env.body?.items) ? env.body.items.slice(0, snapshotMax) : [];
        for (const it of items) {
          if (!receiving(via, subscription)) break;
          await ingest(it, via, subscription);
        }
        return;
      }
      case DISCOVERY.ITEM:
        if (!receiving(via, upstreams.get(via))) return;
        await ingest(env.body?.item, via);
        return;
      default:
        return;
    }
  });

  // Default-subscribe on connect: ask each new peer for its feed (unless the
  // sovereign switch is off). onPeer fires on both link ends, so subscriptions
  // form symmetrically. Already-linked peers are covered by subscribe-all below.
  const offPeer = mesh.onPeer((/** @type {{ did: string }} */ { did }) => {
    if (!unsubscribed.has(did)) subscribeTo(did).catch(() => {});
  });
  const offGone = mesh.onPeerGone?.((/** @type {{ did: string }} */ { did }) => {
    upstreams.delete(did);
    subscribers.delete(did);
    buckets.delete(did);
  }) ?? (() => {});

  /** @param {string} did */
  async function subscribeTo(did) {
    if (closed || !autoSubscribe || isBlocked(did)) return false;
    unsubscribed.delete(did);
    const previous = upstreams.get(did);
    const subscription = previous ?? {};
    upstreams.set(did, subscription);
    try {
      const env = await mesh.sign(DISCOVERY.CH, DISCOVERY.SUB, {});
      if (!receiving(did, subscription)) return false;
      const sent = mesh.send(did, env);
      if (!sent && !previous && upstreams.get(did) === subscription) upstreams.delete(did);
      return sent;
    } catch (error) {
      if (!previous && upstreams.get(did) === subscription) upstreams.delete(did);
      throw error;
    }
  }
  /** @param {string} did */
  async function unsubscribeFrom(did) {
    upstreams.delete(did);
    unsubscribed.add(did);
    if (closed) return false;
    const env = await mesh.sign(DISCOVERY.CH, DISCOVERY.UNSUB, {});
    // A later explicit subscribe wins over this older, delayed wire notice.
    if (closed || upstreams.has(did)) return false;
    return mesh.send(did, env);
  }

  return Object.freeze({
    // Publish (or update) one of OUR apps: store + push to our subscribers.
    /** @param {any} item */
    async announce(item) {
      if (item.publisher !== identity.did) throw new Error('announce: not our card to publish');
      const id = await metaDwappId(item);
      tombstoned.delete(id); // re-sharing an app lifts its un-share tombstone
      if (admitMeta && !await admitMeta({
        dwappId: id,
        publisher: item.publisher,
        seq: item.seq,
        versionId: item.value.head.version_id,
      })) throw new Error('announce: durable version gate refused card');
      const fresh = library.put(id, item);
      library.markInstalled(id, true); // our own app is installed by definition (we authored + seed it)
      // An explicit re-announce is also the retry path after a prior link
      // refusal. Re-send even when the local no-downgrade store is unchanged.
      const propagated = await propagateCommitted(id, item, null);
      return { dwapp_id: id, fresh, propagated };
    },
    // Subscribe to a peer's feed (default happens on connect; this is the manual
    // lever + the reconcile-already-linked path).
    subscribeTo,
    unsubscribeFrom,
    // Subscribe to every peer we're already linked to — the cold-start reconcile
    // (the base mesh is usually up long before discovery starts).
    subscribeAll() {
      if (closed || !autoSubscribe) return;
      for (const p of mesh.peers()) if (!unsubscribed.has(p.did)) subscribeTo(p.did).catch(() => {});
    },
    // The sovereign switch: "I don't want to see shit." Off → stop asking new
    // peers, and tell current upstreams to stop sending.
    /** @param {boolean} on */
    setEnabled(on) {
      if (closed) return;
      autoSubscribe = !!on;
      if (!on) {
        // Global pause must not turn every neighbor into an individual opt-out.
        const dids = [...upstreams.keys()];
        upstreams.clear();
        for (const did of dids) {
          mesh.sign(DISCOVERY.CH, DISCOVERY.UNSUB, {}).then((/** @type {any} */ env) => {
            if (!closed && !upstreams.has(did)) mesh.send(did, env);
          }).catch(() => {});
        }
      } else this.subscribeAll();
    },
    // Ban a peer: drop them from our feed, blocklist the did, purge their cards,
    // and cut the link. Unilateral, any reason.
    /** @param {string} did @param {string} [reason] */
    ban(did, reason = 'user') {
      upstreams.delete(did);
      subscribers.delete(did);
      block?.(did, reason);
      library.purgePublisher(did);
      mesh.removeLink?.(did);
      audit?.('discovery_peer_banned', { did, reason });
    },
    ingest,                                   // exposed for the host + tests
    // Un-share: drop the card from the Library AND tombstone its id so a peer's
    // cached copy can't re-infect us. The base network calls this from unshareApp.
    /** @param {string} id */
    tombstone(id) { tombstoned.add(id); library.remove(id); },
    /** @param {string} id */
    isTombstoned: (id) => tombstoned.has(id),
    subscriberCount: () => subscribers.size,
    enabled: () => autoSubscribe,
    rows: () => library.rows(),
    close() {
      closed = true;
      offEnvelope(); offPeer(); offGone();
      upstreams.clear(); subscribers.clear(); buckets.clear(); unsubscribed.clear();
    },
  });
};
