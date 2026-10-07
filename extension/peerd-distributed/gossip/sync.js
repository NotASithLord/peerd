// @ts-check
// peerd-distributed/gossip/sync.js — late-join backfill for retained topics.
//
// A feed with no home server still has history: whoever is in the room
// holds it. When two members link up, EACH asks the other "what do you
// have on topic T that I don't?" (have-list of envelope sigs → the
// missing original signed envelopes back). Symmetric by construction —
// mesh.onPeer fires on both sides — so a rejoining peer's offline
// publishes flow forward exactly like a newcomer's gap flows back.
//
// DEMO-SCALE, AND SAYS SO: the have-list is a flat sig array and the
// response is a flat envelope array, both capped below. That is the right
// amount of protocol for hundreds of posts among ≤16 peers. Set
// reconciliation (range hashes, IBLTs) is a Phase 2+ upgrade with its own
// measurements — do not grow this file into it speculatively.
//
// Those two caps bound the COUNT per exchange; the per-envelope BYTE cap
// (MAX_GOSSIP_ENVELOPE_BYTES, gossip/topic.js) bounds the other axis —
// without it a peer's oversized retained topic is re-served through us to
// everyone who syncs, turning this peer into a bandwidth amplifier.
//
// Authenticity: the carrier frames are link-local (their `from` must be
// the neighbor itself), and every INNER envelope in a response is
// signature-verified before ingest — a member can serve history, but
// cannot fabricate it. Delivery goes through gossip.ingest(): same seen/
// mute discipline as the live flood, and never re-broadcast (backfill is
// point-to-point; peers that want it ask for it).

import { envelopeBytes, verifyEnvelope } from '../transport/envelope.js';
import { MAX_GOSSIP_ENVELOPE_BYTES } from './topic.js';
import { createSyncWork } from './sync-work.js';

export const SYNC = Object.freeze({ REQ: 2, RESP: 3 }); // ch=4 typs

// why these caps: a have-list past 512 or a response past 256 envelopes
// means the room outgrew flat-list sync — fail visibly toward the Phase 2
// upgrade instead of silently truncating forever (the audit names it).
const MAX_HAVES = 512;
const MAX_RESP = 256;

// The in-memory store. Same surface an IDB-backed store implements in the
// host (bridge); injected per the functional-core rule.
export const createMemoryTopicStore = () => {
  /** @type {Map<string, Map<string, any>>} */
  const topics = new Map(); // topic -> Map<sig, env>
  /** @param {string} t */
  const bucket = (t) => {
    let m = topics.get(t);
    if (!m) { m = new Map(); topics.set(t, m); }
    return m;
  };
  return {
    /** @param {string} topic @param {any} env */
    put: (topic, env) => { bucket(topic).set(env.sig, env); },
    /** @param {string} topic @param {string} sig */
    has: (topic, sig) => bucket(topic).has(sig),
    /** @param {string} topic */
    ids: (topic) => [...bucket(topic).keys()],
    /** @param {string} topic */
    list: (topic) => [...bucket(topic).values()],
  };
};

/**
 * @param {{
 *   mesh: any,
 *   gossip: any,
 *   store: { put: (t: string, env: any) => void, has: (t: string, sig: string) => boolean, ids: (t: string) => string[], list: (t: string) => any[] },
 *   maxEnvelopeBytes?: number,
 *   verify?: (env: unknown) => Promise<boolean>,
 *   audit?: ((type: string, detail?: any) => void) | null,
 * }} opts
 */
