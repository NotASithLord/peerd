// @ts-check
// peerd-distributed/transport/connect.js — locality-blind connection.
//
// connect(peer) returns a uniform Channel to a peer regardless of WHERE
// that peer is. "A peer is a peer": nothing above this file branches on
// locality. The locale is discovered and handled here, then erased — the
// caller gets back a Channel and (optionally) the name of the transport
// that won, never a locality to reason about.
//
// ─────────────────────────────────────────────────────────────────────
// THE LOCALES (transports), cheapest → most general
// ─────────────────────────────────────────────────────────────────────
// `transports` is an ordered array — by convention [ inproc, broadcast,
// webrtc ]. Each is one "locale" the peer might be reachable at. connect()
// tries them in order and returns the first Channel that opens.
//
// 1. SAME JS REALM            transports/inproc.js
//    Two peers sharing one realm (two agents in one worker/page, or two
//    sessions in the service worker). Linked by an in-memory channel pair
//    through a module-level hub — no network, no ICE, ~0 latency.
//    canReach(): 1 iff the peer registered in THIS realm's hub, else 0.
//    TESTED: fully in Bun, deterministically, no browser —
//      tests/peerd-distributed/connect.test.ts          (link + gating + selection)
//      tests/peerd-distributed/transfer-over-connect.e2e.test.ts
//                                                         (a full signed
//      app transfer over connect()→inproc; proves nothing above the
//      Channel changes vs. a hand-wired pair).
//
// 2. SAME BROWSER PROFILE      transports/broadcast.js
//    Different tab/window, same origin+profile, over a shared
//    BroadcastChannel bus (logical link isolated by sessionId + did).
//    canReach(): probes with a hello/ack on a short timeout, so a stale
//    advert naming bcast still falls through if no same-profile peer answers.
//    TESTED: browser-validated (open the demo in two tabs). BroadcastChannel
//      is a browser/worker API ABSENT in Bun, where this transport degrades
//      to canReach()===0 — so the Bun suite simply skips it rather than
//      failing. It is exercised live, not in unit tests, by design.
//
// 3. SAME MACHINE / LAN / REMOTE   transports/webrtc.js
//    RTCPeerConnection + ICE. STUN and TURN are SUB-tiers inside this one
//    rung (ARCHITECTURE §6.5), not separate locales. The same-machine
//    loopback strategy (mDNS hostname → 127.0.0.1) lives inside the
//    transport (transport/sdp.js), gated on opts.sameMachine — never here.
//    Needs a signaling callback (opts.signal) to swap offer/answer.
//    TESTED:
//      • same-machine WebRTC path — verified LIVE in the browser demo
//        ("Test WebRTC transport" button) and two-window manual pairing.
//      • the pure same-machine SDP rewrite (deMdnsSdp) — unit-tested in
//        Bun (connect.test.ts).
//      • cross-NAT — needs two devices on different networks (public STUN);
//        symmetric-NAT-both-ends needs a TURN relay (Phase 1).
//      Real RTCPeerConnection can't run in Bun, so the byte-level path is
//      browser/device-verified, not unit-tested — and that's the honest
//      boundary: unit tests cover everything that ISN'T live WebRTC bytes.
//
// ─────────────────────────────────────────────────────────────────────
// HOW THE LOCALE IS ABSTRACTED AWAY
// ─────────────────────────────────────────────────────────────────────
//  • Every transport's connect() resolves to the SAME Channel shape
//    ({ send, setHandler, deliver } — transport/channel.js). session /
//    content / messaging / DHT consume that Channel and cannot tell which
//    locale carried it. Move a peer from one tab to another laptop and the
//    only thing that changes is which transport wins here.
//  • canReach(peer) → score lets a transport opt out instantly (0 → skip),
//    so unreachable locales cost nothing. (Score is currently a 0/non-0
//    GATE; preference is the array order — cheapest first. A future version
//    could sort by score; today, order is the contract.)
//  • peer.transports[] (PROTOCOL §5.2) is a HINT, not a gate — connect()
//    still probes/falls through, so a stale advert can never strand a peer.
//  • The return value { channel, transport } exposes which locale won for
//    logging/telemetry, but callers never need to read `transport`.

/**
 * One locale a peer might be reachable at. canReach() scores it (0 = skip);
 * connect() opens a Channel. Each transport ignores opts it doesn't use.
 * @typedef {{
 *   name: string,
 *   canReach?: (peer: any) => number,
 *   connect: (peer: any, opts?: any) => Promise<any> | any,
 *   timeoutMs?: number,
 * }} Transport
 */

// Bound a transport's connect() so a hung locale (e.g. WebRTC waiting on
// candidates that never pair) can't stall the whole ladder.
/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);

/** @param {{ transports: Transport[] }} deps */
export const createConnector = ({ transports }) => {
  if (!Array.isArray(transports) || transports.length === 0) {
    throw new Error('createConnector: at least one transport is required');
  }

  // Returns { channel, transport } — the open Channel and which locale won.
  // opts (e.g. { signal, sameMachine, timeoutMs }) flow to each transport's
  // connect(); transports ignore options they don't use, so the caller can
  // pass one opts bag without knowing which locale will handle it.
  /**
   * @param {any} peer
   * @param {any} [opts]
   */
  const connect = async (peer, opts = {}) => {
    /** @type {string[]} */
    const errors = [];
    // Happy-eyeballs over the locales, cheapest-first (array order).
    for (const t of transports) {
      // canReach() is the instant opt-out: inproc returns 0 unless the peer
      // is in this realm; broadcast/webrtc return a non-zero "attemptable"
      // score. A 0 here means "this locale can't be the peer" → skip free.
      const score = t.canReach ? t.canReach(peer) : 1;
      if (!score) continue;
      try {
        // First locale whose connect() opens a Channel wins. The timeout
        // keeps one slow/dead locale from blocking the fall-through to the
        // next (a WebRTC attempt that never pairs must not wedge the ladder).
        const channel = await withTimeout(
          Promise.resolve(t.connect(peer, opts)),
          opts.timeoutMs ?? t.timeoutMs ?? 5000,
          `transport ${t.name}`,
        );
        return { channel, transport: t.name };
      } catch (e) {
        // Record why this locale failed and fall through to the next. A
        // peer is only unreachable if EVERY applicable locale fails.
        errors.push(`${t.name}: ${/** @type {{ message?: string }} */ (e).message}`);
      }
    }
    throw new Error(
      `connect: no transport reached ${peer?.did ?? 'peer'} — ${errors.join(' | ') || 'none applicable'}`,
    );
  };

  return { connect };
};
