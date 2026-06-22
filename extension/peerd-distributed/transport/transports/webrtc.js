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
     * @param {{ signaling?: Signaling, sameMachine?: boolean, iceServers?: RTCIceServer[] }} [opts]
     */
    async connect(peer, { signaling, sameMachine = false, iceServers: ice } = {}) {
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
      p.channelReady.then(() => off(), () => off());

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
     * @param {{ offer?: { sdp?: string }, signaling?: Signaling, sameMachine?: boolean, iceServers?: RTCIceServer[] }} [opts]
     */
    async accept({ offer, signaling, sameMachine = false, iceServers: ice } = {}) {
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
      p.channelReady.then(() => off(), () => off());

      await p.setRemote({ type: 'offer', sdp: offer?.sdp });
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      // why non-null: setLocalDescription has resolved, so localDescription is set.
      sig.send({ type: 'answer', sdp: /** @type {RTCSessionDescription} */ (p.pc.localDescription).sdp });
      return { channel: p.channelReady };
    },
  };
};
