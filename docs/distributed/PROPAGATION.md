# dwApp propagation — the global app network (RFC)

> Status: **RFC / DESIGN — not yet built.** The plan for how a shared
> dwApp reaches every node, scales past its author, and stays honest under
> abuse. Builds on `GLOBAL-NETWORK.md` (the base-layer plan), `THREAT-MODEL.md`
> (the adversary model), and the merged on-connect greet (PR #4). Nothing here
> is implemented; this doc is the gate before code.

---

## TL;DR

- **Two planes, opposite physics.** *Metadata* (the "this app exists" card) is
  small, signed, size-capped, and **propagates**. *App data* (the bundle —
  WASM included) is large and is **pulled on demand**, never propagated.
- **Metadata is a sovereign subscription feed, not an ambient flood.** A node
  never receives metadata it didn't ask for. On connect it *subscribes* to a
  peer's discovery feed; the peer replies with a snapshot and then streams new
  items. A node can unsubscribe ("stop") or ban a peer (for any reason) at will.
- **App data rides the DHT.** Discover by gossiped id → find providers in the
  DHT → swarm-fetch the bytes from one or more peers who hold it.
- **Popularity = availability, on both planes.** Installing an app makes you a
  seeder. An app with seeders stays discoverable *and* installable; an app with
  zero seeders disappears from both planes. Unpopular things dying is the design,
  not a bug.
- **Abuse defense is mostly structural.** You can't be pushed to without
  subscribing; you only seed what you deliberately installed; every record is
  publisher-signed; bans are unilateral. Rate limits and blocklists handle the
  residue.

---

## The problem this solves

Today (after PR #4) a dwApp announcement is propagated by exactly three things,
**all of them the original author's node**: the share-time gossip flood, a 30s
re-announce timer (`offscreen/dweb-base.js`), and the on-connect greet
(`base-network.js`). The author is a single point of propagation *and* a single
point of availability:

- **It doesn't reach far.** Gossip is fire-and-forget; a node two hops away, or
  one that joins after the flood, only learns of the app if the author personally
  re-announces to it.
- **It dies with its author.** The durable DHT copy is keyed `(publisher, id)` —
  reachable only by someone who already knows both (i.e. from an install link),
  never by cold browsing. When the author goes offline, the app is gone.

A true global network needs apps to be carried, and served, by **more than the
node that made them**. That is this doc.

---

## The two planes

| | **Metadata plane** | **App-data plane** |
| --- | --- | --- |
| Payload | the app card: id, name, description, latest-version pointer | the signed bundle (HTML/JS/WASM/assets) |
| Size | tiny, hard-capped (≤4 KB) | unbounded (WASM-heavy; ceiling 50 MB) |
| Movement | **propagates** (subscription feed) | **pulled on demand** (never propagated) |
| Mechanism | sovereign subscribe → snapshot + deltas | DHT provider lookup → multi-peer swarm fetch |
| Lands in | your **Library** (discoverable, not installed) | your **install set** (you become a seeder) |
| Reuses | `gossip/topic.js` + `gossip/sync.js` | `content/*` (chunked transfer) + `dht/*` |

The split is the whole design: you spend liberal **propagation** on the thing
that's cheap to propagate, and you spend **bandwidth + storage** only on
deliberate installs.

---

## Plane 1 — metadata as a sovereign subscription feed

### The record (the "app card")

A small, publisher-signed card that names an app and points at its latest
version. It never carries the bytes.

```
DWAPP_META {
  dwapp_id,                 // STABLE app identity = H(publisher_did ‖ slug)  (§ identity)
  name,                     // ≤64 chars
  description,              // ≤512 chars
  publisher_did,
  head: {                   // the "latest version" — a signed amendment
    version_id,             // = content hash of THIS version's bundle
    content_addr,           // peerd://<publisher>/<bundle-hash>  — where the bytes live
    size,                   // total bundle bytes — the Library warns before a big download
    seq,                    // monotonic, no-downgrade (BEP-44 discipline)
    ts,
    sig                     // publisher signs the amendment
  },
  icon?,                    // by reference (a content_addr), NEVER inline
  sig                       // publisher signs the record
}
```

Hard byte ceiling enforced at ingest — an oversized record is rejected and
audited, never relayed. This cap is what keeps propagation cheap enough to be
liberal.

### Sovereign, event-driven: you don't get what you didn't ask for

The defining rule: **a node never pushes metadata to a peer that hasn't
subscribed.** Discovery is a *pull-initiated, revocable* subscription, not an
ambient broadcast. This makes spam resistance **structural** — under a flood the
defense is reactive (throttle/ban after the spam lands); under subscription
there is simply no edge to deliver unsolicited metadata over.

The protocol is small and maps almost 1:1 onto primitives that already exist:

```
SUBSCRIBE{discovery}    A→B   "send me your discovery metadata"
   → B replies with a SNAPSHOT — the whole metadata Library B is willing to
     share (minus B's blocklist), capped + paged.        [shape: gossip/sync.js backfill]
   → B registers A as a discovery subscriber; from then on B forwards each NEW
     valid item it accepts to its subscribers.            [gossip, scoped to subscribers]

UNSUBSCRIBE{discovery}  A→B   "stop"   → B drops A from its subscriber set.

BAN                     local        → refuse subscriptions, drop the link,
                                       blocklist the did. Unilateral, any reason.
                                       [mesh.removeLink + blocklist, THREAT-MODEL §9]
```

Mechanically, `gossip/topic.js`'s `broadcast(env)` (send to *every* link)
becomes **send to the subscribers of this topic**. Everything else stays: the
sig-keyed seen-cache (loop guard), per-sender token bucket, sig-dedup. So this
is an additive change — a **subscriber registry** that gates *who you forward
to*, plus the snapshot-on-subscribe (the `sync.js` have-list/backfill shape) —
not a rewrite.

### Decisions (settled)

- **Default subscribe on connect.** A new link auto-subscribes to the peer's
  discovery feed, so propagation stays alive by default. The sovereign escape is
  a global "discovery off" switch and per-peer unsubscribe/ban. *(owner, this
  thread)*
- **Snapshot scope = whole Library.** On subscribe you serve everything you've
  heard (minus blocklist, capped), not just your own + installed. So an average
  node is a **relay**, not a leaf — this is what gives transitive reach. *(owner)*
- **All-or-nothing per peer.** One discovery subscription per peer; no
  category/curator scoping yet. Curated/scoped subscriptions are a later
  curation-layer feature, added when needed. *(owner)*

### Reach is transitive over consented edges

Liberal forwarding (relay every valid item to your subscribers) + sovereign
intake (receive only from peers you subscribed to) coexist: you subscribe to
your peers, they forward everything *they* accept (from *their* subscriptions),
so metadata still saturates the connected mesh hop-by-hop — every hop now an
explicit, revocable subscription instead of an unconditional push. Loops die on
the seen-cache exactly as today.

### This retires the push-greet (PR #4)

PR #4's on-connect greet *pushes* the author's shares unsolicited, and the 30s
timer re-floods them. The sovereign model **inverts both**: the newcomer asks
(`SUBSCRIBE`), the peer answers (`SNAPSHOT`), and live items flow as deltas — no
unsolicited push, no periodic re-flood. The merged greet stands as an interim;
this design explicitly **replaces** it rather than layering on top. The
`gossip.republishTo` primitive added in PR #4 is either repurposed for the
subscriber-scoped send or removed.

---

## Plane 2 — app data over the DHT

The bundle is content-addressed (`peerd://<publisher>/<bundle-hash>`), chunked
(256 KB), and per-chunk verified — all already built (`content/*`). It is
**never propagated**; it is fetched on demand:

- **The DHT holds providers, not bytes.** A `content` record keyed
  `H(content_addr)` → `{ holders:[did…] }`. `announceProvider(content_addr)` adds
  you; `findProviders(content_addr)` returns the holder set. (This is exactly the
  liability firewall — `THREAT-MODEL §2`: the DHT stores *who has it*, never the
  content.)
- **Install makes you a seeder.** Fetch → verify (manifest sig + every chunk
  hash) → store in your announce set → `announceProvider`. Now you serve it.
- **Multi-peer swarm fetch.** `findProviders` → pull chunks from several holders
  in parallel over the existing chunk layer. This is what makes a 40 MB WASM
  bundle feasible — you don't depend on one seeder's uplink.
- **Liability firewall intact.** You serve only chunks in your announce set =
  only apps you deliberately installed. No opportunistic caching, no pass-through.

### The user flow

1. **Discover** — `DWAPP_META` arrives over your discovery subscriptions and
   lands in your Library. Zero bytes pulled.
2. **Install** — take `head.content_addr` → `findProviders` → swarm-fetch →
   verify → **confirm-gated** install into the opaque-origin sandbox →
   `announceProvider`. You're now a seeder.
3. **Update** — the publisher signs a new `head` (`seq+1`) → it propagates over
   the metadata plane → your Library flags "update available" → you fetch the new
   bundle the same way.

### The dependency

Plane 2 needs the DHT's **per-hop dialer** — connecting to providers you don't
already link — which `GLOBAL-NETWORK.md` flags as the one unbuilt piece (the
`dht/` core is built + tested, 18 tests). Plane 2 cannot ship without it.

---

## App identity & versioning

`dwapp_id = H(publisher_did ‖ slug)` — a **stable** identity, distinct from
`version_id` (the per-version bundle hash). This is forced by versioning: a
version bump changes the bundle hash, so the hash can't *be* the identity. The
id is:

- **stable across versions** — updates keep the same `dwapp_id`;
- **namespaced under the publisher** — two authors can both ship a "tictactoe";
  they are different ids, disambiguated by publisher in the Library;
- **decentralized** — no global slug registry to centralize or capture (the
  ZeroNet/ZeroID failure `GLOBAL-NETWORK.md` Q4 warns against).

**Versioning = signed amendment, no-downgrade `seq`.** Only the publisher key can
author a new `head` (publisher binding). A receiver never accepts a `seq` lower
than the highest seen for that `dwapp_id` — a rollback attack can't downgrade a
node to an older, perhaps-vulnerable version. An app is bound to its publisher
key for life; if that key is lost the app freezes at its last `head` (others can
still seed the last bundle) — key recovery / app transfer is out of scope for v1.

> **Change from today:** the current code sets `dwapp_id = bundle hash`
> (`base-network.js` share path), which can't survive a version bump. This split
> is a prerequisite, not an enhancement.

---

## Popularity = availability (one rule, both planes)

The same eviction rule runs on both planes, so an app's reach tracks real
adoption:

- **App data:** providers re-PUT their `content` record (~1 h TTL, re-PUT every
  ~30–45 min). A provider that leaves stops re-PUTting; its holder entry expires.
  Zero providers → unfetchable.
- **Metadata:** a Library evicts least-recently-announced and **zero-provider**
  entries first. An app nobody seeds stops being re-announced (its author is
  gone and no installer carries it), ages out of Libraries, and disappears.

So an unpopular or abandoned app dies on *both* planes at once — by design. A
popular app stays discoverable and installable for as long as anyone runs it,
with no author and no server required.

---

## Resource limits & abuse

Sovereignty does the heavy lifting; limits and blocklists handle the residue.
All numbers are reasoned defaults to validate under load, not proven optima.

| Lever | Default | Why |
| --- | --- | --- |
| Metadata record size | ≤ 4 KB (name ≤64, desc ≤512, icon by ref) | keeps propagation cheap |
| Announce rate | ≤ 1 per `(publisher, dwapp)` / 60 s | per-author spam brake |
| Relay volume | ≤ ~60 distinct **new** apps / node / min | bounds amplification |
| Library store | ~10 k entries; evict LRA + zero-provider | bounded discovery cache |
| Snapshot | paged; capped total per subscribe | a fresh subscriber can't pull an unbounded dump |
| Bundle ceiling (dweb) | 50 MB | WASM-friendly, still bounded |
| Provider storage quota | 500 MB, user-set | caps what you seed |
| Serve bandwidth | per-peer cap | a popular app can't saturate your uplink |
| DHT provider PUT | ~1 h TTL, re-PUT ~30–45 min, ~100 ms PoW | self-healing + poison cost |

Mapped to the threat model:

- **Structural (not bypassable):** can't push to a non-subscriber; can't be
  forged (every record publisher-signed, `§3`/`§4`); can't seed what you didn't
  install (announce-set firewall, `§2`); bans are unilateral.
- **Discovery is *open* by design**, so it can't use messaging's Tier-2
  default-deny. Its defenses are instead: content-addressing + signatures +
  subscription consent + rate caps + **blocklist-gated relay** (you never
  forward or seed a blocked publisher) + **no global ranking to game** (`§6` —
  visibility flows along the subscription graph, so a Sybil swarm announcing 10 k
  fake apps buys reach into nobody's curated view).
- **Propagation never *runs* anything.** It moves *announcements*; running an app
  still requires an explicit, every-time-confirmed install of a fully-verified
  bundle into the sandbox (`§13`). A malicious announcement's blast radius is "it
  appears in a list," not "it executes."
- **Accepted limits** (unchanged from `GLOBAL-NETWORK.md` B9 / `THREAT-MODEL §5`):
  without observable IP/ASN and without PoW-bound ids, a resourced attacker with
  many dids + gateways can still Sybil/eclipse a fresh node. Stated, not solved.

---

## The scaling boundary (honest)

Liberal metadata propagation works cleanly up to **thousands** of apps: every
node's Library converges to "everything its connected component carries," and the
DHT stays purely the app-bytes layer. This is v1.

It **cannot** scale to **millions** of apps — propagating *all* metadata is then
the bottleneck. The named next lever (build only when load demands, per the
roadmap's "don't build for unmeasured scale" rule):

- mirror metadata into the DHT keyed by `H(dwapp_id)` (resolve any id without
  having heard it), re-PUT by seeders;
- Libraries hold a **working set** (subscribed/curated/recent), not everything;
- discovery-at-scale flows along the **curation graph** (subscribed lists /
  trusted curators, `THREAT-MODEL §6` + ROADMAP Phase 5), with on-demand DHT
  resolution for specific ids.

This is a *second mechanism*, deferred — not free, and not v1.

---

## What changes vs. today

- `dwapp_id` splits from `version_id` (identity vs. bundle hash) — prerequisite.
- The **push-greet + 30s re-flood** (PR #4, `dweb-base.js`) are **retired** in
  favor of subscribe → snapshot → deltas.
- `heardDwapps` (in-memory map) grows into a **bounded, persistent, versioned
  Library** (IndexedDB) with eviction + blocklist.
- `gossip/topic.js` gains a **subscriber registry**; `broadcast` becomes
  subscriber-scoped.
- The DHT gains **provider records** + `announce/findProviders`, and the **per-hop
  dialer** is wired (the known gap).
- The **install ceiling** forks: the agent's `app_create` cap (2 MB / 64 files,
  `apps/loader.js`) stays; dweb-installed apps get a separate larger ceiling
  (50 MB) with the size-warning + swarm fetch.

---

## Build order (once this RFC is approved — not before)

1. **Metadata subscription plane.** Subscriber registry + `SUBSCRIBE`/`SNAPSHOT`/
   delta/`UNSUBSCRIBE`/`BAN`; default-subscribe-on-connect; retire the push-greet;
   persistent bounded Library. Reuses `gossip/{topic,sync}.js`. *(the first PR)*
2. **DHT provider sets + dialer.** `announceProvider`/`findProviders`, re-PUT,
   PoW; wire the per-hop dialer into the offscreen base host.
3. **Swarm fetch + big-app policy.** Multi-provider chunk fetch; the dweb-app
   ceiling, size field/warning, provider storage quota.
4. **Versioning.** `dwapp_id`/`version_id` split; signed `head` amendments;
   no-downgrade `seq`; "update available" in the Library.
5. **Abuse track, ongoing.** Caps + blocklist-gated relay land with step 1; the
   local peer score waits until there's real spam to tune against (Kumar et al.:
   mis-tuned scoring is worse than less of it).

---

## Open / proposed (confirm in review)

The six load-bearing decisions are settled (two planes; sovereign subscription;
default-subscribe; whole-Library snapshot; all-or-nothing; `(publisher, slug)`
identity; popularity=availability; defer the metadata-DHT). Still marked
*proposed* and open to redline: the **caps table numbers** (sizes, rates, the
50 MB ceiling, 500 MB quota) — defaults to validate under load, not commitments.

---

## Decision log

- **2026-06-16 — two-plane split** (owner): metadata propagates + is size-capped;
  app data is DHT-pulled. WASM/big-app downloads must never ride the propagation
  path.
- **2026-06-16 — sovereign, event-driven nodes** (owner): no unsolicited push;
  subscribe-on-connect; unsubscribe; unilateral ban. Default-subscribe,
  whole-Library snapshot, all-or-nothing per peer for now.
- **2026-06-16 — popularity = availability** (owner): no seeders → gone, on both
  planes, by design.
