# peerd signaling node

The cold-start rendezvous server for peerd-distributed. Two peers that
have no existing connection meet here to swap WebRTC offer/answer, then
talk directly — the node only relays opaque SDP and forgets them. It is
the *only* server-shaped component in peerd, and even it is just peerd's
own code in a non-browser shell.

## One reducer, many shells

All three of these run the **same** pure reducer —
`extension/peerd-distributed/transport/signaling.js` (`signalingStep`):

| Shell | File | Role | Runs where |
|---|---|---|---|
| Browser client | `transport/signaling-client.js` | dials in, does the offer/answer dance | the peerd extension / a demo page |
| Bun host | `bun-server.mjs` | binds a WebSocket, relays | any machine with Bun (no cloud account) |
| CF Worker + DO | `worker.js` + `wrangler.jsonc` | same, on the edge | Cloudflare (BYOC) |

There is no second implementation of the signaling protocol to drift or
re-audit. A shell is just socket plumbing that feeds the reducer events
(`join` / `signal` / `leave`) and runs its actions (`send` / `close`).

## Run it

**Locally (Bun — no account needed):**
```bash
bun signaling-node/bun-server.mjs
# ws://localhost:8788/rendezvous?key=<room>
```

**On the edge (Cloudflare — your account):**
```bash
cd signaling-node
wrangler dev      # local edge runtime
wrangler deploy   # ship it
```

## Privacy

The node never reads the relayed `payload` — that's the SDP. The reducer
simply never inspects it, so neither shell can log it. This is the
PROTOCOL §9 / constraint-§6 commitment, enforced by construction.

## Abuse resistance — what's done, what's deferred

This is V2 federation infrastructure; it is NOT part of the V1 extension
package. Current state and the open hardening decisions:

**Enforced (in both shells):**
- The reducer caps each room at **2 peers** (`ROOM_CAP`); a third
  connection gets `{t:'full'}` and is closed.
- **Per-message size cap** (64 KiB) and **per-connection rate limit**
  (120 msgs / 10s) in `bun-server.mjs` + `worker.js` — bounds flood and
  memory-blowup DoS from a connected peer.

**Deferred — these need a product decision, not just code:**
- **Origin check.** Reject WebSocket upgrades whose `Origin` isn't an
  expected peerd client. Held back because the `Origin` an extension SW /
  demo page actually sends needs to be pinned down first; a wrong
  allowlist would lock out legitimate clients.
- **Per-IP connection rate limit (room-squatting).** An attacker who
  knows/guesses a room `key` can connect first and occupy a slot, and can
  open many distinct keys to spawn rooms. High-entropy keys (exchanged
  out-of-band) mitigate guessing; a real fix is a per-IP connection
  limiter — straightforward in the Bun shell, and on the edge wants
  Cloudflare's rate-limiting binding (the DO-per-key topology can't see
  cross-key volume on its own).
- **Room-key authentication.** A shared token in the join would stop
  squatting outright but is a protocol change (token exchange), so it
  lands with the V2 federation design, not here.

## What it is not

Not a relay for app traffic, not a TURN server, not a coordinator for the
conversation. Once two peers connect, the node is out of the path entirely.
After the mesh exists, peer-assisted signaling + DHT-published bootstrap
mean it matters only for the very first contact (ARCHITECTURE §1).
