// peerd-distributed/messaging/direct.js — direct (1:1) messages (ch=3).
//
// PROTOCOL §6.1. A direct message goes to exactly ONE recipient over the
// direct mesh link (mesh.send), on ch=3 — a channel the mesh NEVER forwards.
// Only ch=0 RELAY frames hop; for every other channel mesh.handle() requires
// `env.from === link.did`, so a ch=3 frame is structurally un-relayable: a
// peer can only deliver one it signed itself, straight to a neighbor. So,
// unlike gossip (ch=4, a room-wide flood), a direct message:
//   - reaches ONLY the recipient — no broadcast, no relay, no third peer
//     ever sees the bytes;
//   - rides the recipient's WebRTC data channel, which is DTLS-encrypted in
//     transit (no on-path eavesdropper);
//   - is authenticated — the signed envelope's `from` is the sender, and the
//     mesh already proved that `from` is the neighbor that actually sent it.
//
// That makes ONLINE 1:1 chat private at the ROUTING layer with no E2E seal:
// the message simply never leaves the two endpoints. The X25519 SealedBox
// (§6.1's `sealed`) earns its keep only for store-and-forward THROUGH a relay
// (§6.2) — a deliberate next step, where a third party holds the ciphertext.
// Until then `data` rides as an opaque, signed-but-unsealed body (D-7), the
// same shape gossip uses. why no dedup/seen-cache: there is no flood, so a
// frame arrives exactly once over its single link.

const MSG = 0; // ch=3 typ — a direct message (PROTOCOL §6.1)

/** @param {{ mesh: any }} opts */
export const createDirect = ({ mesh }) => {
  const subs = new Set();

  const off = mesh.onEnvelope(({ env }) => {
    if (env.ch !== 3 || env.typ !== MSG || !env.body) return;
    // mesh.handle already enforced env.from === link.did for ch≠4, so `from`
    // is the authenticated neighbour that sent this — no relay laundering.
    const msg = { from: env.from, data: env.body.data, ts: env.ts, id: env.id };
    for (const cb of [...subs]) cb(msg);
  });

  return Object.freeze({
    // Send `data` to ONE recipient over their direct link. Rejects when no
    // live link exists (the recipient isn't a directly-connected peer):
    // honest failure now, store-and-forward to offline peers is §6.2's job.
    async send(toDid, data) {
      const env = await mesh.sign(3, MSG, { data });
      if (!mesh.send(toDid, env)) throw new Error(`no direct link to ${(toDid || '').slice(-8)}`);
      return { id: env.id, ts: env.ts };
    },
    onMessage(cb) { subs.add(cb); return () => subs.delete(cb); },
    close() { off(); subs.clear(); },
  });
};
