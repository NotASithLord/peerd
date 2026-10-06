// @ts-check
// peerd-distributed/transport/peer.js: one WebRTC peer connection.
//
// Wraps an RTCPeerConnection and exposes a buffered channel once the data
// channel opens. In production this runs in the OFFSCREEN DOCUMENT, never
// the service worker: the SW dies at the 30s idle timer and cannot hold
// a socket (ARCHITECTURE §8, MIGRATION §5). RTCPeerConnection is injected
// (defaults to the global) so the module stays testable.
//
// PHASE 0 ICE: default to public STUN (Cloudflare + independent fallbacks). why this is
// still "no server in the path": a STUN server is consulted ONLY during
// ICE gathering, to learn each peer's reflexive (public) candidate. It is
// NOT in the data path: once connected, bytes flow directly peer-to-peer
// and the STUN server has seen only a binding request at setup, never
// traffic. This makes cross-NAT paste-code pairing actually work (the
// reflexive candidates carry real IPs; without them Chrome emits mDNS
// `.local` host candidates that don't resolve across machines).
//
// Symmetric-NAT IPv4 on both ends with no IPv6 path does NOT connect —
// and is told so. peerd ships no TURN relay (NORTH-STAR D-5): the
// channelReady promise rejects with DirectPathUnavailableError carrying a
// candidate-type summary for both ends, which is also the field telemetry
// behind the D-5 revisit trigger. For a strict same-LAN /
// zero-external-contact run, pass `iceServers: []`.

import { createBufferedChannel } from './channel.js';
import { webRtcSessionBinding } from './channel-binding.js';
import { summarizeCandidates, DirectPathUnavailableError } from './ice.js';
import { dlog, dwarn } from '../log.js';

// A server-reflexive candidate is the ONLY cross-NAT path we have without a TURN
// relay (D-5), so we ask several INDEPENDENT operators: if one is down,
// rate-limited, or regionally blocked (Google is blocked on some networks;
// Cloudflare/Twilio aren't), another still returns a reflexive. Four operators —
// the three Google siblings share one operator and fail together, so the real
// redundancy is the distinct providers below them. (More STUN, never TURN —
// everything short of a relay to raise the connect rate. This only helps when an
// operator is unreachable; it can't fix a remote peer's symmetric NAT, which no
// STUN server of ours can see past: that stays the D-5 floor.)
export const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.relay.metered.ca:80' },     // :80 also slips past some 3478-blocking firewalls
];

// How long to let ICE 'disconnected' try to self-heal before declaring the peer
// gone. Short enough that a closed browser leaves the view fast, long enough to
// ride out a brief network blip.
const DISCONNECT_GRACE_MS = 5_000;
const MAX_DATA_CHANNEL_FRAME_BYTES = 1_000_000;

/** @param {string | ArrayBuffer | Uint8Array} data */
const decode = (data) => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
  if (bytes > MAX_DATA_CHANNEL_FRAME_BYTES) throw new Error('data-channel frame too large');
  return JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
};

/**
 * @param {{
 *   initiator?: boolean,
 *   RTCPeerConnection?: typeof RTCPeerConnection,
 *   config?: RTCConfiguration,
 *   onCandidate?: ((candidate: any) => void) | null,
 * }} [opts]
 */
