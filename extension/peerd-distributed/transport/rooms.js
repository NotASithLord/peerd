// @ts-check
// peerd-distributed/transport/rooms.js — joining and living in a room.
//
// A room is a rendezvous key plus the mesh of authenticated links among
// its members (NORTH-STAR D-9: the room is the consent and spam
// boundary). This file owns the JOIN PATHS; transport/mesh.js owns the
// links once they exist:
//
//   1. Rendezvous join — openRendezvous gives the roster; THE JOINER
//      OFFERS to every member (reducer contract, no glare). The WS stays
//      open as the roster feed; if the node dies, the mesh lives on.
//   2. Mesh-assisted join — a newcomer with ONE link into the room asks
//      it for the roster and reaches everyone else by RELAY frames
//      forwarded through that link (the kill-the-server beat, T2).
//   3. Invite codes — the Phase 0 paste-code dance, room-scoped: an
//      inviter mints an offer code, the joiner answers, and the new link
//      bootstraps a mesh-assisted join. Zero servers involved.
//
// Identity note: rendezvous member ids are the node's opaque connIds.
// did:keys only ever come from the signed HELLO on the direct channel —
// the rendezvous never learns who anyone is.

import { openRendezvous, DEFAULT_SIGNALING } from './signaling-client.js';
import { createWebrtcTransport } from './transports/webrtc.js';
import { createRoomMesh } from './mesh.js';
import { createSession } from './session.js';
import { connectionPath } from './ice.js';
import { dlog, dwarn } from '../log.js';

/** @param {string} did */
const short = (did) => (did || '').slice(-8);

const newId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);

// How long to wait for a dialed/answered connect to complete before giving up.
// A live peer answers over the rendezvous in seconds (then ICE connects); a
// STALE roster member (a ghost left by a reload that didn't cleanly leave) never
// answers, so this is mostly the "ghost dial" budget — kept modest so a ghost
// doesn't hang for half a minute.
const ANSWER_TIMEOUT_MS = 15_000;

/**
 * Join a room. Resolves to a Room handle once the rendezvous confirms the
 * join and the initial dials have settled (per-peer failures are
 * non-fatal — a room with one unreachable member is still a room).
 *
 * Pass `url: null` to start serverless (e.g. the invite-code path will
 * bring the first link); everything else still works.
 *
 * @param {{
 *   roomId: string,
 *   identity: import('./mesh.js').Identity,
 *   url?: string | null,
 *   iceServers?: any[],
 *   transport?: any,
 *   WebSocket?: any,
 *   RTCPeerConnection?: any,
 *   now?: () => number,
 *   audit?: import('./mesh.js').AuditFn,
 *   budget?: number,
 *   caps?: string[],
 *   kind?: string,
 * }} opts
 */
