// web/agent-mesh.js — a FULL-participant agent peer for the demo lobby.
//
// The peers tab (peer-host.js) joins the live lobby OBSERVE-ONLY. This is its
// active twin: a page-hosted agent that publishes an Agent Card and talks to
// other agents peer-to-peer. It reuses peerd's REAL agent-to-agent machinery
// unmodified — makeMeshDispatch (peerd-runtime/actor/a2a-dispatch.js) drives the
// request/reply correlation over the SAME signed 1:1 direct channel
// (peerd-distributed/messaging/direct.js) the extension's dweb actor uses. So
// the demo IS peerd's A2A architecture; only the two injected seams differ for
// the page: the IO (direct/presence instead of the SW's mesh relays) and consent
// (demo agents auto-approve each other — honest to the real first-contact gate,
// just pre-cleared).
//
// Isolation: joins an OWN lobby (peerd/demo/1), never production peerd/base/1 —
// a swarm of demo agents must not pollute the real network or burn real users'
// inbound rate caps. Cards ride presence meta (small: name + skills), the same
// gossip beacon the observe-only peer already uses.

import { generateIdentity } from '/peerd-distributed/identity/keypair.js';
import { joinRoom } from '/peerd-distributed/transport/rooms.js';
import { createGossip } from '/peerd-distributed/gossip/topic.js';
import { createPresence } from '/peerd-distributed/gossip/presence.js';
import { createDirect } from '/peerd-distributed/messaging/direct.js';
import { normalizeCard } from '/peerd-distributed/agent-card.js';
import { makeMeshDispatch } from '/peerd-runtime/actor/a2a-dispatch.js';

const DEMO_LOBBY = 'peerd/demo/1';                          // isolated — NOT peerd/base/1
const RENDEZVOUS = 'wss://bootstrap.peerd.ai/rendezvous';   // introductions only, never in the data path

/**
 * Join the demo lobby as a full agent peer.
 * @param {{
 *   card: { name: string, description?: string, skills?: Array<{id?:string,name?:string,description?:string}> },
 *   onInbound?: (msg: { from: string, kind: string, reqId: string, message: string }) => void,
 *   onRoster?: (peers: Array<{ did: string, card: object|null }>) => void,
 *   lobby?: string, url?: string,
 * }} cfg
 * @returns {Promise<{ myDid: string, discover: () => Array<{did:string,card:object|null}>,
 *   ask: (did: string, message: string, timeoutMs?: number) => Promise<any>,
 *   reply: (toDid: string, reqId: string, message: string) => Promise<any>,
 *   stop: () => void }>}
 */
export async function startAgentMesh({ card, onInbound = () => {}, onRoster = () => {}, lobby = DEMO_LOBBY, url = RENDEZVOUS }) {
  if (!window.crypto?.subtle || !window.RTCPeerConnection) throw new Error('this browser can’t run the live peer');

  const identity = await generateIdentity();
  const room = await joinRoom({ roomId: lobby, identity, url });   // full member (default kind → ROOM_CAP pool)
  const gossip = createGossip({ mesh: room.mesh });
  const direct = createDirect({ mesh: room.mesh });

  // My card is mutable (publishCard can update it); presence beacons a compact
  // form (name + skills) so peers discover capability without a second topic.
  let myCard = normalizeCard({ ...card, did: identity.did });
  const compactCard = () => ({ name: myCard.name, skills: myCard.skills });
  const presence = createPresence({
    gossip, selfDid: identity.did,
    meta: () => ({ kind: 'agent', card: compactCard() }),
  });
  presence.start();

  // Read an agent peer's advertised card from its latest presence beacon.
  const cardOf = (did) => {
    const p = presence.list().find((x) => x.did === did);
    return p?.meta?.card ? normalizeCard({ ...p.meta.card, did }) : null;
  };
  const agentPeers = () => presence.list().filter((p) => p.meta?.kind === 'agent' && p.did !== identity.did);
  const discover = () => agentPeers().map((p) => ({ did: p.did, card: cardOf(p.did) }));

  // The REAL a2a dispatch, IO injected for the page. sendDm rides the signed
  // direct channel; listPeers/fetchCard read presence; publishCard updates my
  // beacon. conversations omitted → single-shot ask/send (converse/say are a
  // later slice). Consent is demo auto-approve (allowed: () => true below).
  const dispatch = makeMeshDispatch({
    sendDm: async (toDid, env) => {
      try { const r = await direct.send(toDid, env); return { ok: true, ...(r?.id ? { id: r.id } : {}) }; }
      catch (e) { return { ok: false, error: (/** @type {any} */ (e))?.message || String(e) }; }
    },
    listPeers: async () => agentPeers().map((p) => ({ did: p.did, name: p.meta?.card?.name })),
    fetchCard: async (did) => cardOf(did),
    publishCard: async (c) => { myCard = normalizeCard({ ...c, did: identity.did }); return { ok: true, did: identity.did }; },
  });

  // Route every inbound direct message through the real correlation: a 'reply'
  // resolves a pending ask (consumed); an 'ask'/'tell' surfaces to the responder.
  const offDirect = direct.onMessage(({ from, data }) => {
    const routed = dispatch.handleInbound(from, data);
    if (routed.deliver) onInbound(routed.deliver);
  });

  const emitRoster = () => onRoster(discover());
  presence.onJoin(emitRoster); presence.onLeave(emitRoster);
  room.onPeer?.(emitRoster); room.onPeerGone?.(emitRoster);
  emitRoster();

  // Auto-consent between demo agents (honest to the real first-contact gate,
  // pre-cleared for the demo). ask signs as the user; the gate takes ctx.allowed.
  const signed = { signs: true, allowed: () => true };

  const stop = () => {
    try { offDirect?.(); } catch { /* */ }
    try { presence.stop(); } catch { /* */ }
    try { direct.close(); } catch { /* */ }
    try { room.leave(); } catch { /* */ }
  };
  window.addEventListener('pagehide', stop, { once: true });

  return {
    myDid: identity.did,
    discover,
    ask: (did, message, timeoutMs) => dispatch.dispatch('ask', { did, message, timeoutMs }, signed),
    reply: (toDid, reqId, message) => dispatch.reply(toDid, reqId, message),
    // The room's raw seams, for other protocols riding the SAME peer identity
    // and links — the game arena (web/arena.js) registers its own
    // direct.onMessage (subscribers are independent; the a2a router above
    // ignores non-a2a data) and speaks its own gossip topics.
    raw: { identity, direct, gossip, presence },
    stop,
  };
}
