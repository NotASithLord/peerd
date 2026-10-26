// @ts-check
// peerd-distributed/apps/discovery.js — the sovereign metadata subscription plane.
//
// Plane 1 of PROPAGATION.md, and the spine of the whole propagation model: a
// node NEVER receives discovery metadata it didn't ask for. There is no ambient
// flood. A peer SUBSCRIBES to a neighbor's discovery feed; the neighbor replies
// with paged SNAPSHOTs of the Library it's willing to share and fresh ITEMs.
// Either side can UNSUBSCRIBE ("stop") or ban
// the other (unilaterally, any reason). This makes spam-resistance STRUCTURAL —
// there is simply no edge over which to deliver unsolicited metadata.
//
// Wire model (mirrors gossip/sync.js's link-local carriers): frames ride a
// dedicated channel (ch=5) and are LINK-LOCAL — the carrier is signed by the
// neighbor itself (env.from === via), so the mesh's non-ch4 attribution rule
// accepts them. The INNER card is publisher-signed and verified independently
// (a neighbor can carry history, never fabricate it).
//
// Reach is transitive over CONSENTED edges: default feeds forward every fresh
// card, while opted-in bounded feeds pair rotated pushes with catalog repair.
// Retained catalogs converge over connected consenting links under bounded
// load; expiry, eviction and ongoing churn still limit coverage. Loops die
// on the Library's no-downgrade rule (a re-heard card is not "fresh", so it is
// not re-forwarded — the same role the gossip seen-cache plays).

import { verifyMeta, metaDwappId, metaWellFormed } from './meta.js';
import { createLocalCounters } from '../local-counters.js';
import { OUTGOING_LIMITS } from '../transport/outgoing.js';

export const DISCOVERY = Object.freeze({ CH: 5, SUB: 0, SNAPSHOT: 1, ITEM: 2, UNSUB: 3 });
// why: only explicitly negotiated discovery feeds may omit an immediate push.
// Live gossip is a separate protocol; periodic catalog repair still visits all
// consenting links. Keep rollout opt-in rather than changing the public mesh.
export const DISCOVERY_BOUNDED_PROFILE = 'bounded-push-v1';
export const DISCOVERY_PUSH_FANOUT = 6;

// Reasoned defaults (PROPAGATION.md caps table) — validate under load.
const DEFAULTS = Object.freeze({
  relayPerMin: 60,    // distinct new cards accepted from one peer per minute
  snapshotMax: 200,   // cards per page, not the total catalog
  snapshotsPerMin: 6, // bound page generation and parsing even for duplicates
});

/**
 * @param {{
 *   mesh: any,
 *   identity: { did: string },
 *   library: ReturnType<typeof import('./library.js').createLibrary>,
 *   isBlocked?: (did: string) => boolean,
 *   isEnabled?: () => boolean,
 *   disseminationProfile?: typeof DISCOVERY_BOUNDED_PROFILE | null,
 *   block?: ((did: string, reason?: string) => void) | null,
 *   audit?: ((type: string, detail?: any) => void) | null,
 *   now?: () => number,
 *   caps?: { relayPerMin?: number, snapshotMax?: number, snapshotsPerMin?: number },
 *   onCard?: ((card: any) => void) | null,
 *   admitMeta?: ((candidate: { dwappId: string, publisher: string, seq: number, versionId: string }) => Promise<boolean>) | null,
 * }} opts
 */