export const createTopicSync = ({
  mesh,
  gossip,
  store,
  maxEnvelopeBytes = MAX_GOSSIP_ENVELOPE_BYTES,
  verify = verifyEnvelope,
  audit = null,
} = /** @type {{ mesh: any, gossip: any, store: any }} */ ({})) => {
  /** @type {Set<string>} */
  const retained = new Set(); // topics this peer keeps + serves history for
  const work = createSyncWork();
  // why: gossip subscribers run before its retention taps. During our own
  // ingest, postpone retention until those callbacks finish and custody is
  // rechecked; a subscriber may retire the carrier or mute the author.
  const ingesting = new WeakSet();
  let closed = false;
  /** @param {string} did */
  const channelFor = (did) => mesh.peers().find((/** @type {{ did: string }} */ peer) => peer.did === did)?.channel;
  /** @param {string} did @param {object} channel */
  const live = (did, channel) => !closed && channelFor(did) === channel;
  const offGone = mesh.onPeerGone?.(() => work.retire()) ?? (() => {});
  // why: only original PUB envelopes for this exact retained topic are history.
  // A valid signature alone does not bind an inner frame to its sync carrier.
  /** @param {any} inner @param {string} topic */
  const scopedPublish = (inner, topic) => inner?.v === 1 && inner.ch === 4
    && inner.typ === 0 && inner.body?.topic === topic;

  // why the store gets its OWN check rather than trusting the flooder's: a
  // retained envelope outlives the frame that carried it — we re-serve it to
  // every peer that syncs, on every new link, which is exactly the
  // amplification. This is the only layer that WRITES that history, so it
  // owns the gate on what gets in, and every retain path below runs through
  // it (the live tap, the backfill ingest, and the seen-but-unretained
  // fallback — plus our own publish, which must not ask the room to carry
  // what the room would refuse).
  /** @param {string} topic @param {any} env */
  const admissible = (topic, env) => {
    const bytes = envelopeBytes(env);
    if (bytes <= maxEnvelopeBytes) return true;
    audit?.('sync_env_oversized', { topic, bytes, cap: maxEnvelopeBytes });
    return false;
  };

  /** @param {string} topic @param {any} env */
  const keep = (topic, env) => {
    if (!ingesting.has(env) && retained.has(topic) && admissible(topic, env)) store.put(topic, env);
  };

  // Live publishes on retained topics get stored as they're delivered.
  const offTap = gossip.tap((/** @type {{ env: any }} */ msg, /** @type {string} */ topic) => keep(topic, msg.env));

  /** @param {string} did @param {string} topic */
  const requestFrom = async (did, topic) => {
    const channel = channelFor(did);
    if (!channel || closed) return;
    const haves = store.ids(topic);
    if (haves.length > MAX_HAVES) audit?.('sync_haves_overflow', { topic, count: haves.length });
    const env = await mesh.sign(4, SYNC.REQ, { topic, haves: haves.slice(-MAX_HAVES) });
    if (live(did, channel)) await mesh.send(did, env);
  };

  const offEnvelope = mesh.onEnvelope(async (/** @type {{ env: any, via: any }} */ { env, via }) => {
    if (closed || env.v !== 1 || env.ch !== 4 || env.from !== via) return;
    if (env.typ !== SYNC.REQ && env.typ !== SYNC.RESP) return;
    const { topic, haves, envs } = env.body ?? {};
    if (typeof topic !== 'string' || !retained.has(topic)) return;
    // Validate count and shape before allocating a Set, scanning history, or
    // starting inner crypto. Sender-side slicing is not an inbound limit.
    if (env.typ === SYNC.REQ) {
      if (!Array.isArray(haves) || haves.length > MAX_HAVES
        || haves.some((sig) => typeof sig !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(sig))) {
        audit?.('sync_request_invalid', { via }); return;
      }
    } else if (!Array.isArray(envs) || envs.length > MAX_RESP
      || envs.some((inner) => !scopedPublish(inner, topic))) {
      audit?.('sync_response_invalid', { via }); return;
    }
    const channel = channelFor(via);
    if (!channel) return;
    const current = () => live(via, channel);
    const process = async () => {
      if (env.typ === SYNC.REQ) {
        const known = new Set(haves);
        const missing = store.list(topic).filter((inner) => scopedPublish(inner, topic) && !known.has(inner.sig));
        if (missing.length > MAX_RESP) audit?.('sync_resp_overflow', { topic, count: missing.length });
        const resp = await mesh.sign(4, SYNC.RESP, { topic, envs: missing.slice(0, MAX_RESP) });
        if (current()) await mesh.send(via, resp);
        return;
      }
      for (const inner of envs) {
        if (!current()) return;
        if (!admissible(topic, inner)) continue;
        const valid = await verify(inner);
        if (!current()) return;
        if (!valid) {
          audit?.('sync_env_invalid', { topic, via }); continue;
        }
        if (gossip.isMuted(inner.from)) continue;
        const nested = ingesting.has(inner);
        ingesting.add(inner);
        let fresh;
        try { fresh = gossip.ingest(inner, via); }
        finally { if (!nested) ingesting.delete(inner); }
        if (!current()) return;
        if (gossip.isMuted(inner.from)) continue;
        if (fresh) keep(topic, inner);
        // A matching, authenticated PUB may already be seen through flooding
        // before this topic was retained. Only that case reaches this fallback.
        else if (!store.has(topic, inner.sig)) store.put(topic, inner);
      }
    };
    const done = work.run(channel, current, async () => {
      try { await process(); }
      catch { audit?.('sync_work_failed', { via }); }
    });
    if (!done) audit?.('sync_work_overloaded', { via });
    else await done;
  });

  // A new link is the sync moment — both sides do this, so history flows
  // in whichever direction has the gap.
  const offPeer = mesh.onPeer((/** @type {{ did: string }} */ { did }) => {
    for (const topic of retained) requestFrom(did, topic).catch(() => {});
  });

  return Object.freeze({
    // Mark a topic as retained: stored locally, served to the room, and
    // backfilled from the room. onPeer (above) covers FUTURE links, but the
    // mesh is usually already connected by the time a dwapp retains a topic
    // (the base net links on unlock, long before the app opens) — so reconcile
    // against the peers we're ALREADY linked to too, or a late joiner's history
    // stays empty. requestFrom is a cheap, idempotent have-list exchange.
    /** @param {string} topic */
    retain(topic) {
      if (closed) return;
      retained.add(topic);
      for (const p of mesh.peers()) requestFrom(p.did, topic).catch(() => {});
    },
    // Publish-and-retain in one move (feeds want this; ephemeral topics
    // use gossip.publish directly and are never stored).
    /** @param {string} topic @param {any} data */
    async publish(topic, data) {
      if (closed) throw new Error('topic sync closed');
      retained.add(topic);
      const env = await gossip.publish(topic, data);
      if (!closed) keep(topic, env);
      return env;
    },
    /** @param {string} topic */
    history: (topic) => store.list(topic),
    requestFrom,
    close() { closed = true; work.close(); offTap(); offEnvelope(); offPeer(); offGone(); retained.clear(); },
  });
};