export const createPeer = ({
  initiator,
  RTCPeerConnection = globalThis.RTCPeerConnection,
  config = { iceServers: DEFAULT_ICE_SERVERS },
  onCandidate = null,
} = {}) => {
  if (!RTCPeerConnection) throw new Error('createPeer: WebRTC unavailable in this context');
  // why no candidate pool: ordered trickle signaling preserves every candidate,
  // so pre-gathering only creates speculative STUN work and, when an embedding
  // app appends TURN, speculative relay allocations. `all` preserves ICE's native
  // host → server-reflexive → relay preference; max-bundle keeps one transport for
  // our single data channel. Callers can still explicitly override the policy.
  const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle', iceTransportPolicy: 'all', ...config });

  let released = false;

  // --- Trickle ICE -------------------------------------------------------
  // Surface each local candidate as it's discovered (onCandidate), and
  // apply remote candidates as they arrive: buffering any that land before
  // the remote description is set (the answer and the first candidates race
  // over the signaling channel). Trickle connects on the first working pair
  // instead of waiting for the whole STUN gather (the non-trickle stall).
  if (onCandidate) {
    pc.addEventListener('icecandidate', (e) => {
      if (!released && e.candidate) onCandidate(e.candidate.toJSON ? e.candidate.toJSON() : e.candidate);
    });
  }
  /** @type {RTCIceCandidateInit[]} */
  const pendingRemote = [];
  // why a cap: candidates that arrive before the remote description is set are
  // buffered here; a hostile peer could otherwise trickle UNBOUNDED candidate
  // frames before ever sending a description, growing this array without limit.
  // A real ICE gather is a handful of candidates; 64 is generous headroom.
  const MAX_PENDING_REMOTE = 64;
  /** @param {RTCSessionDescriptionInit} desc */
  const setRemote = async (desc) => {
    if (released) throw new Error('peer transport closed');
    await pc.setRemoteDescription(desc);
    if (released) throw new Error('peer transport closed');
    while (pendingRemote.length) {
      try { await pc.addIceCandidate(/** @type {RTCIceCandidateInit} */ (pendingRemote.shift())); }
      catch (e) { dwarn('webrtc', `addIceCandidate (flush) failed: ${/** @type {{ message?: string }} */ (e)?.message ?? e}`); }
    }
  };
  /** @param {RTCIceCandidateInit | null} candidate */
  const addRemoteCandidate = async (candidate) => {
    if (released || !candidate) return; // end-of-candidates marker: nothing to add
    if (!pc.remoteDescription) {
      if (pendingRemote.length >= MAX_PENDING_REMOTE) {
        dwarn('webrtc', 'dropping ICE candidate: pre-description buffer full');
        return;
      }
      pendingRemote.push(candidate);
      return;
    }
    try { await pc.addIceCandidate(candidate); }
    catch (e) { dwarn('webrtc', `addIceCandidate failed: ${/** @type {{ message?: string }} */ (e)?.message ?? e}`); }
  };

  /** @type {(channel: any) => void} */
  let resolveChannel;
  /** @type {(reason: any) => void} */
  let rejectChannel;
  const channelReady = new Promise((resolve, reject) => {
    resolveChannel = resolve;
    rejectChannel = reject;
  });

  // Honest failure: ICE gave up → reject with the WHY (candidate types on
  // both ends). Settled promises ignore this: only a never-opened channel
  // surfaces it.
  const failDirect = () => {
    const local = summarizeCandidates(pc.localDescription?.sdp);
    const remote = summarizeCandidates(pc.remoteDescription?.sdp);
    const llOnly = local.host6 === 0 && remote.host6 === 0 && (local.host6ll || remote.host6ll);
    const why = llOnly
      ? 'the IPv6 host candidates are LINK-LOCAL only (fe80::, don\'t route across networks) and IPv4 is symmetric-NAT: no path.'
      : 'symmetric-NAT IPv4 with no global IPv6: no path.';
    // Not an error, just a peer we can't reach directly: the no-TURN/IPv6 bet
    // (D-5) meeting an unreachable peer. Log as info (dlog), not a red dwarn —
    // the channel still rejects below and the mesh moves on. Gossip multi-hops
    // to this peer through others anyway.
    dlog('webrtc', `no direct path to this peer (expected without TURN: D-5: ${why}). `
      + `local ${JSON.stringify(local)}, remote ${JSON.stringify(remote)}`);
    rejectChannel(new DirectPathUnavailableError({ local, remote }));
  };
  /** @type {RTCDataChannel | null} */
  let activeDc = null;
  /** @type {ReturnType<typeof createBufferedChannel> | null} */
  let activeChannel = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let discoTimer = null;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(discoTimer ?? undefined);
    discoTimer = null;
    pendingRemote.length = 0;
    try { if (activeDc && activeDc.readyState !== 'closed') activeDc.close(); } catch { /* already closed */ }
    try { if (pc.connectionState !== 'closed') pc.close(); } catch { /* already closed */ }
    rejectChannel(new Error('peer transport closed before channel opened'));
    activeChannel?.signalClose();
  };
  pc.addEventListener('connectionstatechange', () => {
    if (released) return;
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      if (pc.connectionState === 'failed') failDirect();
      release();
    }
  });
  pc.addEventListener('iceconnectionstatechange', () => {
    if (released) return;
    const state = pc.iceConnectionState;
    dlog('webrtc', `ICE ${initiator ? '(initiator)' : '(responder)'} state: ${state}`);
    if (state === 'failed' || state === 'closed') {
      if (state === 'failed') failDirect();
      release();
    } else if (state === 'connected' || state === 'completed') {
      clearTimeout(discoTimer ?? undefined); discoTimer = null;
    } else if (state === 'disconnected' && !discoTimer) {
      discoTimer = setTimeout(() => {
        discoTimer = null;
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') return;
        dlog('webrtc', 'peer link idle past the grace window: closing it');
        release();
      }, DISCONNECT_GRACE_MS);
    }
  });

  /** @param {RTCDataChannel} dc */
  const wire = (dc) => {
    if (released || activeDc) { dc.close(); return; }
    activeDc = dc;
    dc.binaryType = 'arraybuffer';
    const channel = /** @type {ReturnType<typeof createBufferedChannel> & { pc?: RTCPeerConnection }} */ (
      createBufferedChannel({
        getSessionBinding: () => webRtcSessionBinding(pc, dc),
        // why guard readyState: the RTCDataChannel can be 'connecting' (a
        // send racing ahead of onopen) or 'closing'/'closed' (the remote
        // vanished: a closed tab rarely sends a clean DC close: before
        // onclose / the connection-state handlers flip the buffered channel
        // shut). dc.send() in any non-'open' state throws InvalidStateError,
        // which surfaced as an uncaught rejection in the offscreen doc.
        // Drop the datagram instead: this is best-effort mesh traffic
        // (gossip / presence / DHT) that re-gossips and multi-hops, so a
        // frame lost to a dying peer is recoverable: the throw was not.
        send: (obj) => {
          if (dc.readyState === 'open') dc.send(JSON.stringify(obj));
          else dlog('webrtc', `drop send: data channel is '${dc.readyState}', not open`);
        },
        close: release,
      })
    );
    // why exposed: path reporting (NORTH-STAR D-5 telemetry) reads the
    // selected candidate pair off the live pc; the mesh stores the channel,
    // not the peer wrapper, so the pc rides along.
    channel.pc = pc;
    activeChannel = channel;
    dc.onmessage = (e) => {
      // why try/catch: e.data is attacker-controlled bytes from a remote peer;
      // a malformed frame would otherwise throw an uncaught exception out of the
      // event handler. Best-effort mesh traffic: drop the bad frame, like the
      // outbound send already drops when the channel isn't open.
      let m;
      try { m = decode(e.data); }
      catch { dwarn('webrtc', 'dropping unparseable data-channel frame'); return; }
      channel.deliver(m);
    };
    dc.onopen = () => { if (released) return; dlog('webrtc', '🟢 data channel OPEN: peers connected directly'); resolveChannel(channel); };
    dc.onclose = release;
    // why: if the channel is already open when handlers attach (fast
    // local connect), resolve immediately.
    if (dc.readyState === 'open') resolveChannel(channel);
    return channel;
  };

  if (initiator) wire(pc.createDataChannel('peerd', { ordered: true }));
  else pc.ondatachannel = (e) => wire(e.channel);

  return { pc, channelReady, setRemote, addRemoteCandidate, close: release };
};

// Resolve once ICE candidate gathering finishes, so a non-trickle
// (copy-paste) SDP carries all candidates inline.
/** @param {RTCPeerConnection} pc */
export const localDescriptionComplete = (pc) =>
  /** @type {Promise<void>} */ (new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
  }));
