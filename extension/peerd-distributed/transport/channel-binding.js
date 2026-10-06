// @ts-check
// Session proofs bind identity to the transport that actually carries them.
// Never synthesize a network binding from peer-supplied handshake fields.

/** @typedef {{kind:'webrtc-dtls-sha256'|'trusted-local',localFingerprint:string,remoteFingerprint:string,streamId:number}} SessionBinding */

/** @param {string | undefined} sdp */
const fingerprint = (sdp) => {
  const values = new Set();
  for (const raw of String(sdp ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^a=fingerprint(?:[:\s]|$)/i.test(line)) continue;
    const match = /^a=fingerprint:sha-256 ((?:[0-9a-f]{2}:){31}[0-9a-f]{2})$/i.exec(line);
    // Refuse alternate algorithms too: accepting a SHA-256 claim while DTLS
    // matches a different advertised fingerprint would not bind that claim.
    if (!match) throw new Error('session binding requires only valid SHA-256 fingerprints');
    values.add(match[1].replaceAll(':', '').toLowerCase());
  }
  // peerd creates data-only peer connections. Conflicting session/media-level
  // fingerprints are refused instead of guessing which DTLS transport won.
  if (values.size !== 1) throw new Error('session binding requires one unambiguous SHA-256 fingerprint');
  return /** @type {string} */ ([...values][0]);
};

/**
 * An open RTCDataChannel has completed DTLS certificate validation. Bind the
 * verified SDP fingerprints in endpoint order and the negotiated SCTP stream;
 * a proof forwarded between independently terminated DTLS pipes cannot match.
 * @param {{localDescription?:{sdp?:string}|null,remoteDescription?:{sdp?:string}|null}} pc
 * @param {{readyState:string,id:number|null}} dc
 * @returns {Readonly<SessionBinding>}
 */
export const webRtcSessionBinding = (pc, dc) => {
  if (dc.readyState !== 'open' || !Number.isInteger(dc.id) || dc.id === null || dc.id < 0 || dc.id > 65534) {
    throw new Error('session binding requires an open negotiated data channel');
  }
  return Object.freeze({
    kind: 'webrtc-dtls-sha256',
    localFingerprint: fingerprint(pc.localDescription?.sdp),
    remoteFingerprint: fingerprint(pc.remoteDescription?.sdp),
    streamId: dc.id,
  });
};

/** Same-realm channels have no untrusted intermediary. Pair tokens are local
 * capabilities, never selected by a remote network message.
 * @returns {[Readonly<SessionBinding>, Readonly<SessionBinding>]}
 */
export const localSessionBindings = () => {
  const token = () => [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const localFingerprint = token();
  const remoteFingerprint = token();
  return [
    Object.freeze({ kind: 'trusted-local', localFingerprint, remoteFingerprint, streamId: 0 }),
    Object.freeze({ kind: 'trusted-local', localFingerprint: remoteFingerprint, remoteFingerprint: localFingerprint, streamId: 0 }),
  ];
};
