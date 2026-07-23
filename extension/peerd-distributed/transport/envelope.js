// @ts-check
// peerd-distributed/transport/envelope.js — signed wire frame (PROTOCOL §3).
//
// Every control frame that crosses a peer boundary is an Ed25519-signed
// envelope. why: the data channel's DTLS protects the hop, but it does
// not tell you WHO is on the other end. A signed envelope binds each
// frame to a did:key, so the receiver can authenticate the peer and
// reject forgeries. (Phase 0 signs the HELLO handshake; bulk chunk
// transfer relies on the signed manifest's hash commitment for integrity,
// PROTOCOL §4.3.)
//
// Signing payload: `"peerd/envelope/v1" || 0x00 || JCS(env without sig)`.

import { canonicalize } from '/shared/bundle/canonical.js';
import { utf8, concat, toBase64, fromBase64 } from '/shared/bundle/bytes.js';
import { verifySignature } from '../identity/keypair.js';

/**
 * A signed wire frame. `sig` rides on a signed envelope; the rest is what
 * the signature commits to. Body is opaque to this layer.
 * @typedef {{ v: number, ch: number, typ: number, from: string, body: any, id: string, ts: number, sig?: string }} Envelope
 */

const DOMAIN = 'peerd/envelope/v1';

/** @param {Envelope} env */
const signingBytes = (env) => {
  const { sig, ...rest } = env;
  return concat(utf8(DOMAIN), Uint8Array.from([0]), utf8(canonicalize(rest)));
};

/**
 * Build an (unsigned) envelope. `from` is the signer's did:key — the
 * caller stamps it (transport/session.js passes `identity.did`).
 *
 * @param {{ ch: number, typ: number, from: string, body: any, id: string, ts: number }} frame
 *   ch: logical channel (PROTOCOL §3.2). typ: type within channel.
 */
export const buildEnvelope = ({ ch, typ, from, body, id, ts }) => ({
  v: 1,
  ch,
  typ,
  from,
  body,
  id,
  ts,
});

/**
 * @param {Envelope} env
 * @param {{ sign: (bytes: Uint8Array) => Promise<Uint8Array> }} identity — any signer (the env only needs sign())
 */
export const signEnvelope = async (env, identity) => {
  const sig = await identity.sign(signingBytes(env));
  return { ...env, sig: toBase64(sig) };
};

/**
 * Wire size of a frame, in bytes — what forwarding it costs the room.
 * Measured on the canonical (JCS) form so every peer computes the SAME
 * number for the same frame; that's the identical serialization the
 * signature commits to above, so the size is as unforgeable as the sig.
 *
 * why Infinity instead of throwing on unserializable input: callers use
 * this to decide whether to relay, and a frame we cannot measure is a
 * frame we must not forward — `Infinity > cap` says exactly that without
 * making every call site carry a try/catch. Unreachable in practice:
 * canonicalize is also what signs, so an unserializable frame could
 * never carry a valid signature and verifyEnvelope drops it first.
 *
 * @param {unknown} env
 * @returns {number}
 */
export const envelopeBytes = (env) => {
  try {
    return utf8(canonicalize(env)).length;
  } catch {
    return Infinity;
  }
};

/** @param {unknown} env — a wire-decoded frame (validated below) */
export const verifyEnvelope = async (env) => {
  if (!env || typeof env !== 'object') return false;
  const e = /** @type {Envelope} */ (env);
  if (!e.sig || !e.from) return false;
  try {
    return await verifySignature(e.from, fromBase64(e.sig), signingBytes(e));
  } catch {
    return false;
  }
};