export const joinRoom = async ({
  roomId,
  identity,
  url = DEFAULT_SIGNALING[0],
  iceServers,
  transport,
  WebSocket: WS = globalThis.WebSocket,
  RTCPeerConnection = globalThis.RTCPeerConnection,
  now = Date.now,
  audit = null,
  budget,
  caps = ['content', 'pubsub'],
  kind: peerKind,             // 'website' = observe-only visitor (own rendezvous cap pool); omitted/default = extension
} = /** @type {{ roomId: string, identity: import('./mesh.js').Identity }} */ ({})) => {
  const t = transport ?? createWebrtcTransport({ iceServers });
  const mesh = createRoomMesh({ roomId, identity, now, budget, audit });
  /** @type {Set<(arg: { rendezvous: string }) => void>} */
  const statusCbs = new Set();
  let rendezvousState = url ? 'connecting' : 'none';
  /** @type {import('./signaling-client.js').RendezvousSession | null} */
  let session = null;
  let left = false;

  /** @param {string} s */
  const setStatus = (s) => {
    rendezvousState = s;
    for (const cb of [...statusCbs]) cb({ rendezvous: s });
  };

  // HELLO-authenticate a fresh channel and admit it to the mesh. Prefer an
  // existing healthy link over a crossing duplicate — joins can race
  // (rendezvous dial vs. relayed offer) and churn must not win.
  // `via` records WHO introduced this peer (for the network view's introduction
  // animation): 'rendezvous' (the bootstrap node) or the did of a relaying peer.
  /**
   * @param {any} channel
   * @param {string | null} [expectedDid]
   * @param {string | null} [via]
   */
  const admit = async (channel, expectedDid = null, via = null) => {
    const { remoteDid } = await createSession({ channel, identity, caps, now });
    if (expectedDid && remoteDid !== expectedDid) {
      channel.close();
      audit?.('peer_did_mismatch', { expected: expectedDid, got: remoteDid });
      throw new Error('peer authenticated as a different did than expected');
    }
    if (mesh.hasLink(remoteDid)) {
      dlog('room', `already linked to ${short(remoteDid)} — dropping duplicate channel`);
      channel.close();
      return remoteDid;
    }
    mesh.addLink(channel, remoteDid);
    if (via) mesh.tagLink(remoteDid, { via });
    dlog('room', `✅ CONNECTED to peer ${short(remoteDid)} — data channel open, in the mesh`);
    // Path telemetry for the HUD (D-5): best-effort, after stats settle.
    if (channel.pc) {
      connectionPath(channel.pc).then((p) => {
        mesh.tagLink(remoteDid, { path: p.path });
        dlog('room', `peer ${short(remoteDid)} connectivity: ${p.path}`);
        audit?.('peer_path', { did: remoteDid, path: p.path });
      });
    }
    return remoteDid;
  };

  // ---- shared trickle signaling ------------------------------------------

  // A buffering, per-connection signaling channel for the trickle transport.
  // `send` relays a payload to the remote; inbound payloads arrive via the
  // returned `route` fn and are buffered until the transport registers its
  // onRemote handler (the answer + first candidates race over the wire).
  /** @param {(payload: any) => void} send */
  const makeSignaling = (send) => {
    /** @type {((payload: any) => void) | null} */
    let handler = null;
    /** @type {any[]} */
    const buffer = [];
    return {
      /** @param {any} payload */
      route: (payload) => { if (handler) handler(payload); else buffer.push(payload); },
      signaling: {
        send,
        /** @param {(payload: any) => void} h */
        onRemote: (h) => {
          handler = h;
          while (buffer.length) h(buffer.shift());
          return () => { handler = null; };
        },
      },
    };
  };

  // Bound a connect/accept so an unreachable peer (offer sent, answer never
  // arrives) fails the join instead of hanging on the slow ICE timeout.
  /**
   * @template T
   * @param {Promise<T>} promise
   * @param {string} label
   * @returns {Promise<T>}
   */
  const withConnectTimeout = (promise, label) => Promise.race([
    promise,
    /** @type {Promise<T>} */ (new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ANSWER_TIMEOUT_MS))),
  ]);

  // A connect that merely TIMED OUT is almost always a stale roster member (a
  // ghost the rendezvous hasn't reaped yet) or a peer that can't form a path —
  // routine and harmless on a best-effort dial, so log it gently. A real error
  // (something threw) stays loud.
  /** @param {string} what @param {string} who @param {unknown} e */
  const logConnectFail = (what, who, e) => {
    const msg = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
    if (msg.includes('timed out')) dlog('room', `${what} ${short(who)} timed out — likely a stale roster member, skipping`);
    else dwarn('room', `${what} ${short(who)} failed: ${msg}`);
  };

  // ---- rendezvous path ----------------------------------------------------

  /** @param {import('./signaling-client.js').RendezvousSession} s */
  const attachSession = (s) => {
    /** @type {Map<string, (payload: any) => void>} */
    const routers = new Map(); // member connId -> route(payload)

    s.on('signal', async (/** @type {{ from: string, payload: any }} */ { from, payload }) => {
      const route = routers.get(from);
      if (route) { route(payload); return; } // candidate/answer for an in-flight connect
      // No connection to `from` yet → an OFFER starts the responder flow
      // (the room protocol has the JOINER offer; existing members answer).
      if (payload?.type !== 'offer') return; // stray candidate/answer — ignore
      dlog('room', `📥 offer from ${from} — answering (trickle)`);
      const { route: r, signaling } = makeSignaling((p) => s.sendSignal(from, p));
      routers.set(from, r);
      try {
        const { channel } = await t.accept({ offer: payload, iceServers, signaling });
        await admit(await withConnectTimeout(channel, `accept ${from}`), null, 'rendezvous');
      } catch (e) {
        logConnectFail('accept from', from, e);
        audit?.('room_accept_failed', { member: from, error: /** @type {{ message?: string }} */ (e)?.message });
      } finally {
        routers.delete(from);
      }
    });

    s.on('closed', () => {
      // Ignore a LATE close from a session we've already replaced — otherwise a
      // stale handler + the current one both fire and start two reconnect loops.
      if (s !== session) return;
      // The WS dropped (idle reap, node hibernation, network blip). The mesh is
      // untouched — existing peers stay linked. But a node that's OFF the
      // rendezvous can't be DISCOVERED by new joiners (RELAY only bridges peers
      // who already share a link), so for the always-on lobby we RECONNECT with
      // backoff rather than going dark. setStatus('connecting') reflects that.
      audit?.('rendezvous_lost', { roomId });
      scheduleReconnect();
    });

    /** @param {string} member */
    const dial = async (member) => {
      dlog('room', `📞 dialing ${member} (trickle: offer now, candidates streaming)…`);
      const { route, signaling } = makeSignaling((p) => s.sendSignal(member, p));
      routers.set(member, route);
      try {
        const channel = await withConnectTimeout(
          t.connect({ did: `${roomId}/${member}` }, { iceServers, signaling }),
          `dial ${member}`,
        );
        await admit(channel, null, 'rendezvous');
      } catch (e) {
        logConnectFail('dial to', member, e);
        audit?.('room_dial_failed', { member, error: /** @type {{ message?: string }} */ (e)?.message });
      } finally {
        routers.delete(member);
      }
    };
    return { dial };
  };

  // ---- mesh-assisted path (server-optional) -------------------------------

  /** @type {Map<string, (payload: any) => void>} */
  const relayRouters = new Map(); // sid -> route(payload)

  mesh.onRelay(async (/** @type {{ env: any, via: string }} */ { env, via }) => {
    const { kind, sid, payload } = env.body;
    if (kind === 'offer') {
      // A newcomer reached us through a member we already link. Room-scoped
      // consent (D-9): answer it (trickle over the relay).
      dlog('room', `📥 relayed offer via ${short(via)} — answering`);
      const { route, signaling } = makeSignaling((p) =>
        mesh.relay(via, env.from, p.type === 'answer' ? 'answer' : 'ice', sid, p));
      relayRouters.set(sid, route);
      try {
        const { channel } = await t.accept({ offer: payload, iceServers, signaling });
        await admit(await withConnectTimeout(channel, `relay accept ${short(env.from)}`), env.from, via);
        audit?.('relay_join_accepted', { did: env.from, via });
      } catch (e) {
        logConnectFail('relay accept', env.from, e);
        audit?.('relay_accept_failed', { from: env.from, error: /** @type {{ message?: string }} */ (e)?.message });
      } finally {
        relayRouters.delete(sid);
      }
      return;
    }
    // answer / ice → route to the relay-dialer's signaling for this sid
    relayRouters.get(sid)?.(payload);
  });

  /** @param {string} via @param {string} targetDid */
  const dialViaRelay = async (via, targetDid) => {
    const sid = newId();
    dlog('room', `📞 relay-dialing ${short(targetDid)} via ${short(via)}…`);
    const { route, signaling } = makeSignaling((p) =>
      mesh.relay(via, targetDid, p.type === 'offer' ? 'offer' : 'ice', sid, p));
    relayRouters.set(sid, route);
    try {
      const channel = await withConnectTimeout(
        t.connect({ did: targetDid }, { iceServers, signaling }),
        `relay dial ${short(targetDid)}`,
      );
      await admit(channel, targetDid, via);
    } finally {
      relayRouters.delete(sid);
    }
  };

  // Crawl the room through one connected member: their roster, then a
  // relayed dial to everyone we don't hold yet.
  /** @param {string} viaDid */
  const expandViaPeer = async (viaDid) => {
    const members = /** @type {string[]} */ (await mesh.requestRoster(viaDid));
    const results = await Promise.allSettled(
      members
        .filter((d) => d !== identity.did && !mesh.hasLink(d))
        .map((d) => dialViaRelay(viaDid, d)),
    );
    for (const r of results) {
      if (r.status === 'rejected') audit?.('relay_dial_failed', { error: r.reason?.message });
    }
  };

  // ---- rendezvous connect + reconnect (always-on lobby) -------------------
  // The first connect blocks the join (throws if the node is unreachable —
  // unchanged). After that, a DROP triggers reconnect-with-backoff: re-open the
  // rendezvous, re-attach, and re-dial the roster. admit() dedupes against
  // existing mesh links, so re-dialing peers we already hold is a harmless
  // no-op — which is exactly how a returning node rediscovers the room.
  /** @type {ReturnType<typeof setTimeout> | null} */
  let reconnectTimer = null;
  let backoffMs = 2_000;
  const RECONNECT_MAX_MS = 30_000;
  // Consecutive failed reconnects. The first couple are the EXPECTED transient —
  // a CF Worker cold start / Durable-Object eviction race / edge reset that the
  // backoff rides through — so they log at debug. A PERSISTENT outage (the node
  // actually down) escalates to a warning with the streak count, so a real
  // problem is loud while the normal cold-start blip stays quiet.
  let reconnectFailures = 0;
  const QUIET_RECONNECTS = 2;

  const connectRendezvous = async () => {
    if (left) return;
    // why cast: connectRendezvous is only reached when `url` is truthy (the
    // `if (url)` join guard and the reconnect loop); never with a null url.
    const s = await openRendezvous({ url: /** @type {string} */ (url), room: roomId, WebSocket: WS, kind: peerKind });
    if (left) { s.close(); return; }                    // left() raced the connect — abandon it
    session = s;
    setStatus('up');
    backoffMs = 2_000;                                  // reset on a clean connect
    reconnectFailures = 0;                              // clean connect — forget the streak
    const { dial } = attachSession(session);
    if (session.members.length === 0) dlog('room', 'first one here — waiting for others to join and offer');
    else dlog('room', `${session.members.length} member(s) here — dialing each:`, session.members);
    await Promise.allSettled(session.members.map(dial));
  };

  const scheduleReconnect = () => {
    if (left || reconnectTimer) return;
    setStatus('connecting');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectRendezvous().catch((e) => {
        reconnectFailures += 1;
        // Quiet the expected transient, surface a persistent outage (with the count).
        const log = reconnectFailures <= QUIET_RECONNECTS ? dlog : dwarn;
        log('room', `rendezvous reconnect failed (attempt ${reconnectFailures}): ${e?.message ?? e} — retrying`);
        backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS); // grow only on a real failed attempt
        scheduleReconnect();
      });
    }, backoffMs);
  };

  // ---- assemble -----------------------------------------------------------

  dlog('room', `joining room "${roomId}" as ${short(identity.did)} via ${url}`);
  if (url) await connectRendezvous();

  mesh.start();
  dlog('room', `room "${roomId}" assembled — ${mesh.peers().length} live peer link(s)`);

  return Object.freeze({
    roomId,
    did: identity.did,
    mesh,
    peers: mesh.peers,
    onPeer: mesh.onPeer,
    onPeerGone: mesh.onPeerGone,
    onEnvelope: mesh.onEnvelope,
    /** @param {(arg: { rendezvous: string }) => void} cb */
    onStatus: (cb) => { statusCbs.add(cb); return () => statusCbs.delete(cb); },
    rendezvous: () => rendezvousState,
    expandViaPeer,
    // Targeted relay-dial: reach `targetDid` through a peer we already link
    // (`brokerDid` forwards the signaling). The DHT dialer uses this to connect
    // to a lookup contact it doesn't link yet. Resolves once linked, throws on
    // timeout. One hop only — `brokerDid` must be directly linked.
    /** @param {string} brokerDid @param {string} targetDid */
    dialVia: (brokerDid, targetDid) => dialViaRelay(brokerDid, targetDid),
    leave() {
      if (left) return;
      left = true;
      clearTimeout(reconnectTimer ?? undefined);
      try { session?.close(); } catch { /* already closed */ }
      mesh.close();
    },
  });
};
