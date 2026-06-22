# peerd-distributed — Roadmap

> Phased implementation plan. Effort, dependencies, failure modes, and
> external gates per phase.
>
> **Resequenced 2026-06-12** against `NORTH-STAR.md` (read it first —
> the four tenets and decisions D-5…D-9 are the why behind every
> ordering choice here). The two structural changes from the previous
> revision of this file: **TURN is deleted everywhere** (D-5), and the
> **DHT moves behind the live-room demo** (D-6) — Phase 1 is now
> "rooms & live collaboration," the thing that goes on stage.

Effort estimates assume one strong engineer who already knows the
codebase, in ideal weeks. They are sizing, not commitments.

Legend for risk: 🟢 routine · 🟡 real risk, mitigable · 🔴 the part that
can sink the schedule.

---

## Phase 0 — The wedge ✅ SHIPPED (preview channel)

Two peers exchange a signed app bundle over WebRTC. No DHT, no async
messaging, no discovery. What exists on `main`:

- Ed25519 `did:key` identity (ephemeral per page/SW lifetime),
  codec (base58 / canonical bytes), `peerd://` URIs.
- Signed manifests, 256 KB chunking, content store (announce set),
  point-to-point bundle transfer with per-chunk verification.
- Signed CBOR envelope + authenticated HELLO session.
- Locality-blind `connect()` over three transports (in-process,
  BroadcastChannel, WebRTC), happy-eyeballs cheapest-first.
- Public-STUN ICE defaults (Google + Cloudflare), non-trickle
  paste-code pairing, same-machine loopback SDP rewrite.
- The pure signaling reducer + two server shells (Bun, CF Worker/DO),
  room cap 2, size/rate caps; `connectViaSignaling` room-code client.
- `createDwebClient` behind `shared/dweb-interface.js`; the module is
  preview-channel-only and boundary-checked in CI.

What Phase 0 deliberately did NOT include (and Phase 1 now does):
multi-peer rooms, gossip, sync, the app loader's install path, a
persistent identity, the dwapp bridge.

---

## Phase 1 — Rooms & live collaboration: **the demo** (next)

**Goal.** The `NORTH-STAR.md §2` demo, end to end: N peers in a room
behind one `peerd://` link, co-editing a document and sharing a post
feed, with the rendezvous server killable mid-session. Everything on
this list exists to serve a named beat; nothing else is in scope.

**Scope — the todo list, in build order.**

1. **Persistent identity.** Seed becomes a vault secret
   (`distributed/identity/seed`, vault-random; PRF derivation stays
   Phase 3) so the did survives restarts and feed attribution holds.
   Public did readable while locked (`chrome.storage.local`).
   *(~2–3 d · 🟢)*
2. **Rooms in the signaling reducer.** `ROOM_CAP` 2 → N (start 16),
   join/leave + roster broadcast, late-join introductions. One
   reducer change; both server shells inherit it for free. Trickle
   ICE over the rendezvous socket for fast joins (paste-code stays
   non-trickle). *(~2–3 d · 🟢)*
3. **Room mesh.** `transport/rooms.js` + `transport/mesh.js`:
   connect() to each roster peer, reconnect with backoff, connection
   budget, full mesh to ~10 / fanout beyond (D-9). **Mesh-assisted
   signaling**: SDP for a newcomer relayed over `ch=0` through any
   already-connected member — this is what makes beat 4
   (kill-the-server) true. *(~1–1.5 wk · 🟡 — the reconnect/partition
   edges)*
4. **Topic gossip** (`gossip/topic.js`, `ch=4`). publish/subscribe on
   `(roomId, label)`, signed envelopes only, seen-cache dedup,
   fanout cap, per-did token-bucket rate limit, per-did mute.
   Presence beacons (`gossip/presence.js`). Payloads are opaque
   bytes — the platform never interprets them (D-7). *(~1 wk · 🟡 —
   amplification/loop edges; keep the flooder dumb)*
5. **Topic sync** (`gossip/sync.js`). Late-join backfill: have-list
   (envelope hashes) exchange, pull missing, per-topic persistence in
   the content IDB store. Demo-scale (hundreds of posts), not
   set-reconciliation-scale — say so in the code. *(~3–4 d · 🟢)*
6. **Bridge v0** (`apps/bridge.js`). The ~ten-call dwapp API from
   `NORTH-STAR.md §4` over postMessage: identity/sign (domain-
   separated, D-8), join/leave/peers (confirm-gated), publish/
   subscribe/sync, put/get. Per-(app, permission) grants mirroring
   egress; everything audited. **Gets its own security review before
   the demo — it is the new privilege boundary.** *(~1–1.5 wk · 🟡)*
7. **App loader** (`apps/loader.js`). Fetched bundle → verify
   signature + chunks → install into the existing engine App runtime
   (OPFS write, `app-tab/runner.html`). Phase 0 built the transfer;
   this is the missing last mile of beat 1. *(~3–4 d · 🟢)*
