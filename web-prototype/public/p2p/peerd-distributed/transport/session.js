// peerd-distributed/transport/session.js — the HELLO handshake.
//
// On channel open, both peers exchange signed HELLO envelopes (control
// channel, PROTOCOL §3.4). Each verifies the other's signature, learning
// the peer's authenticated did:key. After the handshake the channel is
// handed back clean for the application protocol (content transfer in
// Phase 0). why: this is where a raw DTLS pipe becomes an *identified*
// peer link — the foundation every trust-tier decision builds on.

import { buildEnvelope, signEnvelope, verifyEnvelope } from './envelope.js';

const newId = () => crypto.randomUUID();

// Returns { remoteDid }. Throws if the peer's HELLO fails verification or
// speaks an unsupported protocol version.
export const createSession = async ({ channel, identity, caps = ['content'], now = Date.now }) => {
  let resolveHello;
  let rejectHello;
  const helloReceived = new Promise((res, rej) => {
    resolveHello = res;
    rejectHello = rej;
  });

  // While handshaking, only HELLO is expected. Any non-HELLO frame that
  // races in is stashed and re-delivered after we hand the channel back,
  // so an eager content request is never dropped.
  const stashed = [];
  channel.setHandler(async (msg) => {
    if (msg && msg.__t === 'HELLO') {
      const ok = await verifyEnvelope(msg.env);
      if (!ok) return rejectHello(new Error('peer HELLO signature invalid'));
      if (msg.env.body?.proto !== 1) {
        return rejectHello(new Error(`unsupported protocol version: ${msg.env.body?.proto}`));
      }
      return resolveHello(msg.env.from);
    }
    stashed.push(msg);
  });

  const hello = await signEnvelope(
    buildEnvelope({ ch: 0, typ: 0, from: identity.did, body: { proto: 1, caps }, id: newId(), ts: now() }),
    identity,
  );
  channel.send({ __t: 'HELLO', env: hello });

  const remoteDid = await helloReceived;
  channel.setHandler(null);
  // Re-queue anything that arrived during the handshake so the next
  // handler (the content responder) sees it in order.
  for (const m of stashed) channel.deliver(m);
  return { remoteDid };
};
