// @ts-check
// A device-authenticated transport for private self-device rendezvous rooms.
//
// The public base network is authenticated as the person's root DID. That is
// deliberately the wrong identity for device admission: two installations of
// one person would collide as the same peer, and a certificate received over
// that link could not be bound to its device key. Self-device rooms therefore
// use the existing room transport with the installation's device identity.

import { joinRoom } from '../transport/rooms.js';

const SELF_DIRECT_CHANNEL = 3;
const SELF_DIRECT_TYPE = 1;

/**
 * @param {Object} deps
 * @param {{ did: string, sign: (bytes: Uint8Array) => Promise<Uint8Array> }} deps.deviceIdentity
 * @param {string} [deps.url]
 * @param {any[]} [deps.iceServers]
 * @param {any} [deps.transport]
 * @param {any} [deps.WebSocket]
 * @param {any} [deps.RTCPeerConnection]
 * @param {() => number} [deps.now]
 * @param {any} [deps.audit]
 */
export const createSelfDeviceMesh = ({
  deviceIdentity, url, iceServers, transport, WebSocket, RTCPeerConnection,
  now = Date.now, audit = null,
}) => Object.freeze({
  did: deviceIdentity.did,

  /** @param {string} roomId */
  async openRoom(roomId) {
    const joined = await joinRoom({
      roomId, identity: deviceIdentity, url, iceServers, transport,
      WebSocket, RTCPeerConnection, now, audit,
      caps: ['self-device'],
    });
    /** @type {Set<(arg: { from: string, data: any }) => void>} */
    const messageCbs = new Set();
    const offEnvelope = joined.onEnvelope(({ env }) => {
      if (env.ch !== SELF_DIRECT_CHANNEL || env.typ !== SELF_DIRECT_TYPE) return;
      for (const cb of [...messageCbs]) cb({ from: env.from, data: env.body?.data });
    });
    let left = false;

    return Object.freeze({
      roomId,
      direct: {
        /** @param {string} toDid @param {any} data */
        async send(toDid, data) {
          const env = await joined.mesh.sign(SELF_DIRECT_CHANNEL, SELF_DIRECT_TYPE, { data });
          if (!joined.mesh.send(toDid, env)) throw new Error('self-device link is unavailable');
          return true;
        },
        /** @param {(arg: { from: string, data: any }) => void} cb */
        onMessage(cb) { messageCbs.add(cb); return () => messageCbs.delete(cb); },
      },
      onPeer: joined.onPeer,
      onPeerGone: joined.onPeerGone,
      peers: () => joined.peers().map((peer) => peer.did),
      leave() {
        if (left) return;
        left = true;
        offEnvelope();
        messageCbs.clear();
        joined.leave();
      },
    });
  },
});
