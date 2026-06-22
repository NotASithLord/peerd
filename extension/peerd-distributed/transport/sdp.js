// @ts-check
// peerd-distributed/transport/sdp.js — SDP munging helpers.
//
// why: Chrome replaces local-IP host candidates with a privacy mDNS
// `<uuid>.local` hostname that requires multicast-DNS resolution — which
// many networks, VPNs, and managed Chrome profiles silently block. When
// the WebRTC transport KNOWS both peers are on the same machine, it
// rewrites that hostname to loopback so the two connect over 127.0.0.1
// with no mDNS/STUN/hairpin dependency. This lives in the transport, not
// in any caller — locality handling never leaks above transport.

/** @param {string} sdp */
export const deMdnsSdp = (sdp) => sdp.replace(/[0-9a-f-]+\.local/gi, '127.0.0.1');
