# peerd-distributed

> The **`d`** (magenta) in the peerd wordmark — the dweb.
> A browser-native peer-to-peer network for agents and the apps they
> build: did:key identity, signed content addressing, a WebRTC mesh with
> gossip and a Kademlia DHT, and a server-less app store. Part of
> [peerd](../../README.md); read the root README first, then
> [`docs/distributed/`](../../docs/distributed/) for the full design.

**Status: 0.x — RESEARCH-GRADE, PREVIEW CHANNEL ONLY.** This module
ships **only** in the `peerd preview` package — it is pruned entirely
from the store build, and CI verifies zero dweb traces leak into store
artifacts. The protocol is actively changing; **breaking changes are a
given**. Phase 0 is shipped and Phase 1 ("rooms & live collaboration")
is in progress; the DHT, async messaging, and curation are designed but
not yet wired. Don't build anything durable on it yet.

---

## What it does

The `d` in peerd isn't only for *daemon* — it's for *distributed*.
`peerd-distributed` is a real browser-to-browser network where all the
logic lives in the extension and the only servers are stateless
rendezvous nodes that introduce two peers and then drop out of the data
path. WebRTC ships in every modern browser and runs on billions of
devices; WebTorrent uses it for files — peerd uses it for **agents and
the apps they build**.

Concretely: a peerd agent can build a small app, **share** it to the
network, and other people's agents can **discover** and **install** it.
The apps themselves (*dwapps*) can tap the same mesh for real-time,
server-less collaboration that both humans and agents use. No blockchain,
no coin, no relay in the middle.

## The boundary (read this first)

The dweb is the most strictly isolated part of the codebase. **Nothing
outside this module imports it — not even its `index.js`.** The
isolation is enforced, not conventional:

- Core code programs against the `DwebClient` typedef and `dwebStub` in
  [`shared/dweb-interface.js`](../shared/dweb-interface.js) (shipped in
  *both* channels; the stub reports unavailable and throws on use).
- The only place that may name this module's path is
  [`shared/dweb-loader.js`](../shared/dweb-loader.js), which
  dynamically imports the real client **only** when `DWEB_ENABLED` is
  true and returns the stub otherwise.
- `DWEB_ENABLED` / `CHANNEL_DEFAULTS` come from the **generated**
  `shared/channel-config.js` — `false` in the store artifact, `true` in
  preview. Core never probes the channel at runtime, and the flag is
  never exposed to the agent or skills.
- Packaging prunes `peerd-distributed/` from the store build and swaps
  in a stub loader; `packaging/check-dweb-boundary.ts` fails CI on any
  static import, and a post-package check greps store artifacts for
  `peerd-distributed/` references (must be zero).

The agent reaches the dweb only through exposure-gated tools (below),
invisible where `DWEB_ENABLED` is false.

## How it works today

### Shipped (Phase 0 + Phase 1 in progress)

- **Identity** — Ed25519 `did:key` (`identity/`), persistent from a
  vault-stored seed. All signing is domain-separated (each signature is
  over a tag byte-prefix + payload).
- **Content addressing** (`content/`) — `peerd://<publisher_did>/<hash>`
  URIs, signed JCS-serialized manifests, 256 KB SHA-256 chunks, an
  OPFS-backed content store with an announce-set "liability firewall"
  (serve only what you've announced), and point-to-point + parallel
  multi-provider bundle transfer with per-chunk integrity checks.
- **Transport** (`transport/`) — a **locality-blind** connector that
  tries in-process → same-origin `BroadcastChannel` → WebRTC, cheapest
  first. WebRTC uses public STUN (Google + Cloudflare), an
  IPv6-preferred candidate policy, and an authenticated HELLO handshake;
  every frame is a signed CBOR envelope. **No TURN, ever** — the
  fallback is peer-assisted relay (designed, not built).
- **Rooms & mesh** (`transport/rooms.js`, `mesh.js`) — N-peer rooms
  (cap 16) over a rendezvous WebSocket, with **mesh-assisted signaling**:
  if the rendezvous server dies mid-session, a newcomer gets the roster
  from one connected peer and dials the rest via relayed SDP. Full mesh
  to ~10 peers, fanout beyond.
- **Gossip / presence / sync** (`gossip/`) — a deliberately dumb
  room-scoped flooder (opaque payloads, signature-keyed seen-cache as
  the loop guard, per-did token-bucket rate limit + mute), presence
  beacons, and late-join backfill.
- **The dwapp bridge** (`apps/bridge.js`) — a consent-gated postMessage
  API (join/leave, publish/subscribe/sync, direct 1:1, announce/publish/
  install-app) that mirrors the egress trust model exactly: per-(app,
  permission) grants, domain-separated app signing, and the app never
  sees key material.
- **The app store** (`apps/` + `base-network.js`) — Share → Discover →
  Install over the always-on base network's metadata plane (library
  cache + discovery subscription protocol + per-did blocklist), plus the
  built-in **commons** seed dwapp (feed + live doc + presence).
- **The signaling reducer** (`transport/signaling.js`) — one pure state
  machine shared by the browser client, the Bun server, and the
  Cloudflare Worker in [`signaling-node/`](../../signaling-node/). The
  broker relays opaque SDP and never reads it.
