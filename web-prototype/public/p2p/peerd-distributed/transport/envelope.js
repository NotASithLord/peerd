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

const DOMAIN = 'peerd/envelope/v1';

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

export const signEnvelope = async (env, identity) => {
  const sig = await identity.sign(signingBytes(env));
  return { ...env, sig: toBase64(sig) };
};

export const verifyEnvelope = async (env) => {
  if (!env || !env.sig || !env.from) return false;
  try {
    return await verifySignature(env.from, fromBase64(env.sig), signingBytes(env));
  } catch {
    return false;
  }
};
