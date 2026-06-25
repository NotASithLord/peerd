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
// Authenticity: the carrier frames are link-local (their `from` must be
// the neighbor itself), and every INNER envelope in a response is
// signature-verified before ingest — a member can serve history, but
// cannot fabricate it. Delivery goes through gossip.ingest(): same seen/
// mute discipline as the live flood, and never re-broadcast (backfill is
// point-to-point; peers that want it ask for it).

import { verifyEnvelope } from '../transport/envelope.js';

export const SYNC = Object.freeze({ REQ: 2, RESP: 3 }); // ch=4 typs

// why these caps: a have-list past 512 or a response past 256 envelopes
// means the room outgrew flat-list sync — fail visibly toward the Phase 2
// upgrade instead of silently truncating forever (the audit names it).
const MAX_HAVES = 512;
const MAX_RESP = 256;

// The in-memory store. Same surface an IDB-backed store implements in the
// host (bridge); injected per the functional-core rule.
export const createMemoryTopicStore = () => {
  const topics = new Map(); // topic -> Map<sig, env>
  const bucket = (t) => {
    if (!topics.has(t)) topics.set(t, new Map());
    return topics.get(t);
  };
  return {
    put: (topic, env) => { bucket(topic).set(env.sig, env); },
    has: (topic, sig) => bucket(topic).has(sig),
    ids: (topic) => [...bucket(topic).keys()],
    list: (topic) => [...bucket(topic).values()],
  };
};

/**
 * @param {{
 *   mesh: any,
 *   gossip: any,
 *   store: { put: (t: string, env: any) => void, has: (t: string, sig: string) => boolean, ids: (t: string) => string[], list: (t: string) => any[] },
 *   audit?: ((type: string, detail?: any) => void) | null,
 * }} opts
 */
export const createTopicSync = ({ mesh, gossip, store, audit = null } = {}) => {
  const retained = new Set(); // topics this peer keeps + serves history for

  const keep = (topic, env) => {
    if (retained.has(topic)) store.put(topic, env);
  };

  // Live publishes on retained topics get stored as they're delivered.
  const offTap = gossip.tap((msg, topic) => keep(topic, msg.env));

  const requestFrom = async (did, topic) => {
    const haves = store.ids(topic);
    if (haves.length > MAX_HAVES) audit?.('sync_haves_overflow', { topic, count: haves.length });
    const env = await mesh.sign(4, SYNC.REQ, { topic, haves: haves.slice(-MAX_HAVES) });
    mesh.send(did, env);
  };

  const offEnvelope = mesh.onEnvelope(async ({ env, via }) => {
    if (env.ch !== 4) return;
    // Sync frames are link-local: the neighbor itself must have signed
    // them (the ch=4 flood exemption in the mesh doesn't apply here).
    if (env.from !== via) return;

    if (env.typ === SYNC.REQ) {
      const { topic, haves } = env.body ?? {};
      if (typeof topic !== 'string' || !retained.has(topic)) return;
      const known = new Set(Array.isArray(haves) ? haves : []);
      const missing = store.list(topic).filter((e) => !known.has(e.sig));
      if (missing.length > MAX_RESP) audit?.('sync_resp_overflow', { topic, count: missing.length });
      const resp = await mesh.sign(4, SYNC.RESP, { topic, envs: missing.slice(0, MAX_RESP) });
      mesh.send(via, resp);
      return;
    }

    if (env.typ === SYNC.RESP) {
      const { topic, envs } = env.body ?? {};
      if (typeof topic !== 'string' || !retained.has(topic) || !Array.isArray(envs)) return;
      for (const inner of envs) {
        // The neighbor relayed it; only the ORIGINAL signature makes it real.
        if (!(await verifyEnvelope(inner))) {
          audit?.('sync_env_invalid', { topic, via });
          continue;
        }
        if (gossip.ingest(inner, via)) keep(topic, inner);
        // ingest() returns false for BOTH "already seen" and "muted". The
        // fallback below stores a seen-live-but-not-yet-retained envelope —
        // but it must NOT store (and thereby re-serve) a MUTED sender's
        // history, or mute leaks back into the room through backfill (D-9).
        else if (!store.has(topic, inner.sig) && !gossip.isMuted(inner.from)) store.put(topic, inner);
      }
    }
  });

  // A new link is the sync moment — both sides do this, so history flows
  // in whichever direction has the gap.
  const offPeer = mesh.onPeer(({ did }) => {
    for (const topic of retained) requestFrom(did, topic);
  });

  return Object.freeze({
    // Mark a topic as retained: stored locally, served to the room, and
    // backfilled from the room. onPeer (above) covers FUTURE links, but the
    // mesh is usually already connected by the time a dwapp retains a topic
    // (the base net links on unlock, long before the app opens) — so reconcile
    // against the peers we're ALREADY linked to too, or a late joiner's history
    // stays empty. requestFrom is a cheap, idempotent have-list exchange.
    retain(topic) {
      retained.add(topic);
      for (const p of mesh.peers()) requestFrom(p.did, topic).catch(() => {});
    },
    // Publish-and-retain in one move (feeds want this; ephemeral topics
    // use gossip.publish directly and are never stored).
    async publish(topic, data) {
      const env = await gossip.publish(topic, data);
      keep(topic, env);
      return env;
    },
    history: (topic) => store.list(topic),
    requestFrom,
    close() { offTap(); offEnvelope(); offPeer(); },
  });
};