- **Agent tools** — exposure-gated to the preview channel:
  `dweb_share`, `dweb_discover`, `dweb_install`, plus `dweb_peers`,
  `dweb_block`, `dweb_discovery`, and `dweb_guide`.

### Scaffolding (designed, not yet wired)

- **The Kademlia DHT** (`dht/`) — routing tables, iterative lookups, and
  signed/TTL'd records are built but **not yet wired into the live
  network** (Phase 3, the riskiest chapter; a simulation harness gates
  it).
- **Subkeys** (agent certs, X25519 encryption certs) — Phase 3.
- **Async messaging** (`messaging/` — sealed-sender relay inboxes) —
  Phase 4, designed in `PROTOCOL.md`, not implemented.
- **Curation** (publishable lists, subscription graph, Bloom blocklists)
  — Phase 5.

## Public API (`index.js`)

The surface is large (identity, content, transport, rooms, gossip,
dwapps); the one entry point core code uses is `createDwebClient` (with
the `PHASE` constant). Key groups:

- **Identity:** `generateIdentity`, `createPersistentIdentity`,
  `importIdentity`, `verifySignature`, `encodeDidKey`, `decodeDidKey`.
- **Content:** `parsePeerdUri`/`formatPeerdUri`, `buildManifest`/
  `verifyManifest`/`manifestHash`, `chunkBytes`, `packBundle`/
  `unpackBundle`, `createContentStore`, `fetchBundle`.
- **Transport:** `createConnector`, the three transports, `signEnvelope`/
  `verifyEnvelope`/`buildEnvelope`, `createSession`, `createPeer`,
  `signalingStep`, `connectViaSignaling`/`openRendezvous`,
  `DEFAULT_ICE_SERVERS`, `DEFAULT_SIGNALING`.
- **Rooms & gossip:** `joinRoom`, `createRoomMesh`,
  `DirectPathUnavailableError`, `createGossip`, `createPresence`,
  `createTopicSync`.
- **Dwapps:** `installAppBundle`, `createDwebBridge`, `loadSeedApp`,
  `COMMONS_SEED`, `BundleRejectedError`.
- **Client:** `createDwebClient`, `PHASE`.

## Known limitations

- **Preview-only and research-grade.** Not in the store build; protocol
  subject to change without migration.
- **The DHT is scaffolding** — global discovery, content `FIND_VALUE`,
  and bootstrap-set publishing wait on Phase 3.
- **Room-scale ceiling.** Full-mesh-to-~10-then-fanout suits the commons
  demo, not stadium scale.
- **Some peers can't connect.** Symmetric-NAT-on-both-ends with no IPv6
  fails *honestly* (`DirectPathUnavailableError`); peer-assisted relay
  is the only planned fallback (no TURN), and it's built only if field
  telemetry shows it's needed.
- **Rooms are tab-scoped in Phase 1** — they live as long as the hosting
  page. A persistent, opt-in "stay reachable" offscreen mode is a Phase
  2 open question (off by default, battery-honest).
- **Firefox has no `chrome.offscreen`** — the always-on network host
  needs a different home there (flagged for the Firefox-parity track).

## TODO / backlog

The dweb is its own research track, sequenced in
[`docs/distributed/ROADMAP.md`](../../docs/distributed/ROADMAP.md) and
framed by [`NORTH-STAR.md`](../../docs/distributed/NORTH-STAR.md):

- **Phase 1 (in progress)** — finish the **commons demo**: persistent
  identity, N-peer rooms, mesh-assisted signaling, gossip/presence/sync,
  the bridge v0, and the app loader.
- **Phase 2** — field resilience: multi-URL bootstrap + failover, peer
  cache, mesh recovery across restarts, peer-assisted relay (only if
  field data shows >~20% pair-connect failure), and the offscreen
  lifetime decision (OQ-1).
- **Phase 3** — the DHT: a hardened minimal Kademlia (sim-harness-gated),
  PRF-seeded identity, subkeys, DHT-published bootstrap, and global
  feeds.
- **Phase 4** — async messaging (sealed-sender social-graph relays).
- **Phase 5** — curation and the standing abuse-resistance track.

Open questions (OQ-1 offscreen lifetime, OQ-2 multi-device identity,
OQ-3 bootstrap abuse, OQ-4 Firefox parity) are tracked in the dweb docs.

## See also

- [`docs/distributed/ARCHITECTURE.md`](../../docs/distributed/ARCHITECTURE.md)
  — the full design.
- [`docs/distributed/PROTOCOL.md`](../../docs/distributed/PROTOCOL.md) —
  wire formats.
- [`docs/distributed/NORTH-STAR.md`](../../docs/distributed/NORTH-STAR.md)
  — tenets, the demo, the recorded decisions.
- [`docs/distributed/THREAT-MODEL.md`](../../docs/distributed/THREAT-MODEL.md)
  — the dweb adversary model.
- [`signaling-node/`](../../signaling-node/) — the rendezvous server
  shells that share the pure signaling reducer.