export const createDiscovery = ({
  mesh, identity, library, isBlocked = () => false, block = null, audit = null, now = Date.now, caps = {}, onCard = null,
  admitMeta = null, isEnabled = () => true,
  disseminationProfile = null,
} = /** @type {{ mesh: any, identity: { did: string }, library: any }} */ ({})) => {
  if (disseminationProfile !== null && disseminationProfile !== DISCOVERY_BOUNDED_PROFILE) {
    throw new Error('unsupported discovery dissemination profile');
  }
  // Frames and known-version claims are work counters; only fresh counts newly
  // verified, committed metadata. Destinations count attempted live forwarding.
  const counts = createLocalCounters(['originals', 'fresh', 'known', 'invalid', 'rateLimited',
    'forwardCalls', 'destinations', 'maxDestinations', 'snapshotRequestsReceived', 'snapshotFramesReceived',
    'subscriptionsSent', 'reconcileCalls', 'boundedDestinations', 'legacyDestinations',
    'omittedPushes', 'maxBoundedDestinations']);
  const relayPerMin = caps.relayPerMin ?? DEFAULTS.relayPerMin;
  const snapshotMax = caps.snapshotMax ?? DEFAULTS.snapshotMax;
  const snapshotsPerMin = caps.snapshotsPerMin ?? DEFAULTS.snapshotsPerMin;
  /** @type {Map<string, string>} */
  const cursors = new Map();
  /** @type {Map<string, {id:string, after:string, limit:number, sentAt:number}>} */
  const requests = new Map();
  /** @type {Map<string, { reconcile?: boolean }>} */
  const processing = new Map();
  /** @type {Map<string, {start:number, sent:number, received:number}>} */
  const snapshotWindows = new Map();
  let requestId = 0;

  /** @param {string} did @param {'sent'|'received'} direction */
  const allowSnapshot = (did, direction) => {
    const t = now();
    let window = snapshotWindows.get(did);
    if (!window || t - window.start >= 60_000) {
      window = { start: t, sent: 0, received: 0 }; snapshotWindows.set(did, window);
    }
    if (window[direction] >= snapshotsPerMin) return false;
    window[direction] += 1;
    return true;
  };
  /** @param {string} did */
  const forgetPages = (did) => {
    cursors.delete(did); requests.delete(did); processing.delete(did); snapshotWindows.delete(did);
  };

  /** @type {Map<string, { bounded: boolean }>} */
  const subscribers = new Map();    // exact subscription generations we serve
  let pushCursor = 0;
  // Object identity fences asynchronous verification/signing against an
  // unsubscribe followed by a new subscription to the same peer.
  /** @type {Map<string, { bounded?: boolean }>} */
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
  const receiving = (did, subscription) => !closed && autoSubscribe && isEnabled()
    && !!subscription && upstreams.get(did) === subscription && !isBlocked(did);

  /** @param {string} did */
  const allow = (did) => {
    const t = now();
    let b = buckets.get(did);
    if (!b || t - b.windowStart >= 60_000) { b = { count: 0, windowStart: t }; buckets.set(did, b); }
    if (b.count >= relayPerMin) return false;
    b.count += 1;
    return true;
  };

  // Legacy feeds retain full push. Negotiated feeds rotate a bounded immediate
  // subset; omitted cards remain available through all-neighbor paged repair.
  /** @param {any} item @param {string | null} [exceptVia] */
  const forward = async (item, exceptVia = null) => {
    if (subscribers.size === 0) return true;
    const candidates = [...subscribers].filter(([did]) => !closed && !isBlocked(did) && did !== exceptVia);
    const legacy = candidates.filter(([, subscription]) => !subscription.bounded);
    const bounded = candidates.filter(([, subscription]) => subscription.bounded);
    // why: rotation avoids permanent winners and is independent of routing
    // degree, publisher identity and remote self-reported contribution.
    const selected = bounded.length ? Array.from({ length: Math.min(DISCOVERY_PUSH_FANOUT, bounded.length) },
      (_, offset) => bounded[(pushCursor + offset) % bounded.length]) : [];
    if (bounded.length) pushCursor = (pushCursor + selected.length) % bounded.length;
    const env = await mesh.sign(DISCOVERY.CH, DISCOVERY.ITEM, { item });
    // Subscriber membership is bounded by live mesh links. Launch separately
    // so one stalled link cannot hold every healthy subscriber behind it.
    // why: a late signature cannot deliver work from an old subscription to a
    // replacement link or a peer that changed its requested feed profile.
    const destinations = [...legacy, ...selected].filter(([did, subscription]) =>
      !closed && !isBlocked(did) && subscribers.get(did) === subscription);
    const boundedCount = destinations.filter(([, subscription]) => subscription.bounded).length;
    counts.add('forwardCalls'); counts.add('destinations', destinations.length);
    counts.max('maxDestinations', destinations.length);
    counts.add('boundedDestinations', boundedCount);
    counts.add('legacyDestinations', destinations.length - boundedCount);
    counts.add('omittedPushes', bounded.length - selected.length);
    counts.max('maxBoundedDestinations', boundedCount);
    const results = await Promise.all(destinations.map(([did]) => mesh.send(did, env)));
    return results.every(Boolean);
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
  /** @param {any} item @param {string | null} [via] @param {object | undefined} [subscription]
   * @param {()=>void} [onRateLimited] */
  const ingest = async (item, via = null, subscription = via ? upstreams.get(via) : undefined,
    onRateLimited = () => {}) => {
    const current = () => !closed && (via === null || receiving(via, subscription));
    if (!current()) return false;
    if (!metaWellFormed(item)) { counts.add('invalid'); return false; }
    const id = await metaDwappId(item);
    if (!current()) return false;
    // A known version cannot change local state. Drop it before spending the
    // new-card budget or verifying its signature, so repeated snapshots leave
    // room for the unseen tail. Unverified claims can only discard themselves.
    const known = library.get(id);
    if (known && item.seq <= known.seq) { counts.add('known'); return false; }
    if (via !== null && !allow(via)) {
      counts.add('rateLimited');
      onRateLimited();
      audit?.('discovery_rate_limited', { did: via });
      return false;
    }
    if (!(await verifyMeta(item))) { counts.add('invalid'); audit?.('discovery_card_invalid', { via }); return false; }
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
    if (fresh) { counts.add('fresh'); await propagateCommitted(id, item, via); }
    return fresh;
  };

  /** @param {any} request */
  const pagedRequest = (request) => request?.catalog === 1
      && typeof request.id === 'string' && request.id.length > 0 && request.id.length <= 64
      && typeof request.after === 'string' && /^(|[a-f0-9]{64})$/.test(request.after)
      && Number.isInteger(request.limit) && request.limit > 0;
  /** @param {string} did @param {any} request @param {{ bounded: boolean }} subscription */
  const sendSnapshot = async (did, request, subscription) => {
    if (!allowSnapshot(did, 'sent')) return;
    const paged = pagedRequest(request);
    let limit = paged ? Math.min(snapshotMax, request.limit) : snapshotMax;
    const current = () => !closed && subscribers.get(did) === subscription && !isBlocked(did);
    const frameLimit = () => Math.min(OUTGOING_LIMITS.frameBytes, OUTGOING_LIMITS.nativeBytes,
      mesh.peers().find((/** @type {any} */ peer) => peer.did === did)?.channel?.maxFrameBytes?.() ?? Infinity);
    // why: valid metadata can still exceed negotiated SCTP when packed by
    // count alone. Recompute the cursor from each smaller page so no omitted
    // cards are acknowledged. Measure the complete signed UTF-8 wire frame.
    while (current()) {
      const page = paged ? library.page(request.after, limit) : null;
      const items = page?.items ?? library.list().slice(0, limit);
      const env = await mesh.sign(DISCOVERY.CH, DISCOVERY.SNAPSHOT, {
        items,
        ...(page ? { page: { id: request.id, after: request.after, next: page.next,
          ...(subscription.bounded ? { dissemination: DISCOVERY_BOUNDED_PROFILE } : {}),
        } } : {}),
      });
      if (!current()) return;
      if (new TextEncoder().encode(JSON.stringify(env)).byteLength <= frameLimit()) {
        await mesh.send(did, env);
        return;
      }
      // Each retry strictly shrinks the candidate. An unrepresentable single
      // card must not be skipped or sent into the transport's link-failure path.
      if (items.length < 2) {
        audit?.('discovery_snapshot_frame_too_large', { did });
        return;
      }
      limit = Math.ceil(items.length / 2);
    }
  };

  const offEnvelope = mesh.onEnvelope(async (/** @type {{ env: any, via: string }} */ { env, via }) => {
    if (closed || env.ch !== DISCOVERY.CH) return;
    if (env.from !== via) return; // link-local: the carrier MUST be the neighbor
    switch (env.typ) {
      case DISCOVERY.SUB: {
        if (isBlocked(via)) return;
        counts.add('snapshotRequestsReceived');
        // why: the signed, link-local request is consent to this feed mode;
        // unknown profiles and non-paged legacy requests never authorize loss
        // of an immediate push, even when the local profile is enabled.
        const bounded = disseminationProfile === DISCOVERY_BOUNDED_PROFILE
          && pagedRequest(env.body) && env.body.dissemination === DISCOVERY_BOUNDED_PROFILE;
        const previous = subscribers.get(via);
        const subscription = previous?.bounded === bounded ? previous : { bounded };
        subscribers.set(via, subscription);
        audit?.('discovery_subscriber_added', { did: via });
        await sendSnapshot(via, env.body, subscription);
        return;
      }
      case DISCOVERY.UNSUB:
        subscribers.delete(via);
        return;
      case DISCOVERY.SNAPSHOT: {
        const subscription = upstreams.get(via);
        if (!receiving(via, subscription) || processing.has(via)) return;
        const request = requests.get(via);
        const page = env.body?.page;
        const paged = page !== undefined;
        if (paged && (!page || typeof page !== 'object' || !request || page.id !== request.id || page.after !== request.after
          || !(page.next === null || typeof page.next === 'string'
            && /^[a-f0-9]{64}$/.test(page.next) && page.next > request.after))) return;
        if (!allowSnapshot(via, 'received')) return;
        counts.add('snapshotFramesReceived');
        /** @type {{ reconcile?: boolean }} */
        const token = {};
        processing.set(via, token);
        let rateLimited = false;
        try {
          const limit = paged ? Math.min(snapshotMax, request?.limit ?? 0) : snapshotMax;
          const rawItems = env.body?.items;
          // A cursor acknowledges a complete ordered page. Never silently trim
          // a malformed response and then skip its unprocessed tail.
          if (paged && (!Array.isArray(rawItems) || rawItems.length > limit)) return;
          const items = Array.isArray(rawItems) ? rawItems.slice(0, limit) : [];
          if (paged) {
            let last = request?.after ?? '';
            for (const item of items) {
              if (!metaWellFormed(item)) return;
              const id = await metaDwappId(item);
              if (id <= last) return;
              last = id;
            }
            if (page.next !== null && (!items.length || page.next !== last)) return;
          }
          for (const it of items) {
            if (!receiving(via, subscription)) return;
            await ingest(it, via, subscription, () => { rateLimited = true; });
          }
          // Never advance past a page whose tail lost a race to live-card quota.
          // Retrying the same page is cheap because known versions are skipped.
          if (page && !rateLimited && receiving(via, subscription)) {
            cursors.set(via, page.next ?? '');
            if (subscription) subscription.bounded = disseminationProfile === DISCOVERY_BOUNDED_PROFILE
              && page.dissemination === DISCOVERY_BOUNDED_PROFILE;
          }
        } finally {
          if (processing.get(via) === token) {
            processing.delete(via);
            if (requests.get(via) === request) requests.delete(via);
            // why: a visible card can precede its final forwarding signature.
            // Coalesce reconciliation during that tail without losing intent or
            // letting a retired subscription restart work. Quotas still apply.
            if (token.reconcile && receiving(via, subscription) && !unsubscribed.has(via)) {
              subscribeTo(via).catch(() => {});
            }
          }
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
    forgetPages(did);
  }) ?? (() => {});

  /** @param {string} did */
  async function subscribeTo(did) {
    if (closed || !autoSubscribe || !isEnabled() || isBlocked(did)) return false;
    unsubscribed.delete(did);
    const pending = processing.get(did);
    if (pending) { pending.reconcile = true; return false; }
    const outstanding = requests.get(did);
    if (outstanding && now() - outstanding.sentAt < 12_000) return false;
    const bucket = buckets.get(did);
    const remaining = !bucket || now() - bucket.windowStart >= 60_000
      ? relayPerMin : Math.max(0, relayPerMin - bucket.count);
    if (remaining < 1) return false;
    const request = { id: String(++requestId), after: cursors.get(did) ?? '',
      limit: Math.min(snapshotMax, remaining), sentAt: now() };
    requests.set(did, request);
    const previous = upstreams.get(did);
    const subscription = previous ?? {};
    upstreams.set(did, subscription);
    try {
      const env = await mesh.sign(DISCOVERY.CH, DISCOVERY.SUB, { catalog: 1, ...request,
        ...(disseminationProfile ? { dissemination: disseminationProfile } : {}),
      });
      if (!receiving(did, subscription) || requests.get(did) !== request) return false;
      const sent = await mesh.send(did, env);
      if (sent) counts.add('subscriptionsSent');
      if (!sent) {
        if (!previous && upstreams.get(did) === subscription) upstreams.delete(did);
        if (requests.get(did) === request) requests.delete(did);
      }
      return sent;
    } catch (error) {
      if (requests.get(did) === request) requests.delete(did);
      if (!previous && upstreams.get(did) === subscription) upstreams.delete(did);
      throw error;
    }
  }
  /** @param {string} did */
  async function unsubscribeFrom(did) {
    upstreams.delete(did);
    forgetPages(did);
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
      counts.add('originals');
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
      if (closed || !autoSubscribe || !isEnabled()) return;
      counts.add('reconcileCalls');
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
        cursors.clear(); requests.clear(); processing.clear(); snapshotWindows.clear();
        for (const did of dids) {
          mesh.sign(DISCOVERY.CH, DISCOVERY.UNSUB, {}).then((/** @type {any} */ env) => {
            if (!closed && !upstreams.has(did)) return mesh.send(did, env);
          }).catch(() => {});
        }
      } else this.subscribeAll();
    },
    // Ban a peer: drop them from our feed, blocklist the did, purge their cards,
    // and cut the link. Unilateral, any reason.
    /** @param {string} did @param {string} [reason] */
    ban(did, reason = 'user') {
      upstreams.delete(did);
      forgetPages(did);
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
    stats: () => ({ ...counts.snapshot(), subscribers: subscribers.size, upstreams: upstreams.size,
      disseminationProfile,
      boundedSubscribers: [...subscribers.values()].filter((subscription) => subscription.bounded).length,
      boundedUpstreams: [...upstreams.values()].filter((subscription) => subscription.bounded).length,
    }),
    enabled: () => autoSubscribe && isEnabled(),
    rows: () => library.rows(),
    close() {
      closed = true;
      offEnvelope(); offPeer(); offGone();
      upstreams.clear(); subscribers.clear(); buckets.clear(); unsubscribed.clear();
      cursors.clear(); requests.clear(); processing.clear(); snapshotWindows.clear();
    },
  });
};