8. **ICE polish.** IPv6-preferred candidate policy, per-connection
   path reporting (`direct-ipv6` / `direct-ipv4-srflx`) surfaced to
   the bridge for the HUD, honest no-path diagnostics
   (`connect_failed` audit event with candidate-type summary — this
   is also the D-5 revisit-trigger telemetry). **No TURN work, ever
   (D-5).** *(~2–3 d · 🟢)*
9. **The commons app.** Feed (signed posts, app-layer schema) + live
   doc (CRDT chosen at build time per D-7, vendored *inside the app
   bundle*) + presence list + connectivity HUD. Ships as a signed
   seed app in preview packages (the Q5 pattern) AND installs
   peer-to-peer for joiners — beat 1 is the install path
   demonstrating itself. *(~1.5–2 wk · 🟡 — most of it is product,
   not protocol)*
10. **Protocol + threat-model writeups, then demo hardening.** Rooms/
    gossip/sync wire formats land in `PROTOCOL.md` (new §5-adjacent
    sections); room-gossip abuse cases land in `THREAT-MODEL.md`.
    Then the drill: 3–5 real machines across real NATs, kill-the-
    server rehearsal, late-join backfill under churn. *(~1 wk · 🟡)*

**Demo.** The five beats of `NORTH-STAR.md §2`, on stage, with the
rendezvous node dying in the middle.

**Effort.** ~7–9 weeks total. (The old plan reached a comparable
"wow" only after old-Phase-1 + the DHT — 12–17 weeks with the 🔴 in
the middle.)

**Dependencies.** Phase 0 (all of it); the vault; the engine App
runtime; offscreen keepalive (pin while a room is open — the existing
transfer-pin policy extended).

**What could go wrong.**
- Mesh churn (joins/leaves mid-edit) corrupting app state.
  *Mitigation:* the platform only promises envelope delivery to
  current subscribers + sync-on-join; the commons doc CRDT is
  convergent by construction; the feed is append-only.
- Gossip loops / amplification in small meshes. *Mitigation:*
  seen-cache keyed on envelope hash, fanout cap, TTL hop count; the
  flooder stays ~200 lines so it can be reasoned about.
- The bridge becomes a capability hole. *Mitigation:* D-8 domain
  separation, grants mirror the egress confirm model 1:1, dedicated
  review (item 6), bridge surface frozen for the phase.
- Demo-day NAT roulette. *Mitigation:* item 10's real-machine
  matrix; the HUD makes failures legible; paste-code is the
  always-works backstop on stage.

**External gates.** None new. WebRTC + WebCrypto Ed25519 already
shipped everywhere we target; public STUN is free; no X25519 needed
this phase (no sealing yet).

---

## Phase 2 — Field resilience: server-optional maturity

**Goal.** The Phase 1 network stops being a demo and starts being
dependable: multiple bootstrap nodes, remembered peers, rooms that
survive restarts, and the on-thesis answer to hard NATs.

**Scope.**
- Multi-URL bootstrap with retry/failover; reference self-hosted node
  documented as a first-class equal (anti-lock-in, T2).
- `discovery/peer-cache.js`: passive set of ~100 known-reachable
  peers; rejoin rooms and re-establish meshes across browser
  restarts.
- **Offscreen lifetime policy + opt-in "stay reachable"** (OQ-1):
  off by default, visible indicator, battery-honest.
- **Peer-assisted relay** for NAT-blocked pairs (the D-5 fallback —
  a third room member forwards envelopes between two data channels it
  already holds; DTLS/seal-opaque to it). Built only if Phase 1 field
  telemetry shows it matters; T3's trigger governs.
- Feed attachments at scale: content-fetch (`content/fetch.js`)
  wired into gossip-announced hashes — posts carry `peerd://` refs,
  bytes pull point-to-point from whoever has them.
- Community STUN: peers publish/share additional STUN endpoints
  (full DHT-published set arrives Phase 3).

**Effort.** 4–6 weeks. **Risk.** 🟡 lifetime/battery policy; relay
abuse surface (room-scoped mitigates).

**Dependencies.** Phase 1 in real users' hands; its telemetry.

---

## Phase 3 — Discovery: the DHT chapter (+ persistent-identity maturity)

**Goal.** Stranger-to-stranger discovery without a directory — global
feeds, finding content and peers you don't share a room with. The
Kademlia design is unchanged from the original plan; only its
*position* moved (D-6): it now lands on a network with real rooms to
route over, and it is still the single riskiest item in the module.

**Scope.**
- `discovery/kad/`: the minimal vanilla Kademlia (D-3). Routing
  table, iterative lookup, the five RPCs, signed/TTL'd records, PoW,
  S/Kademlia hardening — designed in from day one, not bolted on.
- **Simulation harness first**: N virtual nodes over the in-process
  transport, libp2p test vectors (XOR distance, bucket split,
  closeness ordering) ported as the correctness gate, before any
  real-WebRTC routing.
- `discovery/bootstrap.js`: live bootstrap set published as a DHT
  record; hardcoded list becomes fallback only.
