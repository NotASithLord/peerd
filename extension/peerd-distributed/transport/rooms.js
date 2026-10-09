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
import { TOPIC_SYNC_WINDOW } from './capabilities.js';
import { connectionPath } from './ice.js';
import { AdmissionError, roomAdmission, MAX_ADMISSION_CANDIDATES } from './admission.js';
import { createSignalingBuffer } from './signaling-buffer.js';
import { dlog, dwarn } from '../log.js';
import { SPARSE_PUBLIC_PROFILE, sparsePublicProfile } from './rendezvous-profile.js';
import { createNeighborMaintenance, NEIGHBOR_CANDIDATES } from './neighbors.js';

/** @param {string} did */
const short = (did) => (did || '').slice(-8);

const newId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);

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
 *   profile?: string,
 *   random?: () => number,
 *   timers?: any,
 *   awaitInitialRendezvous?: boolean,
 *   onMesh?: ((mesh:any)=>()=>void)|null,
 *   isBlocked?: (did:string)=>boolean,
 *   admitPeer?: ((did:string)=>Promise<boolean>)|null,
 *   admission?: ReturnType<typeof import('./admission.js').createAdmissionGovernor>,
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
  random = Math.random,
  timers = globalThis,
  profile,
  audit = null,
  budget,
  caps = ['content', 'pubsub', TOPIC_SYNC_WINDOW],
  kind: peerKind,             // 'website' = observe-only visitor (own rendezvous cap pool); omitted/default = extension
  awaitInitialRendezvous = true,
  admission = roomAdmission,
  isBlocked = () => false, admitPeer = null, onMesh = null,
} = /** @type {{ roomId: string, identity: import('./mesh.js').Identity }} */ ({})) => {
  // why: protocol support is mutual and fixed for this room lifetime; a
  // caller-owned capabilities array must not change negotiation after joining.
  const sessionCaps = [...caps];
  const t = transport ?? createWebrtcTransport({ iceServers, RTCPeerConnection });
  const mesh = createRoomMesh({ roomId, identity, now, budget, audit, isBlocked });
  const releaseMesh = onMesh?.(mesh);
  /** @type {Set<(arg: { rendezvous: string }) => void>} */
  const statusCbs = new Set();
  let rendezvousState = url ? 'connecting' : 'none';
  /** @type {import('./signaling-client.js').RendezvousSession | null} */
  let session = null;
  let left = false;
  const lifetime = new AbortController();
  const sparseRequested = peerKind !== 'website' && !!sparsePublicProfile(roomId, profile);
  const attempts = admission.createScope();
  /** @type {Set<string>} */
  const repairTargets = new Set();

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
   * @param {AbortSignal} [signal]
   * @param {boolean} [locallySelected]
   */
  const admit = async (channel, expectedDid = null, via = null, signal, locallySelected = false) => {
    if (left || signal?.aborted || channel.isClosed?.()) { channel.close(); throw new Error('room dial cancelled or channel closed'); }
    const { remoteDid, remoteCaps } = await createSession({ channel, identity, caps: sessionCaps, now, signal, timers });
    if (left || signal?.aborted || channel.isClosed?.()) { channel.close(); throw new Error('room dial cancelled or channel closed'); }
    if (expectedDid && remoteDid !== expectedDid) {
      channel.close();
      audit?.('peer_did_mismatch', { expected: expectedDid, got: remoteDid });
      throw new Error('peer authenticated as a different did than expected');
    }
    if ((admitPeer && !await admitPeer(remoteDid)) || isBlocked(remoteDid)) {
      channel.close(); throw new Error('peer-user-blocked');
    }
    if (left || signal?.aborted || channel.isClosed?.() || isBlocked(remoteDid)) {
      channel.close(); throw new Error('room admission retired');
    }
    if (mesh.hasLink(remoteDid)) {
      dlog('room', `already linked to ${short(remoteDid)} — dropping duplicate channel`);
      channel.close();
      return remoteDid;
    }
    if (!mesh.addLink(channel, remoteDid, { caps: remoteCaps.filter((cap) => sessionCaps.includes(cap)) }, { locallySelected })) throw new Error('room peer admission refused');
    repairTargets.delete(remoteDid);
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

  // why: all construction paths share the same reservation, including HELLO.
  // Cancellation retires signaling and closes unadmitted/late channels before
  // the governor makes the slot available to another room.
  /** @param {{ key: string, direction: 'inbound'|'outbound',
   * routers: Map<string, (payload: any) => void>, routeKey: string,
   * send: (payload: any, signal: AbortSignal) => void | Promise<void>,
   * connect: (signaling: any, signal: AbortSignal) => Promise<any>,
   * expectedDid?: string | null, via: string, signal?: AbortSignal }} opts */
  const attempt = ({ key, direction, routers, routeKey, send, connect, expectedDid = null, via, signal }) =>
    attempts.run(key, direction, async (reservationSignal) => {
      if (expectedDid && isBlocked(expectedDid)) throw new Error('peer-user-blocked');
      const ac = new AbortController();
      const cancel = () => {
        pipe.close();
        if (routers.get(routeKey) === pipe.route) routers.delete(routeKey);
        ac.abort();
      };
      reservationSignal.addEventListener('abort', cancel, { once: true });
      const pipe = createSignalingBuffer((payload) => send(payload, ac.signal), cancel);
      routers.set(routeKey, pipe.route);
      /** @type {any} */
      let opened = null;
      let admitted = false;
      const aborted = new Promise((_, reject) => {
        ac.signal.addEventListener('abort', () => {
          if (!admitted) opened?.close();
          reject(new AdmissionError('cancelled'));
        }, { once: true });
      });
      const work = async () => {
        const channel = await connect(pipe.signaling, ac.signal);
        opened = channel;
        if (ac.signal.aborted) { channel.close(); throw new AdmissionError('cancelled'); }
        const did = await admit(channel, expectedDid, via, ac.signal, direction === 'outbound');
        admitted = true;
        return did;
      };
      try { return await Promise.race([aborted, work()]); }
      finally {
        pipe.close();
        if (routers.get(routeKey) === pipe.route) routers.delete(routeKey);
        reservationSignal.removeEventListener('abort', cancel);
        ac.abort();
      }
    }, signal);

  // Bound both task closures and candidate identity bytes, not just active PCs.
  /** @param {any} members @param {(member: string) => boolean} [eligible] */
  const candidates = (members, eligible = () => true) => {
    /** @type {string[]} */
    const selected = [];
    const limit = Math.min(MAX_ADMISSION_CANDIDATES, attempts.candidateCapacity);
    let seen = 0;
    if (!Array.isArray(members)) return selected;
    for (const member of members) {
      if (typeof member !== 'string' || !member.length || member.length > 512 || !eligible(member)) continue;
      // why: keep a bounded sample rather than permanently preferring the same
      // roster prefix. Sparse-overlay maintenance belongs above this scheduler.
      seen++;
      const index = selected.length < limit ? selected.length : Math.floor(random() * seen);
      if (index < limit && !selected.includes(member)) selected[index] = member;
    }
    return selected;
  };

  // Preserve transport versus HELLO timeout detail: an open carrier is not a stale roster entry.
  /** @param {string} what @param {string} who @param {unknown} e */
  const logConnectFail = (what, who, e) => {
    if (e instanceof AdmissionError) return; // overload/cancellation is not misconduct or a warning
    const error = /** @type {{ message?: string, helloProgress?: object }} */ (e);
    const msg = error?.message ?? String(e);
    const progress = error?.helloProgress ? ` ${JSON.stringify(error.helloProgress)}` : '';
    (msg.includes('timed out') ? dlog : dwarn)('room', `${what} ${short(who)} failed: ${msg}${progress}`);
  };

  // ---- rendezvous path ----------------------------------------------------

  /** @param {import('./signaling-client.js').RendezvousSession} s */
  const attachSession = (s) => {
    /** @type {Map<string, (payload: any) => void>} */
    const routers = new Map(); // member connId -> route(payload)

    const generationLife = new AbortController();
    const retire = () => generationLife.abort();
    lifetime.signal.addEventListener('abort', retire, { once: true });
    generationLife.signal.addEventListener('abort', () => lifetime.signal.removeEventListener('abort', retire), { once: true });
    const bindings = new Map();
    const outgoing = new Set();
    const known = (/** @type {string} */ member) => {
      const did = bindings.get(member);
      return !!did && mesh.hasLink(did);
    };
    /** @type {ReturnType<typeof createNeighborMaintenance> | null} */
    let maintenance = null;
    // Session identity keeps reconnect generations from sharing candidate keys.
    const generation = newId();
    s.on('signal', async (/** @type {{ from: string, payload: any }} */ { from, payload }) => {
      if (left || generationLife.signal.aborted || typeof from !== 'string' || from.length > 512) return;
      if (payload?.type === 'offer' && (typeof payload.sdp !== 'string' || payload.sdp.length > 128 * 1024
        || new TextEncoder().encode(payload.sdp).byteLength > 128 * 1024)) return;
      const key = `${generation}/${from}`;
      let direction = /** @type {'inbound'|'outbound'} */ ('inbound');
      // Resolve crossing offers BEFORE forwarding trickle frames into a router.
      // Connection labels order this endpoint generation, not peer identity.
      if (payload?.type === 'offer' && outgoing.has(from) && attempts.pending(key)) {
        if (/** @type {string} */ (s.self) < from) return;
        outgoing.delete(from);
        attempts.supersede(key);
        direction = 'outbound'; // preserve locally requested exploration
      }
      const route = routers.get(from);
      if (route) { if (payload?.type !== 'offer') route(payload); return; }
      if (known(from)) return;
      if (payload?.type !== 'offer' || typeof payload.sdp !== 'string' || payload.sdp.length > 128 * 1024 || new TextEncoder().encode(payload.sdp).byteLength > 128 * 1024) return;
      try {
        const did = await attempt({ key, direction, routers, routeKey: from,
          send: (p) => s.sendSignal(from, p), via: 'rendezvous', signal: generationLife.signal,
          connect: async (signaling, signal) => (await t.accept({ offer: { type: 'offer', sdp: payload.sdp }, iceServers, signaling, signal })).channel });
        bind(from, did);
      } catch (e) { logConnectFail('accept from', from, e); }
    });

    s.on('closed', () => {
      generationLife.abort();
      // Ignore a LATE close from a session we've already replaced — otherwise a
      // stale handler + the current one both fire and start two reconnect loops.
      if (s !== session) return;
      // The WS dropped (idle reap, node hibernation, network blip). The mesh is
      // untouched — existing peers stay linked. But a node that's OFF the
      // rendezvous can't be DISCOVERED by new joiners (RELAY only bridges peers
      // who already share a link), so for the always-on lobby we RECONNECT with
      // backoff rather than going dark. setStatus('connecting') reflects that.
      if (sparseRequested) mesh.setSparseRotation(false);
      audit?.('rendezvous_lost', { roomId });
      scheduleReconnect();
      // A data channel can report its close just before the WebSocket reports
      // the outage. Recover that ordering exactly as if the link died later.
      if (repairTargets.size > 0) scheduleOfflineRepair(true);
    });

    /** @param {string} member @param {any} did */
    const bind = (member, did) => {
      if (generationLife.signal.aborted || typeof did !== 'string') return;
      if (!bindings.has(member) && bindings.size >= NEIGHBOR_CANDIDATES) bindings.delete(bindings.keys().next().value);
      bindings.set(member, did);
    };
    /** @param {string} member @param {AbortSignal} [signal] */
    const dial = async (member, signal = generationLife.signal) => {
      if (outgoing.has(member)) throw new AdmissionError('duplicate');
      outgoing.add(member);
      try {
        if (known(member)) return;
        const did = await attempt({ key: `${generation}/${member}`, direction: 'outbound', routers, routeKey: member,
          send: (p) => s.sendSignal(member, p), via: 'rendezvous', signal,
          connect: (signaling, attemptSignal) => t.connect({ did: `${roomId}/${member}` }, { iceServers, signaling, signal: attemptSignal }) });
        bind(member, did);
      } catch (e) { logConnectFail('dial to', member, e); throw e; }
      finally { outgoing.delete(member); }
    };
    if (s.profile === SPARSE_PUBLIC_PROFILE) {
      mesh.enableSparseAdmission();
      maintenance = createNeighborMaintenance({ initial: s.members, sample: s.sample,
        connect: dial, known, localCount: mesh.locallySelectedCount, now, random, timers, signal: generationLife.signal });
      const offGone = mesh.onPeerGone(() => maintenance?.wake());
      generationLife.signal.addEventListener('abort', () => { offGone(); bindings.clear(); maintenance?.stop(); }, { once: true });
    }
    return { dial, maintenance };
  };

  // ---- mesh-assisted path (server-optional) -------------------------------

  /** @type {Map<string, (payload: any) => void>} */
  const relayRouters = new Map(); // sid -> route(payload)

  // why: a crossing-offer replacement belongs to the room, but the original
  // caller must still be able to stop waiting without tearing down that link.
  /** @param {Promise<any>} pending @param {AbortSignal} [signal] */
  const waitForAdmission = (pending, signal) => {
    if (!signal) return pending;
    if (signal.aborted) return Promise.reject(new AdmissionError('cancelled'));
    return new Promise((resolve, reject) => {
      const cancel = () => reject(new AdmissionError('cancelled'));
      signal.addEventListener('abort', cancel, { once: true });
      pending.then((value) => { signal.removeEventListener('abort', cancel); resolve(value); },
        (error) => { signal.removeEventListener('abort', cancel); reject(error); });
    });
  };

  mesh.onRelay(async (/** @type {{ env: any, via: string }} */ { env, via }) => {
    const { kind, sid, payload } = env.body;
    if (left || isBlocked(env.from) || typeof sid !== 'string' || sid.length > 512 || typeof env.from !== 'string' || env.from.length > 512) return;
    // why: a session id alone lets another authenticated origin inject ICE
    // into, or replace, a different peer's pending attempt.
    const routeKey = `${env.from}/${sid}`;
    const route = relayRouters.get(routeKey);
    if (route) { if (kind !== 'offer') route(payload); return; }
    if (kind !== 'offer' || payload?.type !== 'offer' || typeof payload.sdp !== 'string' || payload.sdp.length > 128 * 1024 || new TextEncoder().encode(payload.sdp).byteLength > 128 * 1024) return;
    // why: if both ends dial, retaining whichever channel authenticates first
    // can make each close the other's survivor. The lower DID owns the dial;
    // the higher DID cancels its outgoing attempt before accepting that offer.
    /** @type {'inbound'|'outbound'} */
    let direction = 'inbound';
    if (attempts.pending(`did/${env.from}`)) {
      if (identity.did < env.from) return;
      attempts.supersede(`did/${env.from}`);
      // This is still locally requested exploration: swapping wire roles must
      // not lose its reserved outbound capacity to an inbound flood.
      direction = 'outbound';
    }
    try {
      await attempt({ key: `incoming-did/${env.from}`, direction, routers: relayRouters, routeKey,
        expectedDid: env.from, via,
        send: (p, signal) => mesh.relay(via, env.from, p.type === 'answer' ? 'answer' : 'ice', sid, p, { signal }),
        connect: async (signaling, signal) => (await t.accept({ offer: { type: 'offer', sdp: payload.sdp }, iceServers, signaling, signal })).channel });
    } catch (e) { logConnectFail('relay accept', env.from, e); }
  });

  /** @param {string} via @param {string} targetDid @param {{signal?: AbortSignal}} [opts] */
  const dialViaRelay = async (via, targetDid, { signal } = {}) => {
    if (left || signal?.aborted) throw new AdmissionError('cancelled');
    if (isBlocked(targetDid)) throw new Error('peer-user-blocked');
    if (mesh.hasLink(targetDid)) return;
    if (typeof targetDid !== 'string' || targetDid.length > 512) throw new AdmissionError('invalid candidate');
    const incoming = attempts.pending(`incoming-did/${targetDid}`);
    if (incoming) throw new AdmissionError('duplicate');
    const sid = newId();
    try { await attempt({ key: `did/${targetDid}`, direction: 'outbound', routers: relayRouters,
      routeKey: `${targetDid}/${sid}`, expectedDid: targetDid, via, signal,
      send: (p, attemptSignal) => mesh.relay(via, targetDid, p.type === 'offer' ? 'offer' : 'ice', sid, p, { signal: attemptSignal }),
      connect: (signaling, attemptSignal) => t.connect({ did: targetDid }, { iceServers, signaling, signal: attemptSignal }) }); }
    catch (error) {
      const replacement = attempts.pending(`incoming-did/${targetDid}`);
      if (error instanceof AdmissionError && error.reason === 'superseded' && replacement && !left && !signal?.aborted) {
        await waitForAdmission(replacement, signal);
        return;
      }
      throw error;
    }
  };

  // Crawl the room through one connected member: their roster, then a
  // relayed dial to everyone we don't hold yet.
  /** @param {string} viaDid */
  const expandViaPeer = async (viaDid) => {
    const members = /** @type {string[]} */ (await mesh.requestRoster(viaDid));
    const results = await Promise.allSettled(
      candidates(members, (d) => d !== identity.did && !mesh.hasLink(d))
        .map((d) => dialViaRelay(viaDid, d)),
    );
    for (const r of results) {
      if (r.status === 'rejected') audit?.('relay_dial_failed', { error: r.reason?.message });
    }
  };

  // A rendezvous outage must not turn a single data-channel loss into a
  // permanent partition. Crawl every surviving authenticated neighbor and
  // relay-dial peers from its roster. Three bounded rounds cover simultaneous
  // channel teardown without creating an unbounded background protocol.
  const REPAIR_DELAYS_MS = [250, 1_000, 3_000];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let repairTimer = null;
  let repairEpoch = 0;
  let repairRound = 0;

  const stopOfflineRepair = () => {
    repairEpoch += 1;
    repairRound = 0;
    timers.clearTimeout(repairTimer ?? undefined);
    repairTimer = null;
  };

  /** @param {boolean} [restart] */
  const scheduleOfflineRepair = (restart = false) => {
    if (left || rendezvousState === 'up' || mesh.peers().length === 0) return;
    if (restart) stopOfflineRepair();
    if (repairTimer || repairRound >= REPAIR_DELAYS_MS.length) return;
    const epoch = repairEpoch;
    const delay = REPAIR_DELAYS_MS[repairRound];
    repairTimer = timers.setTimeout(async () => {
      repairTimer = null;
      if (left || rendezvousState === 'up' || epoch !== repairEpoch) return;
      const peers = mesh.peers().map(({ did }) => did);
      for (const did of repairTargets) if (mesh.hasLink(did)) repairTargets.delete(did);
      const targets = [...repairTargets];
      const target = targets[repairRound % targets.length];
      const broker = peers[repairRound % peers.length];
      audit?.('offline_mesh_repair', { round: repairRound + 1, peers: peers.length, targets: targets.length });
      if (broker && target) await dialViaRelay(broker, target).catch(error => {
        audit?.('offline_mesh_repair_failed', { error: error?.message });
      });
      if (target && mesh.hasLink(target)) repairTargets.delete(target);
      if (left || rendezvousState === 'up' || epoch !== repairEpoch) return;
      repairRound += 1;
      scheduleOfflineRepair();
    }, delay);
  };

  const stopRepairObserver = mesh.onPeerGone(({ did }) => {
    const oldest = repairTargets.size >= MAX_ADMISSION_CANDIDATES
      ? repairTargets.values().next().value : undefined;
    if (oldest) repairTargets.delete(oldest);
    repairTargets.add(did);
    if (rendezvousState !== 'up') scheduleOfflineRepair(true);
  });

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
  // A failed reconnect is almost always the EXPECTED transient — a CF Worker
  // cold start / Durable-Object eviction race / edge reset that the backoff
  // rides through — so each attempt only logs at debug. We escalate to a
  // WARNING only when the outage PERSISTS past OUTAGE_WARN_MS (the node is
  // genuinely down, not a blip), and only once per outage — a transient that
  // recovers never warns. On recovery after a warned outage we log that it's
  // back, so the warning isn't left dangling.
  const OUTAGE_WARN_MS = 60_000;
  let reconnectFailures = 0;   // attempts in the current streak (for the debug line)
  let outageSince = 0;         // ms timestamp of the streak's first failure (0 = connected)
  let outageWarned = false;    // already warned about the current outage?

  const connectRendezvous = async () => {
    if (left) return;
    // why cast: connectRendezvous is only reached when `url` is truthy (the
    // `if (url)` join guard and the reconnect loop); never with a null url.
    const s = await openRendezvous({ url: /** @type {string} */ (url), room: roomId, WebSocket: WS, kind: peerKind,
      profile: sparsePublicProfile(roomId, profile) ?? undefined, signal: lifetime.signal, now, timers });
    if (left) { s.close(); return; }                    // left() raced the connect — abandon it
    session = s;
    stopOfflineRepair();
    if (sparseRequested) mesh.setSparseRotation(true);
    setStatus('up');
    backoffMs = 2_000;                                  // reset on a clean connect
    // If we'd warned this was a real outage, close the loop now that it's back.
    if (outageWarned) dlog('room', `rendezvous recovered after ${Math.round((Date.now() - outageSince) / 1000)}s`);
    reconnectFailures = 0;                              // clean connect — forget the streak
    outageSince = 0;
    outageWarned = false;
    const { dial, maintenance } = attachSession(session);
    if (session.members.length === 0) dlog('room', 'first one here — waiting for others to join and offer');
    else dlog('room', `${session.members.length} member(s) here; scheduling bounded candidate sample`);
    if (maintenance) await maintenance.start();
    else await Promise.allSettled(candidates(session.members).map((member) => dial(member)));
  };

  /** @param {any} e */
  const noteConnectFailure = (e) => {
    if (left) return;
    reconnectFailures += 1;
    if (!outageSince) outageSince = Date.now();
    const downMs = Date.now() - outageSince;
    // Stay quiet while the backoff rides out the expected transient; warn
    // once the outage has truly persisted, and only once per outage. A
    // blip that recovers before OUTAGE_WARN_MS never surfaces a warning.
    if (!outageWarned && downMs >= OUTAGE_WARN_MS) {
      outageWarned = true;
      dwarn('room', `rendezvous unreachable for ${Math.round(downMs / 1000)}s (${reconnectFailures} attempts): ${e?.message ?? e}; still retrying`);
    } else {
      dlog('room', `rendezvous reconnect failed (attempt ${reconnectFailures}): ${e?.message ?? e}; retrying`);
    }
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS); // grow only on a real failed attempt
    scheduleReconnect();
  };

  const scheduleReconnect = () => {
    if (left || reconnectTimer) return;
    setStatus('connecting');
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      connectRendezvous().catch(noteConnectFailure);
    }, backoffMs + (sparseRequested ? Math.floor(random() * Math.min(1_000, backoffMs / 4)) : 0));
  };

  // ---- assemble -----------------------------------------------------------

  dlog('room', `joining room "${roomId}" as ${short(identity.did)} via ${url}`);
  if (url) {
    const initialConnect = connectRendezvous();
    // An always-on host can be useful before its bootstrap node answers: its
    // identity, local mesh, invite/relay paths and lifecycle controls are all
    // independent of rendezvous reachability. Callers that opt out of waiting
    // get a live room in `connecting` state while the normal retry loop heals
    // discovery in the background. Interactive joins keep the strict default.
    if (awaitInitialRendezvous) await initialConnect;
    else void initialConnect.catch(noteConnectFailure);
  }

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
    /** @param {string} brokerDid @param {string} targetDid @param {{signal?: AbortSignal}} [opts] */
    dialVia: (brokerDid, targetDid, opts) => dialViaRelay(brokerDid, targetDid, opts),
    leave() {
      if (left) return;
      left = true;
      releaseMesh?.();
      stopRepairObserver();
      stopOfflineRepair();
      lifetime.abort();
      attempts.close();
      timers.clearTimeout(reconnectTimer ?? undefined);
      try { session?.close(); } catch { /* already closed */ }
      mesh.close();
    },
  });
};
