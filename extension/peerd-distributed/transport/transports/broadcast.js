// @ts-check
// peerd-distributed/transport/transports/broadcast.js — same-profile transport.
//
// Cross-tab / cross-window peers in the SAME browser profile and origin,
// via a shared BroadcastChannel bus. Cheaper than WebRTC (no ICE) and the
// right transport for "two peerd tabs coordinating." All peers share one
// bus; a logical link is isolated by (sessionId, to/from did).
//
// why a transport, not a special case: behind the uniform connect()
// selector this is just another rung — connect() probes it (a brief
// hello/ack) and falls through to WebRTC if no same-profile peer answers.
// Browser-validated (BroadcastChannel is a browser/worker API); Bun tests
// cover inproc + the selector instead.

import { createBufferedChannel } from '../channel.js';

/**
 * @typedef {ReturnType<typeof createBufferedChannel>} Channel
 * @typedef {(channel: Channel) => void} OnInbound
 * @typedef {{ did: string }} Peer
 */

const newId = () => crypto.randomUUID();

/**
 * @param {{ busName?: string, BroadcastChannel?: typeof BroadcastChannel }} [opts]
 */
export const createBroadcastTransport = ({
  busName = 'peerd/transport/v1',
  BroadcastChannel: BC = globalThis.BroadcastChannel,
} = {}) => {
  // Degrade gracefully where BroadcastChannel is absent (e.g. some test
  // runtimes): the selector just skips this transport.
  if (!BC) {
    return {
      name: 'broadcast',
      canReach: () => 0,
      async connect() {
        throw new Error('broadcast: BroadcastChannel unavailable in this context');
      },
    };
  }

  const bus = new BC(busName);
  /** @type {Map<string, Channel>} */
  const links = new Map(); // sid -> buffered channel
  /** @type {string | null} */
  let selfDid = null;
  /** @type {OnInbound | null} */
  let onInboundCb = null;

  /** @param {string} sid @param {string} peerDid */
  const makeLink = (sid, peerDid) => {
    const ch = createBufferedChannel({
      send: (msg) => bus.postMessage({ t: 'data', sid, to: peerDid, from: selfDid, msg }),
    });
    links.set(sid, ch);
    return ch;
  };

  bus.onmessage = (e) => {
    const m = e.data;
    if (!m || m.to !== selfDid) return;
    if (m.t === 'hello' && onInboundCb) {
      const ch = makeLink(m.sid, m.from);
      bus.postMessage({ t: 'ack', sid: m.sid, to: m.from, from: selfDid });
      onInboundCb(ch);
    } else if (m.t === 'data') {
      links.get(m.sid)?.deliver(m.msg);
    }
    // 'ack' is handled by a temporary listener inside connect()
  };

  return {
    name: 'broadcast',

    /** @param {string} did @param {OnInbound} onInbound */
    listen(did, onInbound) {
      selfDid = did;
      onInboundCb = onInbound;
      return () => {
        onInboundCb = null;
      };
    },

    /** @param {Peer} peer */
    canReach(peer) {
      // Can attempt for any did; real reachability is resolved by the
      // hello/ack probe inside connect().
      return peer?.did && selfDid ? 0.7 : 0;
    },

    /**
     * @param {Peer} peer
     * @param {{ timeoutMs?: number }} [opts]
     * @returns {Promise<Channel>}
     */
    async connect(peer, { timeoutMs = 400 } = {}) {
      if (!selfDid) throw new Error('broadcast: call listen(selfDid, …) before connect');
      const sid = newId();
      const to = peer.did;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          bus.removeEventListener('message', onAck);
          reject(new Error('broadcast: no same-profile peer answered'));
        }, timeoutMs);
        /** @param {MessageEvent} e */
        const onAck = (e) => {
          const m = e.data;
          if (m && m.t === 'ack' && m.sid === sid && m.to === selfDid) {
            clearTimeout(timer);
            bus.removeEventListener('message', onAck);
            resolve(makeLink(sid, to));
          }
        };
        bus.addEventListener('message', onAck);
        bus.postMessage({ t: 'hello', sid, to, from: selfDid });
      });
    },
  };
};
