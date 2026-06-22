# The global network + app sub-protocols (base-layer plan)

> Status: **PLAN / RFC** — the design to build the base layer against.
> Pass 2 (2026-06-14) folds in a prior-art study of browser P2P (Bitcoin
> addrman, gossipsub v1.1, Kademlia/Mainline/BEP-44, WebTorrent, Scuttlebutt,
> Helia, Hyperswarm) and reconciles it with what peerd already ships.
> Builds on `NORTH-STAR.md`, `PROTOCOL.md`, and `docs/DECISIONS.md` #21.

## TL;DR (what we're building, and the judgement calls)

- **One always-on base network in the offscreen document** — gossip-first,
  signed announcements, a bucketed address book, a small bounded connection
  set. Its only job: *find peers, learn general info, carry announcements.*
- **Apps plug in as sub-protocols** through the granted `peerd.distributed.*`
  capability (DECISIONS #21): each gets a gossip topic + direct (1:1) channel
  over the **shared** base connections, treated as opaque signed bytes.
- **The DHT is IN the base layer** (offscreen-hosted), alongside gossip — the
  network's content directory. **Owner decision (2026-06-14), and it's the
  right read:** Helia's failure was specifically *tab-scoped* DHT nodes that
  vanish when a tab closes; our DHT lives in the offscreen document
  (session-lifetime) and rides our *existing* authenticated WebRTC mesh, so it
  doesn't pay a fresh handshake per hop the way a from-scratch browser DHT
  would. None of the cautionary projects (Helia, WebTorrent, Holepunch) had
  that mesh underneath. Gossip carries *momentum* (everyone hears fast); the
  DHT carries *durability* (late joiners find what they missed). **Built +
  tested:** `dht/` (distance, routing-table, records, store, node, transport),
  18 tests, riding `transport/mesh.js` over ch=1.
- **The Library is the discovery UX.** Local apps today (S0, shipped); network
  dwapps tomorrow, surfaced from `DWAPP_ANNOUNCE` and installed peer-to-peer
  through the bridge op we already have.
- **Sybil resistance is honest, not strong.** Signed `did:key` + local-only
  scoring + source diversity + local bans. A resourced attacker can still
  Sybil/eclipse a fresh node. Stated as an accepted limit, not solved.

## The problem

Phase 1 made a **room** the unit of P2P: `joinRoom(roomId)` builds one full
mesh, hosted in the **app-tab page**, lifetime = that tab. Right wedge for the
commons demo; two limits the base layer must remove:

1. **It dies with the tab.** A network that only exists while one app's tab is
   open can't be a substrate, can't hold presence, re-pays connect cost.
2. **It's one-app-deep, and full-mesh.** Each app spins its own mesh to its own
   rendezvous; two apps = two disconnected stacks; no shared "who's online."
   Full-mesh is fine for a small room, wrong for a network of thousands.

The fix the owner named: **one always-on global network** (find peers + general
info), with **apps as sub-protocols** on top. Plumbing stays in
`peerd-distributed`; apps reach it through `peerd.distributed.*`.

## Prior art, distilled (what the evidence says to do)

The full study is archived separately; the load-bearing conclusions we build on:

- **Gossip + DHT are complementary, and gossip is the base.** Every credible
  browser-P2P project ships signaling + gossip; **none shipped a browser DHT
  as a default.** Helia (modern JS-IPFS) *disabled* the browser Kademlia DHT
  (ipfs/helia#420): tab-scoped nodes vanish, waste connection slots, and
  "wouldn't make good DHT servers anyway." WebTorrent never shipped a browser
  DHT (its tracker/signaling layer is the durable part). Holepunch's HyperDHT
  runs **native**, not in a browser, because it needs UDP + stable sockets.
  → **Base layer = gossip. DHT = a later, opt-in capability in the offscreen
  host** (whose lifetime is the *session*, not a tab — which blunts the Helia
  objection but doesn't erase the cost), with an HTTPS *delegated-routing*
  fallback when it lands.
- **Bitcoin's addrman is the anti-eclipse discipline to borrow** (MIT,
  code-clean): a bucketed address book (new/tried), secret-keyed bucket
  placement an attacker can't predict, *anchors* reconnected first on restart,
  *feelers* to test addresses before promoting them, prefer persisted peers
  over seeds. Browsers lack a stable IP to bucket by, so we bucket by what we
  *can* see (gateway/source-did/ICE-derived IP) and cap any one source's share.
- **gossipsub v1.1 is the propagation discipline to borrow** (Apache-2.0/MIT):
  a small bidirectional mesh (D≈6) with eager-push + lazy IHAVE/IWANT pull,
  GRAFT/PRUNE membership, flood-publish of your own messages (anti-eclipse),
  and **local-only** peer scoring. Validated at thousands of nodes in Eth2 /
  Filecoin. Caveat (Kumar et al., IEEE S&P 2024): full scoring is hard to
  configure and gameable — so v1 ships a *reduced* score, only the parts that
  gate spam/black-holes.
- **Kademlia/BEP-44 are the addressable-storage model for the deferred DHT**:
  XOR distance, k-buckets, Ed25519-signed mutable items with a monotonic
  no-downgrade seq, ~1h expiry with re-PUT self-healing. Reusable verbatim when
  the DHT lands; **reachable-only routing tables** (insert a peer only after it
  answers) are mandatory in the browser where NAT churn is high.
- **Scuttlebutt** is the counter-example: social-graph replication is the
  strongest no-consensus Sybil defense but kills open discoverability — which
  peerd's "maximize dwapp discovery" goal needs. We keep gossip-based open
  discovery at the base and may borrow *signed append-only feeds* for dwapp
  sub-protocols later. (AGPL — concept only.)

## Where it lives (settled)

The network must outlive tabs, so it can't live in an app-tab. Under MV3 only
the **offscreen document** persists, runs module code (`loadDweb()` works; the
SW can't), and can hold WebRTC — and it already hosts peerd's persistent work
(the voice transcribers). **The offscreen document hosts the base network.**
The SW stays the router/registrar (it already brokers every cross-context
message). Apps in tabs reach the host *through* the SW.

```
App tab (sandboxed iframe) ─postMessage▶ app-tab parent ─SW msg▶ offscreen base network
       peerd.distributed.*  (bridge, grant+quota)      (router)   (mesh · addrman · gossip)
```

## The boundary

```
┌──────────────────────────────────────────────────────────────┐
│  BASE NETWORK  (peerd-distributed core, ONE per instance)      │
│  always-on (preview) · offscreen-hosted · the "global protocol"│
│   identity (did:key)                                           │
│   bootstrap + address book (addrman)   — find peers, persist   │
│   connection slots (12 target / 16 cap, anchors + feelers)     │
│   signed HELLO handshake               — authenticate links    │
│   base gossip mesh (gossipsub-derived) — propagate announces   │
│   PEER_ANNOUNCE / DWAPP_ANNOUNCE / PEER_ON_DWAPP / ADDR         │
│   local score · rate limits · ban list — anti-abuse            │
│   [later] DHT directory · gateway delegated-routing fallback   │
└───────────────▲────────────────────────────────────────────────┘
                │  peerd.distributed.*  (granted + quota'd, #21)
   ┌────────────┴───────────┬─────────────────────┬──────────────┐
   │ sub-protocol "commons" │ sub-protocol "chess" │  …app N      │
   │ (chat overlay)         │ (game-state overlay) │              │
   └────────────────────────┴─────────────────────┴──────────────┘
        APP LAYER — each app's own message semantics, opaque to core
```

**Global** = fixed infrastructure peerd owns and always runs. **App** = what a
granted `peerd.distributed.*` caller does on opaque bytes over the shared mesh.
A "room" is just a sub-protocol generalized. This is the same split the
codebase already trusts: the module boundary is the unit of authority (#21).

---

## The base layer (the substance of this plan)

Numbers below are reasoned defaults to validate under load, not proven optima.

### B1 · Identity & addressing — *reuse, mostly built*
- Node identity = the persistent vault-stored Ed25519 `did:key`
  (`identity/keypair.js`, shipped). Short routing/scoring ID = `SHA-256(pubkey)`.
- Content = `peerd://<did>/<sha256>` (`content/uri.js`, shipped) — immutable
  verified by hash, the `did` authorizes mutable pointers (DHT era).
- Peers are addressed by `did:key` + reconnection hints (last rendezvous, ICE
  metadata, latest self-record `seq`) — **never** by IP; inbound reachability is
  never assumed.

### B2 · Bootstrap — *reuse the pieces, add the priority order*
Priority (Bitcoin's "prefer persisted, fall back to seeds"):
1. **Persisted address book** (B4) — try anchors + tried peers first, ~10s
   budget before touching a gateway.
2. **HTTPS bootstrap gateways** — the existing stateless Cloudflare Worker
   (`signaling-node/`, live at `bootstrap.peerd.ai`) is the reference. 4–6
   recommended for diversity. The browser's DNS-seed equivalent: brokers a
   WebRTC handshake into a base rendezvous, then drops out of the data path.
3. **Paste-code / QR** (`transport/pairing.js`, shipped) — the air-gapped path.

Gateways are **untrusted** (a malicious one returns only attacker peers). On
first contact, immediately `GETADDR` and diversify; never keep all connections
sourced from one gateway (cap ≤25%).

### B3 · Connection slots — *extend `transport/mesh.js`*
Chrome's `RTCPeerConnection` ceiling is high (~256) but degrades under load, and
dwapps need slots too, so keep it small:
- **Target 12, floor 8, ceiling 16** base connections (`mesh.js` already caps
  at `budget=16`). Of these: ~8 **structural** outbound (gossip mesh + future
  DHT contacts), up to 4 **inbound/rotating**, 1 **feeler** (every ~2 min: test
  a random address-book entry, then drop — Bitcoin's test-before-promote).
- **2 anchors** — structural peers persisted to IndexedDB, reconnected first on
  restart (the WebRTC `anchors.dat`) to resist restart-eclipse.
- **One pool, globally capped (~64)** for base + all dwapps; the base layer
  arbitrates and may refuse a dwapp's connection request near the cap.

### B4 · Address book (browser addrman) — *new, IndexedDB*
Borrow Bitcoin's two-table design (MIT, code-clean):
- **new** (gossiped, unconnected) bucketed by the *source* that advertised them;
  **tried** (handshake-completed) bucketed by the address's own group key.
- Bucket index = `SHA-256(install-secret || group || …)` truncated — a per-
  install secret so placement is unpredictable. An address may sit in ≤8
  new-buckets. Evict "terrible" first (>7 d unseen, or >5 failed dials).
- **Eclipse hardening, browser-adapted:** no reliable IP /16, so diversify by
  what we observe — (a) the gateway/rendezvous a peer was learned through, (b)
  the advertising source `did`, (c) ICE-derived public IP /16 or ASN where
  visible — and cap any one group's share of base connections (≤25%).
  *Documented as weaker than Bitcoin's IP bucketing.*

### B5 · Signed HELLO — *extend `transport/session.js`*
We already do a signed HELLO handshake on each channel (`session.js`,
`envelope.js`). Extend the record to the base-layer shape:
```
HELLO { v, did, pubkey, caps:["gossip/1", …], ts, nonce, sig }   → HELLOACK (echo nonce, sign)
```
Drop a connection that doesn't complete a valid signed handshake in 10s. After
HELLO, either side MAY `GETADDR`; `ADDR` carries ≤256 signed peer records
(peerd's browser-sized analogue of Bitcoin's 1000-cap).

### B6 · Base gossip mesh — *upgrade `gossip/topic.js`*
Today's `gossip/topic.js` is a deliberately-dumb flooder (seen-cache + per-
sender token bucket + mute) — perfect for a small room, **but it floods every
link**, which doesn't scale to a network. For the **base** topic, upgrade to a
gossipsub-derived mesh:
- One well-known base topic `peerd/base/1` (this *is* the "lobby"). Mesh degree
  **D=6**, D_lo=4 (lowered for browser churn), D_hi=12, heartbeat 1s.
- **Eager-push** full messages to mesh peers + **lazy IHAVE/IWANT pull** (bound
  amplification, guarantee eventual delivery under churn). Flood-publish your
  *own* messages (a partial eclipse can't silence you).
- `GRAFT`/`PRUNE` manage membership; prune to D keeping the D_score=4 best.
- *Small sub-protocol topics can keep the dumb flooder* over the shared links —
  the mesh discipline is for the always-on base topic, not every 3-peer chat.

### B7 · Base message types — *new (the "global protocol")*
All signed by the originator's `did:key`:
- **PEER_ANNOUNCE** — "I exist": `{did, caps, rendezvous_hints, seq, ts, sig}`.
  (Generalizes today's `gossip/presence.js` beacon.)
- **DWAPP_ANNOUNCE** — "this dwapp exists":
  `{dwapp_id, name, latest_version, version_id, publisher_did, content_addr, ts, sig}`
  — the discovery primitive that feeds the **Library** (see below).
- **PEER_ON_DWAPP** — "I'm running dwapp X now": `{did, dwapp_id, dwapp_topic, ts, sig}`.
- **ADDR / GETADDR** — peer exchange (B5), also gossiped for wide propagation.

Message ID = `SHA-256(did || seq || type)` for self-records, `SHA-256(payload)`
for content. Seen-cache ≈5 heartbeats; never re-forward a cached ID; **never
accept a `seq` lower than the highest seen for that publisher** (BEP-44).

### B8 · Suspend / resume — *new, critical*
Laptops close lids constantly. On `online`, on offscreen-document resume, and on
extension start, **re-run reestablishment** (anchors → tried → gateways) and
re-announce. (Hyperswarm's suspend/resume discipline — the one thing the prior
art is unanimous on for browser/desktop lifecycle.)

### B9 · Anti-abuse (v1, honest) — *new + reuse the token bucket*
- **Sign everything** relayed; PING/PONG and IHAVE/IWANT/GRAFT/PRUNE control
  frames MAY be unsigned (point-to-point on an authenticated channel).
- **Rate limits** (per-peer, per-type; `gossip/topic.js` already has a token
  bucket to build on): global 5 msg/s sustained (burst 20); PEER_ANNOUNCE ≤1 /
  10 min; DWAPP_ANNOUNCE ≤1 / 60 s per (publisher, dwapp); ADDR ≤256 records,
  ≤1/min unsolicited.
- **Reduced local score** (never shared): invalid-message penalty (dominant),
  mesh-delivery rate (reward forwarders, punish **black-holes** — holds a slot,
  PONGs, but forwards zero fresh valid messages over 120s), colocation/diversity
  penalty, behavioral penalty (re-GRAFT inside backoff, rate violations).
  *Defer* time-in-mesh / first-delivery / cross-dwapp reputation to v2.
- **Local ban list** in IndexedDB `{did, reason, ts, expiry}`, default 24h,
  refused at HELLO, **user-inspectable and clearable** (local bans can be wrong).
- **Eclipse mitigations:** anchors-first restart (B3), source-diversity caps
  (B4), secret-keyed buckets (B4), feelers (B3), flood-publish (B6).
- **Accepted limit:** without observable IP/ASN for most peers and without
  PoW-bound IDs, eclipse resistance is weaker than Bitcoin's; a resourced
  attacker with many `did`s + gateways can still eclipse a fresh node.

---

## Sub-protocols: the `peerd.distributed.*` capability (DECISIONS #21)

This is where the source doc's `peerd.dwapp` API and our #21 module-grant model
**merge**. Owner naming: `peerd.distributed` is the module (parallel to
`peerd.egress`); the dwapp-facing participation API is the **`peerd.distributed.
dwapp` submodule**. The granted, curated, **quota'd** surface (it signs as the
user):

```js
// base-network info (the "find peers + general info" layer)
peerd.distributed.self                     // { did }
peerd.distributed.peers()                  // [{ did, caps }] — who's on the network

// the dwapp submodule — how an app participates
peerd.distributed.dwapp.join(dwapp_id, opts?)   // → SubProtocol (consent-gated)
peerd.distributed.dwapp.announce({ dwapp_id, name, version, version_id, content_addr })
peerd.distributed.dwapp.find(dwapp_id)          // late-join discovery (gossip → DHT)
peerd.distributed.dwapp.findProviders(content_addr)
peerd.distributed.dwapp.announceProvider(content_addr)

SubProtocol = {                            // returned by join()
  id, self,
  peers(),                                 // who's on THIS dwapp (PEER_ON_DWAPP)
  send(toDid, data),                        // direct 1:1 — ch=3 (private, unforwarded; messaging/direct.js)
  broadcast(data),                          // gossip to the dwapp topic — ch=4 (gossip/topic.js)
  onMessage(cb), onPeer(cb), onPeerGone(cb),
  leave(),
}
```
`find`/`findProviders` are **gossip-backed and DHT-backed both** (gossip for
momentum, the DHT for durable late-join) behind one signature.
- **Key derivation is enforced at the bridge.** A dwapp may write announcements
  keyed only by *its own* publisher key / `dwapp_id`; it may read any item; it
  **cannot** write arbitrary keys, forge another publisher's identity, or use
  the directory as runtime storage (size + rate limits make that natural).
- **Grant + quota lands WITH the wiring** (the #21 hard rule): granting an app
  the `distributed` module = it may `join` and exchange opaque bytes under the
  user's `did`. Shown at first use, remembered per app (the existing bridge-
  grant pattern). Per-app quotas reuse the gossip token bucket + mesh budget +
  new caps (concurrent sub-protocols, peers/min, payload size).
- **Curated, versioned, never reflect `index.js`** — a hand-written surface.

## The Library as the discovery UX (weaving the app model)

The base layer's `DWAPP_ANNOUNCE` and the Library are two halves of one thing:
- **Today (S0, shipped):** the Library lists *local* apps; commons is a
  pre-loaded one tagged `dweb`, and its `dweb` AppRecord slot auto-wires the
  app-tab bridge.
- **Next:** a `DWAPP_ANNOUNCE` heard on the base topic becomes a Library entry —
  a dwapp you can **install from a peer**. We already have the verified
  install-from-peer path (`apps/loader.js` + the `install-app` bridge op +
  `AppRecord.dweb = {uri, publisher, hash}`); the base layer just *feeds* it
  discoveries. The Library filter (`source:'dweb'`, `tags`) is the surface.
- **The shape:** Library shows `local` + `imported` + `dweb` apps; a "dweb"
  section/tag surfaces network-discovered dwapps; opening one that isn't
  installed triggers the verified fetch+install. Provenance (`source`, the
  `dweb` slot's `publisher`) is the trust signal. This is the App-Store-shaped
  surface existing before the network does — now *fed by* the network.

## What we reuse vs. build (mapping onto Phase-1 code)

**Reuse as-is / extend (already in `peerd-distributed/`):**
| Need | Have | Note |
|---|---|---|
| did:key identity (persistent) | `identity/keypair.js` | B1 — done |
| content addressing, signed bundles, chunked transfer | `content/*` | B1 / install-from-peer |
| bootstrap gateway (CF Worker) + signaling reducer | `signaling-node/`, `transport/signaling*.js` | B2 |
| paste-code pairing | `transport/pairing.js` | B2 |
| signed envelopes, HELLO session, WebRTC peer (trickle ICE) | `transport/{envelope,session,peer,channel}.js` | B5 |
| authenticated mesh, ch-multiplexing, budget, ping/idle, relay | `transport/mesh.js` | B3 (add slot roles/feelers/anchors) |
| gossip flooder (seen-cache, token bucket, mute) | `gossip/topic.js` | B6/B9 (add mesh mgmt for base topic) |
| presence beacons | `gossip/presence.js` | B7 → PEER_ANNOUNCE |
| direct 1:1 (ch=3) | `messaging/direct.js` | SubProtocol.send |
| late-join backfill | `gossip/sync.js` | DWAPP late-join (gossip side) |
| room host composition | `room-host.js` | → base-network host + sub-protocol factory |
| the dwapp bridge (postMessage RPC) | `apps/bridge.js` | → `peerd.distributed.*` |
| capability placeholder | `js-tab.js` `peerd.distributed` (#21) | wire here, with grant+quota |

**Build new:** the offscreen base-network host; the browser addrman (IndexedDB,
buckets/anchors/feelers); the slot-role policy; gossipsub mesh management for
the base topic; the base message types (PEER/DWAPP/PEER_ON_DWAPP/ADDR); the
reduced score + ban list + eclipse caps; suspend/resume; the
`peerd.distributed.*` grant+quota surface; the Library↔DWAPP_ANNOUNCE feed.
**Defer:** the DHT + gateway delegated-routing; TURN; global reputation;
PoW IDs; web-of-trust.

## The DHT (in the base layer) — *built + tested*

The content directory, offscreen-hosted, riding the existing mesh — see
`BASE-LAYER.md` for the full architecture + the join-the-network event map.
Built per `PROTOCOL.md §5`: Kademlia, SHA-256 keys, k=8, α=3, **reachable-only
routing tables** (the browser NAT-churn fix — insert a contact only after it
answers), BEP-44 signed mutable items with a no-downgrade `seq`, 1h TTL with
re-PUT self-healing. RPCs ride **ch=1** signed REQ/RESP envelopes, point-to-
point on authenticated links (never forwarded). `dht/{distance,routing-table,
records,store,node,transport}.js`, 18 tests including a full put/get over the
real signed mesh. Still to wire: the **per-hop dialer** (lookups must connect to
contacts we don't currently link — the offscreen base layer supplies it via
rendezvous / mesh-assisted signaling) and an **HTTPS delegated-routing
fallback** on the bootstrap gateways (the Helia `/routing/v1` pattern, as a
miss-fallback) for low-population dwapps. The `peerd.distributed.directory`
surface is shaped so neither is app-visible.

## Phasing (weaving our S-stages with the source doc's v1/v2)

- **S0 — commons as a Library app — ✅ shipped.** App-model integration; no
  network change. (`source:'dweb'`, `tags:['dweb']`, the `dweb` slot wires the
  bridge; seeded page-side from the Library.)
- **S1 — Host → offscreen — ✅ built (needs in-browser verify).** The bridge is
  transport-agnostic (`apps/bridge.js` `iframeTransport` vs an SW relay), and the
  base host runs in the offscreen doc (`offscreen/dweb-base.js`): the SW's
  `dweb/base/*` routes `ensureOffscreen()` then forward to `dweb/base-host/*`.
  *The network now persists beyond any tab.* The WebRTC join + offscreen
  lifecycle can't run under bun — verbose `[offscreen/dweb]` + `[sw]` logging is
  the verification surface.
- **S2 — The lobby (base gossip) — ✅ built (`base-network.js`, 4 sim tests).**
  `peerd/base/1` + DWAPP_ANNOUNCE / PEER_ON_DWAPP over the Phase-1 flooder;
  `createBaseNetwork` wraps `createPeerNode`; apps plug in via `joinSubProtocol`
  (namespaced gossip + a tagged direct router on the shared mesh). Global
  presence is live. Bootstrap priority (B2) + suspend/resume (B8) ride S3.
- **S3 — Base-layer hardening — deferred (evidence-driven).** The browser addrman
  (B4) + slot roles/anchors/feelers (B3); upgrade the base topic to a gossipsub
  mesh (B6); the reduced score + rate limits + ban list + eclipse caps (B9).
  Sized by what S2 reveals under real peers — don't build scoring before there's
  spam to score against.
- **DHT — built (`dht/`, 18 tests).** Kademlia over the mesh (ch=1). Remaining
  wiring: the per-hop **dialer** (connect to lookup contacts we don't link) and
  attaching the node to the offscreen base host's connection pool; the
  Library/directory then has durable late-join discovery, not just gossip.
- **S4 — `peerd.distributed.*` / `.dwapp` — ✅ read side built (needs verify).**
  The #21 placeholder is wired for READS: `peerd.distributed.{whoami,status,
  peers,presence}` in a Notebook relay `distributed-request` → `dweb/distributed/
  info` → the offscreen host's `info()` (rosters, side-effect-free). The dwapp
  participation surface IS `apps/bridge.js` (consent-gated, room-scoped). WRITES
  (`publish`/`announce` — they sign as the user) stay deferred behind the
  grant+quota requirement (#21); `dwapp.find` is gossip-first then DHT-by-publisher
  (`base-network.js findDwapp`). **Always-on trigger:** `maybeStartBaseNetwork()`
  brings the lobby up on vault unlock / PRF / resume (preview + dweb-on).
- **S5+ (v1.1/v2) — gateway delegated-routing fallback; TURN for CGNAT; IPv6-
  preference; optional native super-peer; richer score; and — only on real
  Sybil pressure — S/Kademlia disjoint-path lookups + PoW IDs.**

**Sequencing judgement:** S1–S2 are light and reuse Phase-1 almost wholesale —
ship them to get an always-on lobby fast. S3 is the real engineering (addrman +
mesh management + scoring); do it *driven by* what S2 reveals under real peers,
not speculatively. Don't build the full gossipsub score before there's spam to
score against — the source doc's own caveat (Kumar et al.) is that mis-tuned
scoring is worse than less of it.

**Triggers that change the order:** if S2/S3 field data shows gossip can't find
low-population dwapps → pull the DHT (S5) forward, gateway-fallback first. If
DHT routing-table churn ever eats >30% of the connection budget → make the
gateway delegated-routing the *primary* path. If Sybil/spam appears despite
per-key derivation → pull S/Kademlia PoW IDs forward from v2.

## Open decisions for the owner

1. **DHT timing — RESOLVED: in the base layer** (owner, 2026-06-14). Built +
   tested; remaining is the dialer + offscreen wiring (above).
2. **Base-layer build appetite.** S1–S2 (always-on lobby, reuse Phase-1) is
   small; S3 (addrman + gossipsub mesh + scoring) is the source doc's multi-
   month "v1.0." Build S3 fully up front, or ship S2 and harden S3 as scale
   demands? (I lean: ship S2, harden on evidence.)
3. **Always-on scope.** Dev-preview always-on via the existing `dwebEnabled`
   toggle (one global off-switch), or opt-in per session? Battery + connection
   budget are the cost.
4. **Sub-protocol id namespace.** Content-addressed (the dwapp's bundle hash —
   collision-free, ties protocol to code) where present, free-form strings for
   ad-hoc. The source doc flags ZeroNet's ZeroID collapse: do **not** centralize
   this. Recommend hash-where-present.
5. **Grant granularity.** One `distributed` module grant per app (#21) + a
   per-`join` consent, vs a grant per sub-protocol. Recommend module + per-join.