- Identity maturity: PRF-seeded Ed25519 (reuse vault
  `enrollWithPrf`/`getPrfOutput`), `subkey.js` (agent + X25519
  certs), `proof.js`, multi-device design (OQ-2 — leaning per-device
  subkeys under one published identity).
- Delegated republish + TTL-by-class; content `FIND_VALUE` wired into
  `content/fetch.js`; STUN-set + bootstrap-set records.
- **Global feeds**: topic records in the DHT make the commons feed
  room-transcending — same app, discovery swapped in underneath
  (`NORTH-STAR.md §2`, "what the feed is NOT yet").

**Effort.** 8–11 weeks (Kademlia 6–8 of them). **Risk.** 🔴 the DHT.

**What could go wrong.** Unchanged from the original plan: DHT
correctness/performance is where libp2p spent years. The simulation
harness + ported test vectors are the de-risk; if it slips, ship a
reduced-function DHT (FIND + content pointers only) and add record
classes incrementally.

**External gates.** WebCrypto X25519 for subkey certs (shipped in
current Chrome/Safari/Firefox; transport-only secrecy as the
documented fallback).

---

## Phase 4 — Async messaging & social-graph relays

**Goal.** Messages survive recipient offline. Relays drawn from the
social graph, sealed, capped, abuse-resistant. (Unchanged in content
from the original plan; arrives after discovery because inbox
pointers live in the DHT.)

**Scope.**
- `messaging/seal.js` (X25519 ECDH → HKDF → AES-256-GCM, per-message
  ephemeral keys), `relay.js` (100 MB cap, oldest-evict, social-graph
  eligibility + senderProof), `inbox.js` (DHT inbox pointers,
  online-poll), `RELAY_STORE`/`INBOX_FETCH` flows (`PROTOCOL §6.2`).
- Trust-tier enforcement on relay-store (Tier 0/1 only).
- N=5 relay redundancy; INBOX_ACK-gated eviction; withhold/modify
  mitigations per `THREAT-MODEL §8`.

**Effort.** 4–6 weeks. **Risk.** 🟡 relay abuse vectors, eviction
policy.

---

## Phase 5 — Curation, the social graph, and abuse maturity

**Goal.** Discovery as a graph, and the standing adversarial track.
(The old Phase 4 social app shrank: the commons — shipped back in
Phase 1 — *is* the seed app; this phase grows it into curation.)

**Scope.**
- `curation/`: publishable lists (apps/peers/topics/posts),
  subscription graph, feed assembly, blocklists (personal +
  subscribed + default community list, Bloom-backed).
- Commons grows from room feed → followed-graph feed → the App Store
  surface (signed seed app self-updating over the network, Q5).
- Abuse maturity, ongoing: blocklist gossip, curation-graph Sybil
  resistance (trust flows along subscription edges), signaling-node
  DoS hardening (OQ-3), DHT parameter tuning + eclipse review from
  real-mesh behavior.

**Effort.** 6–8 weeks initial; the abuse track never closes.
**Risk.** 🟡 adversarial, standing.

---

## External-factor gate summary

| Gate | Affects | Status (2026-06) | Fallback |
|---|---|---|---|
| WebCrypto Ed25519 | identity, all signing | Shipped: Chrome 137+, Safari 17+, Firefox 129+ | None needed |
| WebRTC data channels | all transport | Universal | None |
| Public STUN (Google/Cloudflare) | IPv4 cross-NAT connect | Available, free | Community/peer-published STUN (Phase 2/3) |
| **IPv6 adoption** (the T3 bet) | direct-connect rate | ~50% and climbing; satellite constellations accelerating | Peer-assisted relay (Phase 2, on-thesis); **never TURN (D-5)** |
| WebCrypto X25519 | seal, enc subkeys (Phase 3+) | Shipped in current engines | Transport-only secrecy until parity |
| WebAuthn PRF | passkey-derived seed (Phase 3) | Widely available | Vault-random seed (Phase 1 default) |
| `chrome.offscreen` | network host | Chrome MV3 only | Firefox needs a different host (OQ-4) |
| CF Workers + DO | rendezvous | Operated by peerd; self-hostable Bun shell is a first-class equal | Paste-code pairing needs zero servers |

---

## Supersession record

- **2026-06-12 — resequenced against `NORTH-STAR.md`.** TURN deleted
  (D-5: was old-Phase-1 "ICE tiering" scope and `PROTOCOL §3.5`
  turnREST); DHT moved behind the demo (D-6: old Phase 2 → Phase 3);
  pubsub/gossip pulled forward (old Phase 3 → Phase 1); the social
  seed app pulled forward and shrunk (old Phase 4 → the Phase 1
  commons, with curation remaining Phase 5); old Phases 4+5 merged
  into Phase 5. The Kademlia design itself is unchanged.
- The original (pre-dweb-module) V1 `ROADMAP.md` reconciliation —
  Ed25519 over ECDSA (D-1), no gateway in this module, dwapps as
  `app`-type content — still stands and is recorded in
  `ARCHITECTURE.md §0`.
