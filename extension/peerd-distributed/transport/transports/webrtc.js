// @ts-check
// peerd-distributed/transport/transports/webrtc.js — WebRTC transport (trickle ICE).
//
// One Transport implementation: peers on different machines, profiles, or
// browsers. Wraps the RTCPeerConnection plumbing in transport/peer.js.
//
// TRICKLE ICE. Signaling is a small bidirectional channel injected by the
// caller (rooms.js routes it over the rendezvous relay / the mesh):
//   signaling = { send(payload), onRemote(handler) -> unsubscribe }
// The offer/answer goes out IMMEDIATELY (no waiting for the full ICE
// gather), and candidates stream as `{ ice }` messages in both directions.
// The connection completes on the first working candidate pair instead of
// stalling on the slowest STUN round-trip — the fix for the ~tens-of-
// seconds connect we saw with non-trickle gathering.
//
// (The paste-code path — transport/pairing.js — stays NON-trickle by
// necessity: a copy-pasted code can't stream candidates, so it gathers to
// completion and inlines them. That path is separate and untouched.)

import { createPeer, DEFAULT_ICE_SERVERS } from '../peer.js';

/**
 * @typedef {{ send: (payload: any) => void, onRemote: (handler: (msg: any) => void) => (() => void) }} Signaling
 */

/** @param {any} signaling */
const requireSignaling = (signaling) => {
  if (typeof signaling?.send !== 'function' || typeof signaling?.onRemote !== 'function') {
    throw new Error('webrtc: a signaling channel is required ({ send, onRemote })');
  }
};

// Close an abandoned peer's pc when the caller aborts — but ONLY while its
// channel has not yet opened. why: a dial/accept that never pairs (a ghost
// roster member, a symmetric-NAT peer, or a hostile peer that answers then
// stalls ICE) is dropped by rooms.js's give-up timeout, but nothing closes the
// pc — its ICE agent / STUN gather / listeners then leak until the ~30s ICE
// 'failed', which STILL never closes the pc (only channel.close() does, and the
// channel never opened). An abort that races in AFTER the channel opened (late
// completion past the timeout) must leave the live, admitted link alone — the
// mesh now owns that channel and closes it itself. pc.close() is idempotent, so
// a later failDirect/onclose double-close is a no-op; the listener is one-shot.
// exported for unit test (the leak-fix invariant: close-on-abort, opened-guarded,
// one-shot) — nothing else imports it; the module's public surface is the transport.
/**
 * @param {AbortSignal | undefined} signal
 * @param {{ pc: RTCPeerConnection }} p
 * @param {() => boolean} isOpen
 */
export const abortClosesPc = (signal, p, isOpen) => {
  if (!signal) return;
  signal.addEventListener('abort', () => {
    if (isOpen()) return;
    try { p.pc.close(); } catch { /* already closed */ }
  }, { once: true });
};

/**
 * @param {{ RTCPeerConnection?: typeof RTCPeerConnection, iceServers?: RTCIceServer[] }} [opts]
 */
export const createWebrtcTransport = ({ RTCPeerConnection, iceServers = DEFAULT_ICE_SERVERS } = {}) => {
  // sameMachine → loopback (no STUN); else public STUN by default. (The
  // room flow runs sameMachine=false; the mDNS host candidates trickle
  // and resolve on a real LAN, so no SDP rewrite is needed here.)
  /**
   * @param {boolean} sameMachine
   * @param {RTCIceServer[]} [override]
   * @returns {RTCConfiguration}
   */
  const cfgFor = (sameMachine, override) => ({
    iceServers: override ?? (sameMachine ? [] : iceServers),
  });

  return {
    name: 'webrtc',

    // Usable as a general fallback; preferred when the peer advertises it.
    /** @param {{ transports?: Array<{ kind: string }> }} peer */
    canReach(peer) {
      return peer?.transports?.some((t) => t.kind === 'webrtc') ? 0.6 : 0.4;
    },

    // INITIATOR. Creates the offer, sends it immediately, then trickles
    // candidates; applies the remote answer + candidates as they arrive.
    // Resolves to the open Channel (or rejects with DirectPathUnavailableError).
    /**
     * @param {any} peer
     * @param {{ signaling?: Signaling, sameMachine?: boolean, iceServers?: RTCIceServer[], signal?: AbortSignal }} [opts]
     */
    async connect(peer, { signaling, sameMachine = false, iceServers: ice, signal } = {}) {
      requireSignaling(signaling);
      const sig = /** @type {Signaling} */ (signaling);
      const p = createPeer({
        initiator: true,
        RTCPeerConnection,
        config: cfgFor(sameMachine, ice),
        onCandidate: (c) => sig.send({ ice: c }),
      });
      const off = sig.onRemote(async (msg) => {
        if (!msg) return;
        if (msg.type === 'answer') await p.setRemote({ type: 'answer', sdp: msg.sdp });
        else if ('ice' in msg) await p.addRemoteCandidate(msg.ice);
      });
      // Unsubscribe once the channel settles (open or fail); never let the
      // cleanup chain surface an unhandled rejection (the caller awaits the
      // original channelReady and handles its rejection).
      let opened = false;
      p.channelReady.then(() => { opened = true; off(); }, () => off());
      // why: a caller that gives up on a never-paired dial (rooms.js's connect
      // timeout) aborts to close the pc — otherwise its ICE agent / STUN gather /
      // listeners leak. Guarded on `opened`: an abort that races in after the
      // channel opened (late completion) must never tear down a live link.
      abortClosesPc(signal, p, () => opened);

      const offer = await p.pc.createOffer();
      await p.pc.setLocalDescription(offer);
      // why non-null: setLocalDescription has resolved, so localDescription is set.
      sig.send({ type: 'offer', sdp: /** @type {RTCSessionDescription} */ (p.pc.localDescription).sdp });
      return p.channelReady;
    },

    // RESPONDER. The offer already arrived (passed in); the answer +
    // candidates go back over `signaling`. Returns { channel } — a promise
    // that resolves when the data channel opens (NOT awaited here: it can't
    // open until the initiator applies our answer).
    /**
     * @param {{ offer?: { sdp?: string }, signaling?: Signaling, sameMachine?: boolean, iceServers?: RTCIceServer[], signal?: AbortSignal }} [opts]
     */
    async accept({ offer, signaling, sameMachine = false, iceServers: ice, signal } = {}) {
      requireSignaling(signaling);
      const sig = /** @type {Signaling} */ (signaling);
      const p = createPeer({
        initiator: false,
        RTCPeerConnection,
        config: cfgFor(sameMachine, ice),
        onCandidate: (c) => sig.send({ ice: c }),
      });
      const off = sig.onRemote(async (msg) => {
        if (msg && 'ice' in msg) await p.addRemoteCandidate(msg.ice);
      });
      // why: see connect() — an answered-but-stalled offer (a hostile peer that
      // relays the answer then never pairs ICE) leaks the pc; the caller's give-up
      // timeout aborts and we close it. Guarded on `opened` (late-completion safe).
      let opened = false;
      p.channelReady.then(() => { opened = true; off(); }, () => off());
      abortClosesPc(signal, p, () => opened);

      await p.setRemote({ type: 'offer', sdp: offer?.sdp });
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      // why non-null: setLocalDescription has resolved, so localDescription is set.
      sig.send({ type: 'answer', sdp: /** @type {RTCSessionDescription} */ (p.pc.localDescription).sdp });
      return { channel: p.channelReady };
    },
  };
};
