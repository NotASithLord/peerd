// peerd-distributed/transport/peer.js — one WebRTC peer connection.
//
// Wraps an RTCPeerConnection and exposes a buffered channel once the data
// channel opens. In production this runs in the OFFSCREEN DOCUMENT, never
// the service worker — the SW dies at the 30s idle timer and cannot hold
// a socket (ARCHITECTURE §8, MIGRATION §5). RTCPeerConnection is injected
// (defaults to the global) so the module stays testable.
//
// PHASE 0 ICE: default to public STUN (Google + Cloudflare). why this is
// still "no server in the path": a STUN server is consulted ONLY during
// ICE gathering, to learn each peer's reflexive (public) candidate. It is
// NOT in the data path — once connected, bytes flow directly peer-to-peer
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
// STUN server of ours can see past — that stays the D-5 floor.)
export const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.relay.metered.ca:80' },     // :80 also slips past some 3478-blocking firewalls
];

// How long to let ICE 'disconnected' try to self-heal before declaring the peer
// gone. Short enough that a closed browser leaves the view fast, long enough to
// ride out a brief network blip.
const DISCONNECT_GRACE_MS = 5_000;

const decode = (data) =>
  JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));

export const createPeer = ({
  initiator,
  RTCPeerConnection = globalThis.RTCPeerConnection,
  config = { iceServers: DEFAULT_ICE_SERVERS },
  onCandidate = null,
} = {}) => {
  if (!RTCPeerConnection) throw new Error('createPeer: WebRTC unavailable in this context');
  // iceCandidatePoolSize warms the gather at construction, so the reflexive
  // candidate is usually ready by the time we offer instead of racing it (the
  // window where only mDNS/host candidates exist). max-bundle = one transport for
  // our single data channel = fewer pairs to check. Both squeeze ICE without TURN.
  const pc = new RTCPeerConnection({ iceCandidatePoolSize: 4, bundlePolicy: 'max-bundle', ...config });

  // --- Trickle ICE -------------------------------------------------------
  // Surface each local candidate as it's discovered (onCandidate), and
  // apply remote candidates as they arrive — buffering any that land before
  // the remote description is set (the answer and the first candidates race
  // over the signaling channel). Trickle connects on the first working pair
  // instead of waiting for the whole STUN gather (the non-trickle stall).
  if (onCandidate) {
    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) onCandidate(e.candidate.toJSON ? e.candidate.toJSON() : e.candidate);
    });
  }
  const pendingRemote = [];
  const setRemote = async (desc) => {
    await pc.setRemoteDescription(desc);
    while (pendingRemote.length) {
      try { await pc.addIceCandidate(pendingRemote.shift()); }
      catch (e) { dwarn('webrtc', `addIceCandidate (flush) failed: ${e?.message ?? e}`); }
    }
  };
  const addRemoteCandidate = async (candidate) => {
    if (!candidate) return; // end-of-candidates marker — nothing to add
    if (!pc.remoteDescription) { pendingRemote.push(candidate); return; }
    try { await pc.addIceCandidate(candidate); }
    catch (e) { dwarn('webrtc', `addIceCandidate failed: ${e?.message ?? e}`); }
  };

  let resolveChannel;
  let rejectChannel;
  const channelReady = new Promise((resolve, reject) => {
    resolveChannel = resolve;
    rejectChannel = reject;
  });

  // Honest failure: ICE gave up → reject with the WHY (candidate types on
  // both ends). Settled promises ignore this — only a never-opened channel
  // surfaces it.
  const failDirect = () => {
    const local = summarizeCandidates(pc.localDescription?.sdp);
    const remote = summarizeCandidates(pc.remoteDescription?.sdp);
    const llOnly = local.host6 === 0 && remote.host6 === 0 && (local.host6ll || remote.host6ll);
    const why = llOnly
      ? 'the IPv6 host candidates are LINK-LOCAL only (fe80::, don\'t route across networks) and IPv4 is symmetric-NAT — no path.'
      : 'symmetric-NAT IPv4 with no global IPv6 — no path.';
    // Not an error, just a peer we can't reach directly: the no-TURN/IPv6 bet
    // (D-5) meeting an unreachable peer. Log as info (dlog), not a red dwarn —
    // the channel still rejects below and the mesh moves on. Gossip multi-hops
    // to this peer through others anyway.
    dlog('webrtc', `no direct path to this peer (expected without TURN — D-5: ${why}). `
      + `local ${JSON.stringify(local)}, remote ${JSON.stringify(remote)}`);
    rejectChannel(new DirectPathUnavailableError({ local, remote }));
  };
  pc.addEventListener('iceconnectionstatechange', () => {
    // The single most useful line for "stuck connecting": checking →
    // connected (win) or → failed (no path). disconnected can self-heal.
    dlog('webrtc', `ICE ${initiator ? '(initiator)' : '(responder)'} state: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed') failDirect();
  });

  const wire = (dc) => {
    dc.binaryType = 'arraybuffer';
    const channel = createBufferedChannel({
      send: (obj) => dc.send(JSON.stringify(obj)),
      close: () => {
        try { dc.close(); } catch { /* already closed */ }
        try { pc.close(); } catch { /* already closed */ }
      },
    });
    // why exposed: path reporting (NORTH-STAR D-5 telemetry) reads the
    // selected candidate pair off the live pc; the mesh stores the channel,
    // not the peer wrapper, so the pc rides along.
    channel.pc = pc;
    dc.onmessage = (e) => channel.deliver(decode(e.data));
    dc.onopen = () => { dlog('webrtc', '🟢 data channel OPEN — peers connected directly'); resolveChannel(channel); };
    dc.onclose = () => channel.signalClose();
    pc.addEventListener('connectionstatechange', () => {
      // 'disconnected' can self-heal; 'failed'/'closed' cannot.
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (pc.connectionState === 'failed') failDirect();
        channel.signalClose();
      }
    });
    // Faster disconnect detection (a closed tab/browser often does NOT send a
    // clean DC close — the page just vanishes). ICE 'disconnected' is the EARLY
    // warning, well before 'failed' (~30s of consent timeout). It can self-heal,
    // so we give it a short grace; if it hasn't recovered, drop the link now so
    // the peer leaves the view in seconds, not half a minute.
    let discoTimer = null;
    pc.addEventListener('iceconnectionstatechange', () => {
      const s = pc.iceConnectionState;
      if (s === 'connected' || s === 'completed') { clearTimeout(discoTimer); discoTimer = null; }
      else if (s === 'disconnected' && !discoTimer) {
        discoTimer = setTimeout(() => {
          const live = pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
          if (!live) { dlog('webrtc', 'peer link idle past the grace window — closing it'); channel.signalClose(); }
        }, DISCONNECT_GRACE_MS);
      } else if (s === 'failed' || s === 'closed') { clearTimeout(discoTimer); discoTimer = null; channel.signalClose(); }
    });
    // why: if the channel is already open when handlers attach (fast
    // local connect), resolve immediately.
    if (dc.readyState === 'open') resolveChannel(channel);
    return channel;
  };

  if (initiator) wire(pc.createDataChannel('peerd', { ordered: true }));
  else pc.ondatachannel = (e) => wire(e.channel);

  return { pc, channelReady, setRemote, addRemoteCandidate };
};

// Resolve once ICE candidate gathering finishes, so a non-trickle
// (copy-paste) SDP carries all candidates inline.
export const localDescriptionComplete = (pc) =>
  new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
  });
