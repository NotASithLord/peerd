// @ts-check
// peerd-distributed/self/handshake.js, mutual same-person authentication.
//
// A rendezvous topic yields CANDIDATES, never trust. Before a link may be
// treated as "one of my own devices", BOTH sides must prove, freshly:
//
//   1. a device certificate signed by the SAME person root I belong to, and
//   2. possession of that certificate's device private key, by signing a
//      challenge bound to this exact link.
//
// Two devices merely claiming the same did are strangers (issue invariant
// 4); a certificate without its key is paper (5); a key without a
// certificate is anonymous (6). The mesh HELLO already proved which device
// key is on the other end of the link, but a HELLO is not challenge-fresh,
// so this layer adds nonces both ways and binds every proof to:
//
//   protocol version + domain    (no cross-protocol replay: these bytes can
//                                 never verify as an envelope, cert, DHT
//                                 item, or manifest, different domain tag)
//   the room id                  (session context)
//   both device dids, role-tagged (a reflected proof names the wrong signer)
//   both nonces                  (fresh both ways; a recorded proof dies
//                                 with its nonce)
//
// Pure protocol steps over injected sign/verify. Transport, timers, and
// what "marked self-device" unlocks (sync.js) belong to the host.

import { canonicalize } from '/shared/bundle/canonical.js';
import { utf8, concat, toBase64, fromBase64 } from '/shared/bundle/bytes.js';
import { verifySignature } from '../identity/keypair.js';
import {
  verifyDeviceCertificate, deviceStatusInRoster,
} from '../identity/device-certificate.js';

export const SELF_AUTH_DOMAIN = 'peerd/self-device-auth/v1';
export const SELF_AUTH_PROTO = 1;
export const AUTH_NONCE_BYTES = 32;

const MAX_NONCE_B64 = 64;

/**
 * @typedef {import('../identity/device-certificate.js').DeviceCertificate} DeviceCertificate
 * @typedef {import('../identity/device-certificate.js').DeviceRoster} DeviceRoster
 */

/** Mint the fresh challenge half of an AUTH_HELLO. */
export const mintAuthNonce = () =>
  toBase64(crypto.getRandomValues(new Uint8Array(AUTH_NONCE_BYTES)));

/**
 * The opening message: my certificate and my challenge to you.
 *
 * @param {{ cert: DeviceCertificate, nonce: string, roster?: DeviceRoster }} args
 */
export const buildAuthHello = ({ cert, nonce, roster }) => ({
  t: 'AUTH_HELLO',
  proto: SELF_AUTH_PROTO,
  cert,
  nonce,
  ...(roster ? { roster } : {}),
});

/**
 * Evaluate a peer's AUTH_HELLO. The certificate must verify under MY person
 * root and must name exactly the device key the mesh link authenticated
 * a valid certificate for some OTHER key, relayed over this link, is an
 * impersonation attempt and dies here.
 *
 * @param {any} hello
 * @param {Object} context
 * @param {string} context.personDid      MY person root did
 * @param {string} context.selfDeviceDid  MY device did
 * @param {string} context.linkDeviceDid  the did the mesh HELLO proved for
 *        this link: the only binding between "a cert arrived" and "the
 *        sender holds its key" pre-proof
 * @param {DeviceRoster | null} [context.roster]  newest local roster, if held
 * @returns {Promise<{ ok: boolean, defect: string | null, peerCert: DeviceCertificate | null }>}
 */
export const evaluateAuthHello = async (hello, {
  personDid, selfDeviceDid, linkDeviceDid, roster = null,
}) => {
  /** @param {string} defect */
  const refuse = (defect) => ({ ok: false, defect, peerCert: null });
  if (!hello || typeof hello !== 'object' || hello.t !== 'AUTH_HELLO') return refuse('not-auth-hello');
  if (hello.proto !== SELF_AUTH_PROTO) return refuse('unsupported-proto');
  if (typeof hello.nonce !== 'string' || hello.nonce.length === 0
      || hello.nonce.length > MAX_NONCE_B64) return refuse('bad-nonce');
  try {
    if (fromBase64(hello.nonce).length !== AUTH_NONCE_BYTES) return refuse('bad-nonce');
  } catch {
    return refuse('bad-nonce');
  }
  const verdict = await verifyDeviceCertificate(hello.cert, {
    expectedPersonDid: personDid,
    expectedDeviceDid: linkDeviceDid,
  });
  if (!verdict.ok) return refuse(`cert-${verdict.defect}`);
  if (hello.cert.deviceDid === selfDeviceDid) return refuse('self-connection');
  const standing = deviceStatusInRoster(roster, hello.cert.deviceDid);
  // Fail closed. A certificate proves that the root signed a key at some
  // point; the current roster is the authority for whether that key may act
  // now. Accepting `unknown` lets any holder of the portable root bypass a
  // revocation by minting a fresh device key and certificate.
  if (standing !== 'active') {
    return refuse(standing === 'revoked' ? 'device-revoked' : 'device-not-active');
  }
  return { ok: true, defect: null, peerCert: hello.cert };
};

