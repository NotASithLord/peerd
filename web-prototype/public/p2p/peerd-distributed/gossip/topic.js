// peerd-distributed/gossip/topic.js — room-scoped topic broadcast (ch=4).
//
// The deliberately dumb flooder (NORTH-STAR §6: ~200 lines, not a
// GossipSub port). publish() signs one envelope and hands it to every
// link; each receiver delivers it once (seen-cache) and re-broadcasts it
// untouched to everyone except where it came from. At room scale
// (ROOM_CAP=16) that's O(N²) small messages per publish — measurable,
// bounded, and not worth a smarter mesh yet. Episub-style refinements
// earn their way in with measurements if rooms ever grow.
//
// Invariants:
//   - PAYLOADS ARE OPAQUE (D-7). This file never interprets `data` — a
//     CRDT update, a post, a cursor: all the same bytes to gossip.
//   - Envelopes are immutable in flight: re-broadcast forwards the SAME
//     signed frame. why no hop counter: a mutable hop field inside a
//     signed body is unverifiable; the seen-cache IS the loop guard, and
//     the room cap bounds amplification.
//   - Dedup keys on the SIGNATURE: unforgeable, so a flooder can't
//     pre-poison the cache against an honest frame (an id-keyed cache
//     could be front-run with a fake frame bearing the victim's id).
//   - Per-sender token bucket + per-did mute are the D-9 spam boundary.
//     The room is consent; the bucket is the ceiling on what consent buys.

const PUB = 0; // ch=4 typ — a topic publish

/**
 * @param {{
 *   mesh: any,
 *   now?: () => number,
 *   seenCap?: number,
 *   ratePerSec?: number,
 *   rateBurst?: number,
 *   audit?: ((type: string, detail?: any) => void) | null,
 * }} opts
 */
export const createGossip = ({
  mesh,
  now = Date.now,
  seenCap = 4096,
  // ~20 msgs/s sustained per sender, bursts to 40 — generous for a doc's
  // CRDT updates + cursors, tight enough that one peer can't bury a room.
  ratePerSec = 20,
  rateBurst = 40,
  audit = null,
} = {}) => {
  const subs = new Map(); // topic -> Set<cb>
  const seen = new Set(); // envelope sigs, insertion-ordered (LRU by eviction)
  const buckets = new Map(); // did -> { tokens, last }
  const muted = new Set(); // did
  const taps = new Set(); // every delivered env (the sync layer listens here)

  const markSeen = (sig) => {
    seen.add(sig);
    if (seen.size > seenCap) {
      // Evict oldest — Sets iterate in insertion order.
      const first = seen.values().next().value;
      seen.delete(first);
    }
  };

  const allow = (did) => {
    const t = now();
    let b = buckets.get(did);
    if (!b) {
      b = { tokens: rateBurst, last: t };
      buckets.set(did, b);
    }
    b.tokens = Math.min(rateBurst, b.tokens + ((t - b.last) / 1000) * ratePerSec);
    b.last = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };

  const deliver = (env, via) => {
    const { topic, data } = env.body;
    const msg = { from: env.from, data, ts: env.ts, id: env.id, env, via };
    for (const cb of [...(subs.get(topic) ?? [])]) cb(msg);
    for (const cb of [...taps]) cb(msg, topic);
  };

  const offEnvelope = mesh.onEnvelope(({ env, via }) => {
    if (env.ch !== 4 || env.typ !== PUB) return;
    if (!env.body || typeof env.body.topic !== 'string') return;
    if (seen.has(env.sig)) return; // duplicate via another path
    markSeen(env.sig);
    if (muted.has(env.from)) return; // user said no — drop silently, no relay
    if (!allow(env.from)) {
      audit?.('gossip_rate_limited', { did: env.from, topic: env.body.topic });
      return; // dropped AND not re-broadcast: a flood dies at first hop
    }
    deliver(env, via);
    // Forward the same signed frame onward — everyone but where it came from.
    mesh.broadcast(env, via);
  });

  return Object.freeze({
    async publish(topic, data) {
      const env = await mesh.sign(4, PUB, { topic, data });
      markSeen(env.sig); // our own frame must not boomerang back to us
      mesh.broadcast(env);
      return env;
    },
    subscribe(topic, cb) {
      if (!subs.has(topic)) subs.set(topic, new Set());
      subs.get(topic).add(cb);
      return () => subs.get(topic)?.delete(cb);
    },
    // The sync layer's firehose: every delivered publish, any topic.
    tap(cb) {
      taps.add(cb);
      return () => taps.delete(cb);
    },
    // Re-deliver an envelope that arrived OUTSIDE the live flood (backfill
    // sync). Never re-broadcast — backfill is point-to-point (gossip/sync.js).
    //
    // why deliver even when already `seen`: on the SHARED base mesh a peer
    // flood-relays every room's messages, including rooms it hasn't joined — so
    // a topic's frame is often marked seen (for loop-prevention) while no local
    // subscriber existed to receive it. Backfill is exactly how a now-subscribed
    // topic recovers those, so a seen frame must still DELIVER here; it just
    // won't re-mark or re-flood. (A live-delivered retained frame is already in
    // the store, so the have-list keeps it from being re-served — no double
    // delivery in practice; apps id-dedup regardless.) Returns whether the frame
    // was newly seen, so sync.js stores fresh-vs-backfilled correctly.
    ingest(env, via = null) {
      if (env.ch !== 4 || env.typ !== PUB) return false;
      if (!env.body || typeof env.body.topic !== 'string') return false;
      if (muted.has(env.from)) return false;
      const fresh = !seen.has(env.sig);
      if (fresh) markSeen(env.sig);
      deliver(env, via);
      return fresh;
    },
    hasSeen: (sig) => seen.has(sig),
    mute(did) { muted.add(did); audit?.('gossip_muted', { did }); },
    unmute(did) { muted.delete(did); },
    isMuted: (did) => muted.has(did),
    close() { offEnvelope(); subs.clear(); taps.clear(); },
  });
};
