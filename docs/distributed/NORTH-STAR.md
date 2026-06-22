# peerd-distributed — North Star

> The grounding frames for the dweb track, the demo they point at, and
> the decisions they force. Written 2026-06-12, after Phase 0 shipped.
> This document is upstream of `ROADMAP.md` (which it resequenced — see
> the supersession notes there) and sits beside `ARCHITECTURE.md`
> (decisions D-5…D-9 below are summarized in its §0 table).
>
> When a future design question stalls, come back here: the four
> tenets are the tiebreakers.

---

## 1. Tenets

Four frames, sharpened into testable rules. Every roadmap item, every
dependency, every protocol message must pass them.

### T1 — Dependency floor

The platform — `peerd-distributed` and `signaling-node` — takes
**zero new runtime dependencies** unless a candidate passes ALL of:

1. Vendorable as a single audited file (the CodeMirror pattern), no
   transitive runtime deps to chase.
2. License compatible with Apache-2.0 redistribution.
3. Survives the no-build-step / no-npm-runtime / MV3 constraints as-is.
4. Replaces something we genuinely cannot build leaner ourselves.

Applied so far: **libp2p failed** (D-3 — we port the Kademlia *design
and test vectors*, not the code). **Yjs never gets assessed as a
platform dep at all**, because the platform doesn't need a CRDT —
see D-7. The platform moves signed bytes; what the bytes mean is the
app's business.

### T2 — One bet: peers do the work

All real logic runs in browsers. Servers are limited to
**introductions**: a rendezvous node that relays opaque SDP and
forgets it, and (later) a published bootstrap-peer list. The moment
two peers hold a data channel, the server's job is done — and
mesh-assisted signaling (peers relaying SDP for newcomers over
existing channels) makes it progressively unnecessary even for
introductions. DHT, routing, gossip, sync, storage: peers, always.

**The test:** kill the rendezvous node mid-session. Nothing already
running may break, and a newcomer must still have a path in (paste
code, or signaling relayed through a connected peer).

### T3 — The IPv6 bet: STUN-only connectivity, no TURN

We bet that end-to-end addressability is coming back. IPv6 adoption
keeps climbing; Starlink-class constellations (now flush with the
largest IPO in history) and the competitive pressure they create are
accelerating it. We design for where the web is going, not where
carrier-grade NAT left it.

Concretely:

- Connectivity = host candidates (**IPv6 preferred**) + STUN
  reflexive candidates from **free public servers** (Google,
  Cloudflare, and peers willing to publish more later). STUN is
  setup-only metadata — never in the data path.
- **No TURN.** Not built, not specced, not on the roadmap (D-5). A
  TURN server is a server in the data path — the exact thing T2
  forbids — and every hour spent on relays is an hour not spent on
  the bet.