/**
 * The bytes a device signs to prove possession. Role-tagged: `prover` is
 * always the signer, `verifier` the challenger, so a proof reflected back
 * at its author names the wrong prover and cannot verify.
 *
 * @param {Object} args
 * @param {string} args.roomId          the rendezvous room this link lives in
 * @param {string} args.proverDeviceDid
 * @param {string} args.verifierDeviceDid
 * @param {string} args.proverNonce     base64: the nonce the prover sent
 * @param {string} args.verifierNonce   base64: the challenge being answered
 */
export const proofSigningBytes = ({
  roomId, proverDeviceDid, verifierDeviceDid, proverNonce, verifierNonce,
}) => concat(utf8(SELF_AUTH_DOMAIN), Uint8Array.from([0]), utf8(canonicalize({
  proto: SELF_AUTH_PROTO,
  room: roomId,
  prover: proverDeviceDid,
  verifier: verifierDeviceDid,
  proverNonce,
  verifierNonce,
})));

/**
 * Answer the peer's challenge with my device key.
 *
 * @param {Object} args
 * @param {(bytes: Uint8Array) => Promise<Uint8Array>} args.deviceSign
 * @param {string} args.roomId
 * @param {string} args.selfDeviceDid
 * @param {string} args.peerDeviceDid
 * @param {string} args.selfNonce  the nonce I sent in MY hello
 * @param {string} args.peerNonce  the challenge from THEIR hello
 */
export const buildAuthProof = async ({
  deviceSign, roomId, selfDeviceDid, peerDeviceDid, selfNonce, peerNonce,
}) => ({
  t: 'AUTH_PROOF',
  proto: SELF_AUTH_PROTO,
  sig: toBase64(await deviceSign(proofSigningBytes({
    roomId,
    proverDeviceDid: selfDeviceDid,
    verifierDeviceDid: peerDeviceDid,
    proverNonce: selfNonce,
    verifierNonce: peerNonce,
  }))),
});

/**
 * Verify the peer's proof against the challenge I issued. Only after BOTH
 * directions pass may the host mark the link `self-device`.
 *
 * @param {any} proof
 * @param {Object} context
 * @param {string} context.roomId
 * @param {string} context.peerDeviceDid  the prover
 * @param {string} context.selfDeviceDid  me, the verifier
 * @param {string} context.peerNonce      the nonce THEY sent in their hello
 * @param {string} context.selfNonce      the challenge I issued
 * @returns {Promise<{ ok: boolean, defect: string | null }>}
 */
export const verifyAuthProof = async (proof, {
  roomId, peerDeviceDid, selfDeviceDid, peerNonce, selfNonce,
}) => {
  if (!proof || typeof proof !== 'object' || proof.t !== 'AUTH_PROOF') {
    return { ok: false, defect: 'not-auth-proof' };
  }
  if (proof.proto !== SELF_AUTH_PROTO) return { ok: false, defect: 'unsupported-proto' };
  if (typeof proof.sig !== 'string' || proof.sig.length === 0 || proof.sig.length > 128) {
    return { ok: false, defect: 'bad-sig' };
  }
  const bytes = proofSigningBytes({
    roomId,
    proverDeviceDid: peerDeviceDid,
    verifierDeviceDid: selfDeviceDid,
    proverNonce: peerNonce,
    verifierNonce: selfNonce,
  });
  let verified = false;
  try {
    verified = await verifySignature(peerDeviceDid, fromBase64(proof.sig), bytes);
  } catch {
    return { ok: false, defect: 'bad-sig' };
  }
  return verified ? { ok: true, defect: null } : { ok: false, defect: 'signature-invalid' };
};
