// @ts-check
// peerd-distributed/gossip/presence.js — liveness beacons over gossip.
//
// Presence is a heartbeat on a reserved topic: "I'm here, and here is my
// app-provided meta" (a display name, a cursor color — opaque to the
// platform, D-7). The tracker turns beacons into join/leave events with a
// timeout, which is all the commons HUD needs. why gossip and not mesh
// link-state: presence carries USER-visible meta and survives partial
// meshes (a peer two hops away is still "present"); the mesh's own
// peer/peerGone events are link-state, not room-state.

export const PRESENCE_TOPIC = '~presence';

// A just-forgotten peer is SUPPRESSED from re-add for this long. why: a fast
// onPeerGone (peer-node.js) forgets a dropped peer instantly, but that peer's
// LAST beacon, still flooding via a third member, lands a moment later and the
// subscription below would re-add it as a link-less ghost that lingers the full
// expireMs and then vanishes again (the "reappear briefly" flap). Swallowing
// re-adds for a short window kills that one stale in-flight beacon. Kept WELL
// under heartbeatMs so a GENUINE re-join (which beacons every heartbeat) is
// re-added by its next beacon — at most one heartbeat late, never lost.
const FORGET_SUPPRESS_MS = 3_000;

/**
 * @param {{
 *   gossip: any,
 *   selfDid: string,
 *   meta?: () => any,
 *   topic?: string,
 *   heartbeatMs?: number,
 *   expireMs?: number,
 *   now?: () => number,
 * }} opts
 */
export const createPresence = ({
  gossip,
  selfDid,
  meta = () => ({}),
  // The gossip topic the beacon rides. Defaults to the lobby's '~presence';
  // a room (sub-protocol) passes a namespaced topic so its membership is
  // scoped to that room while sharing the one base mesh (base-network.js).
  topic = PRESENCE_TOPIC,
  heartbeatMs = 10_000,
  expireMs = 25_000,   // match the mesh idle timeout — drop a gone peer from both layers together
  now = Date.now,
} = /** @type {{ gossip: any, selfDid: string }} */ ({})) => {
  /** @type {Map<string, { lastSeen: number, meta: any }>} */
  const here = new Map(); // did -> { lastSeen, meta }
  /** @type {Map<string, number>} */
  const forgotten = new Map(); // did -> suppress-until ts (anti-flap, above)
  /** @type {Set<(arg: { did: string, meta?: any }) => void>} */
  const joinCbs = new Set();
  /** @type {Set<(arg: { did: string }) => void>} */
  const leaveCbs = new Set();
  /** @type {ReturnType<typeof setInterval> | null} */
  let beat = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let sweepTimer = null;

  /**
   * @template T
   * @param {Set<(arg: T) => void>} set
   * @param {T} arg
   */
  const emit = (set, arg) => { for (const cb of [...set]) cb(arg); };

  const offSub = gossip.subscribe(topic, (/** @type {{ from: string, data: any }} */ { from, data }) => {
    if (from === selfDid) return;
    // A beacon inside the just-forgotten window is the stale in-flight frame of
    // a peer the mesh already told us is gone — drop it so it can't resurrect a
    // ghost. (Expired entry → fall through; the peer is genuinely back.)
    const until = forgotten.get(from);
    if (until !== undefined) {
      if (now() < until) return;
      forgotten.delete(from);
    }
    const known = here.has(from);
    here.set(from, { lastSeen: now(), meta: data?.meta ?? {} });
    if (!known) emit(joinCbs, { did: from, meta: data?.meta ?? {} });
  });

  const sweep = () => {
    const t = now();
    for (const [did, p] of [...here]) {
      if (t - p.lastSeen > expireMs) {
        here.delete(did);
        emit(leaveCbs, { did });
      }
    }
    // Prune expired suppressions so the map can't grow across long churn.
    for (const [did, until] of [...forgotten]) if (t >= until) forgotten.delete(did);
  };

  const beacon = () => gossip.publish(topic, { meta: meta() });

  return Object.freeze({
    start() {
      if (beat) return;
      beacon(); // announce immediately — joins should feel instant
      beat = setInterval(beacon, heartbeatMs);
      sweepTimer = setInterval(sweep, Math.max(1, Math.floor(expireMs / 3)));
    },
    stop() {
      if (beat) { clearInterval(beat); beat = null; }
      if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    },
    announce: beacon, // app changed its meta (renamed) — beacon now
    // Drop a peer NOW (don't wait for the beacon to expire) — used when the mesh
    // tells us the link died, so a disconnected peer leaves the view at once.
    // Arms a short suppression window (FORGET_SUPPRESS_MS) so the peer's last
    // in-flight beacon can't immediately resurrect it as a ghost; a genuine
    // re-join keeps beaconing and is re-added once the window passes.
    /** @param {string} did */
    forget: (did) => {
      forgotten.set(did, now() + FORGET_SUPPRESS_MS);
      if (here.delete(did)) emit(leaveCbs, { did });
    },
    list: () => [...here.entries()].map(([did, p]) => ({ did, ...p })),
    /** @param {(arg: { did: string, meta?: any }) => void} cb */
    onJoin: (cb) => { joinCbs.add(cb); return () => joinCbs.delete(cb); },
    /** @param {(arg: { did: string }) => void} cb */
    onLeave: (cb) => { leaveCbs.add(cb); return () => leaveCbs.delete(cb); },
    close() {
      offSub();
      // stop() inline — `this` is unreliable on a frozen destructured handle.
      if (beat) { clearInterval(beat); beat = null; }
      if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
      here.clear();
      forgotten.clear();
    },
  });
};