- Pairs that cannot connect directly **fail honestly**, with a
  diagnostic that names the cause ("both ends symmetric-NAT IPv4, no
  IPv6 path") instead of silently degrading through a relay.
- The eventual fallback is **peer-assisted relay** — a third *peer*
  forwarding envelopes between two data channels it already holds
  (Phase 2+). On-thesis: it's a peer, not infrastructure.

**Revisit trigger:** if field telemetry after IPv6-preference ships
shows pair-connect failure above ~1 in 5 attempts, the bet is
mispriced and this tenet gets re-argued with data. Until then, no
relay work.

### T4 — Demo-rooted design

Every primitive must be justified by a beat in the north-star demo
(§2). If a component is not needed to make the demo land, it moves
behind the demo — however architecturally satisfying it is. This is
what moved the DHT (the single riskiest item in the module) from
"next" to Phase 3 (D-6).

---

## 2. The demo: **commons**

Working title `commons` (lowercase, like peerd): one dwapp behind one
`peerd://` link — a shared space that is simultaneously a **public
post feed**, a **live co-edited document**, and a **presence surface**.
It is the App-Store-meets-social-feed seed (old Phase 4 vision)
shrunk to the smallest thing that is *visibly* the thesis.

### The beats

1. **The link.** Peer A shares `peerd://<did>/<hash>#room=<code>`.
   Peer B opens it — and the app itself arrives **from A, peer to
   peer**, signature-verified, installed into the existing sandboxed
   App runtime. Install-from-peer is a demo beat, not plumbing.
2. **The document.** A and B type into the same document.
   Character-level merge, live cursors, no server anywhere.
3. **The feed.** Posts propagate through the room by gossip. Peer C
   joins late and **backfills history from the peers present** — the
   feed has no home server to fetch from, and doesn't need one.
4. **Kill the server.** Stop the rendezvous node, live, on stage. The
   room keeps working untouched. Peer D still joins — via paste-code
   or via signaling relayed through a connected peer (T2's test,
   performed as theater).
5. **The HUD.** Every connection in the room shows its true path:
   `direct IPv6` · `direct IPv4 (STUN-assisted)`. Honest
   infrastructure visibility — the IPv6 bet, on screen.

### Why these five

Each beat is one claim made undeniable: *real apps travel peer-to-peer*
(1), *real-time collaboration needs no server* (2), *data outlives any
node* (3), *the server was only ever an introduction* (4), *the
connectivity story is real and measured* (5). Together they are "the
web is becoming peer-to-peer capable again," demonstrated rather than
asserted.

### What the feed is NOT yet

The demo feed is **room-scoped**. A *global* public feed needs
stranger discovery — that is the DHT chapter (Phase 3), and we don't
pretend otherwise. Same app, same record format; discovery swaps in
under it later.

---

## 3. What the demo derives (beat → primitive)

| Beat | Primitive | State |
|---|---|---|
| 1 link / install | content addressing, signed bundles, transfer | **Phase 0, shipped** |
| 1 install | `apps/loader.js` — verified bundle → engine App runtime | new (small) |
| 1–4 join | multi-peer **rooms** (rendezvous roster, N-cap reducer) | new |
| 2–4 | room **mesh** (connect-to-roster, reconnect, budget) | new |
| 2, 3 | **topic gossip** — signed envelopes, seen-cache, fanout (`ch=4`) | new |
| 3 | **topic sync** — have-list exchange, pull missing, per-topic store | new |
| 4 | **mesh-assisted signaling** — SDP relay over `ch=0` via any connected peer | new |
| 5 | ICE **path reporting** + IPv6 preference + honest no-path errors | new (small) |
| all | **persistent identity** — vault-stored seed, stable did | upgrade (Phase 0's is ephemeral) |
| 1, 2, 3 | **bridge v0** — the permission-gated dwapp API | new — *the* design moment |

Notably absent: the DHT (rooms come from links and codes, not
search), async store-and-forward (feed history lives with room
peers), curation, relays. All deliberately behind the demo.

---

## 4. The bridge is the product

The dwapp API is the dweb's developer story — what it feels like to
build on this network. Keep it small enough to memorize:

```
dweb.identity()               → { did }
dweb.sign(bytes)              → sig          // domain-separated — D-8
dweb.join(roomId)             → { self, roster }   // confirm-gated
dweb.leave(roomId)
dweb.peers(roomId, cb)        // presence: join / leave / liveness
dweb.publish(topic, bytes)    // topic = (roomId, label); bytes opaque
dweb.subscribe(topic, cb)     // verified envelopes; sender did attached
dweb.sync(topic, haves)       → missing      // backfill
dweb.put(bytes) → uri   ·   dweb.get(uri) → bytes   // content store
```

Roughly ten calls. Everything else — feed semantics, CRDT merge,
cursors, profiles — is app code riding `publish`/`subscribe` as
opaque bytes. The platform authenticates, dedupes, rate-limits, and
moves envelopes; it never interprets payloads.

Security posture: the bridge is a privilege boundary and mirrors the
egress model exactly — per-(app, permission) grants, confirm-gated
`join`, every grant and denial audited. `ARCHITECTURE.md §7` and
`MIGRATION.md §3` already frame this; bridge v0 implements the
minimal slice and gets its own review before the demo.

---

## 5. Decisions (continuing ARCHITECTURE.md §0's D-series)

| # | Decision | Rationale | Supersedes |
|---|---|---|---|
| **D-5** | **No TURN.** Tier 3 (BYOC/managed TURN, turnREST credentials) is deleted from the architecture, protocol, and roadmap. STUN via free public servers stays (setup-only). Peer-assisted relay (a peer, not a server) remains the eventual fallback. Direct-connect failure is surfaced honestly, never relayed silently. Revisit only on the T3 trigger (>~20% pair-connect failure in the field). | T2 + T3: a TURN server is infrastructure in the data path; the IPv6 trend shrinks the case for it every year; engineering time goes to the bet, not the hedge. | `ARCHITECTURE §6.5` Tier 3, `PROTOCOL §3.5`, old `ROADMAP` Phase 1 ICE-tiering scope |
| **D-6** | **Demo-first resequencing.** Rooms + gossip + sync + bridge v0 + the commons app ARE Phase 1. The DHT moves behind them (Phase 3); async messaging behind that (Phase 4). | T4. The old plan put the 🔴 6–8-week Kademlia between Phase 0 and anything demonstrable. The live room is the claim made real; the DHT is how the claim *scales*, and earns its slot when discovery is the binding constraint. | Old `ROADMAP` Phase 1/2 ordering |
| **D-7** | **CRDTs are app-layer.** The platform ships signed opaque bytes; no CRDT library enters `peerd-distributed` or `extension/vendor/`. The commons doc brings its own CRDT *inside its app bundle*, chosen at build time against T1-style criteria: single vendorable file, zero transitive runtime deps, permissive license, ≈≤150 KB, proven merge semantics. Yjs is the favorite and is assessed then — not before, and never as a platform dep. If nothing passes, the doc beat degrades to block-level last-writer-wins (less magical, still live) and the platform is identical either way. | T1. The network layer that doesn't know what a CRDT is can never be broken by one. | — |
| **D-8** | **App signatures are domain-separated.** `dweb.sign` never signs caller-chosen raw bytes; it signs `"peerd/app/v1" ‖ appHash ‖ bytes`. | A malicious dwapp must not be able to use the user's identity key to forge protocol records (manifests, DHT records, certs — all of which have their own signing prefixes per `PROTOCOL §2`). | — |
| **D-9** | **Rooms before DHT; the room is the consent and spam boundary.** Membership comes from the rendezvous roster + peer exchange among members. Inside a room: signed envelopes only, seen-cache dedup, per-did token-bucket rate limit, per-did mute. Full mesh to ~10 peers; gossip fanout caps beyond. | T2 + T4. A room you joined by link/code is mutual consent — Tier-2-stranger defenses (PoW, S/Kademlia) aren't needed yet and arrive with the DHT, where strangers do. | — |

---

## 6. Non-goals (frame discipline)

- **No TURN** (D-5). No turnREST, no BYOC relay settings UI, no
  "managed connectivity" tier. The words appear in docs only as
  history.
- **No libp2p** (D-3, reaffirmed) — and **no GossipSub port** either.
  Room gossip is a small, room-scoped flooder with a seen-cache
  (~200 lines), not a mesh-optimizing protocol. Episub-style
  refinements earn their way in later with measurements, if rooms
  ever get big enough to need them.
- **No platform CRDT** (D-7).
- **No global-feed claims** before discovery exists. Room-scoped and
  said so.
- **No store-channel dweb.** Preview-channel only until the protocol
  stops being research-grade; the dual-distribution boundary stands.
- **No always-on relay daemon by default.** "Stay reachable" remains
  opt-in with a visible indicator when it arrives (OQ-1); the
  offscreen doc is pinned only while a room is open or a transfer is
  active.

---

## 7. Risks the frames accept, named

- **Some pairs can't connect** (symmetric-NAT IPv4 both ends, no
  IPv6). Accepted under T3, surfaced honestly, measured (the HUD and
  audit events give us the failure rate), revisited on the trigger.
- **Room-scale ceiling.** Full-mesh-then-flood is fine for tens of
  peers, not thousands. Accepted under T4: the demo needs a room, not
  a stadium. The gossip layer's fanout cap is the seam where a
  smarter mesh slots in later.
- **A from-scratch Kademlia is still ahead of us** (Phase 3, 🔴).
  Unchanged from D-3 — but now it starts *after* the network has real
  users and real rooms to route over, and after the simulation
  harness proves it offline.
- **The browser is a hostile home for an always-on peer** (MV3
  lifetimes, battery). Phase 1 only needs peers alive *while a room
  is open*, which the existing offscreen keepalive already covers;
  the long-lived-presence problem stays parked at Phase 2 (OQ-1).
