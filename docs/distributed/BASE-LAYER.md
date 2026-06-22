# peerd-distributed — base-layer architecture & reference

> The engineering reference for the always-on base network: the modules and
> their functions, the wire protocol (channels, messages, DHT RPCs), and a
> step-by-step map of what happens when a peer joins. Companion to the plan in
> `GLOBAL-NETWORK.md` and the wire spec in `PROTOCOL.md`.
>
> **Status legend:** ✅ built + tested · 🔧 built, needs runtime wiring ·
> 📐 designed, not yet built.

---

## 1. The shape

```
                       ┌─────────────────────────────────────────────┐
   browser tabs        │   OFFSCREEN DOCUMENT (session lifetime)      │
  ┌──────────────┐     │   ┌───────────────────────────────────────┐ │
  │ app-tab      │     │   │  BASE NETWORK  (one per instance)      │ │
  │ (dwapp       │◀────┼──▶│   identity · addrman · mesh            │ │
  │  iframe)     │ SW  │   │   gossip(base topic) · presence        │ │
  │ peerd.       │ msg │   │   DHT directory · score · ban          │ │
  │ distributed.*│     │   └───────────────────────────────────────┘ │
  └──────────────┘     └─────────────────────────────────────────────┘
        │  postMessage bridge          ▲  WebRTC data channels
        ▼  (grant + quota, #21)        │  (DTLS, one pool, ~12 links)
   the dwapp's own                     ▼
   message semantics            other peerd instances
```

- The **base network** runs in the offscreen document because it must outlive
  any tab (an App's lifetime *is* its tab). The service worker can't host it (no
  dynamic `import`, dies at 30s idle, can't hold sockets) — it is the **router**
  between tabs and the offscreen host.
- All peers share **one connection pool** (~12 base links, 16 ceiling). Gossip,
  direct messages, the DHT, and content transfer all **multiplex over the same
  links** by channel number — there is no separate per-feature connection set.

---

## 2. Channels (the multiplexer)

Every frame on a mesh link is either a content-transfer string frame or a
**signed envelope** `{ v, ch, typ, from, body, id, ts, sig }`. The mesh routes
by `ch` (`transport/mesh.js` `handle()`):

| ch | name | typ values | forwarded? | auth rule |
|----|------|-----------|-----------|-----------|
| 0 | **control** | PING/PONG, ROSTER_REQ/ROSTER, RELAY | RELAY: 1 hop, signer→neighbour only | signed by the neighbour |
| 1 | **DHT** ✅ | REQ / RESP (wrapping PING/FIND_NODE/FIND_VALUE/STORE) | never | `from === link.did` |
| 2 | **content** | MANIFEST_REQ/CHUNK_REQ/… (string `t` frames) | never | served from the announce set |
| 3 | **direct** ✅ | MSG (1:1 private) | never | `from === link.did` |
| 4 | **gossip** ✅ | PUB, SYNC_REQ/RESP | **flooded** (re-broadcast) | origin-signed, `from` ≠ link |

The rule that makes this safe: **only ch=0 RELAY is ever forwarded.** Every
other non-gossip channel requires `from === link.did` — a frame can only be
delivered by the neighbour that signed it. So a DHT RPC (ch=1) or a direct
message (ch=3) is a point-to-point exchange between two mutually-authenticated
peers; it can't be relayed or laundered. Gossip (ch=4) is the only channel that
floods, and it carries its origin in `from` (≠ the relaying link).

---

## 3. Module & function map

### Identity & content — ✅ built (`identity/`, `content/`)
- `identity/keypair.js` — `generateIdentity()`, `createPersistentIdentity()`
  (vault-stored Ed25519), `importIdentity()`, `verifySignature(did, sig, bytes)`.
- `identity/did.js` — `encodeDidKey(pub)`, `decodeDidKey(did)`.
- `content/{uri,manifest,bundle,chunk,store,transfer}.js` — `peerd://<did>/<sha256>`
  addresses, signed manifests, chunked verified transfer, the announce set.

### Transport — ✅ built (`transport/`)
- `channel.js` — `createBufferedChannel({send})`, `memoryPair()` (the test seam).
- `envelope.js` — `buildEnvelope`, `signEnvelope`, `verifyEnvelope`.
- `session.js` — `createSession({channel, identity})` → the signed HELLO that
  proves the remote `did` before a link enters the mesh.
- `peer.js` — `createPeer()` (WebRTC + trickle ICE), `DEFAULT_ICE_SERVERS`.
- `signaling.js` / `signaling-client.js` — the pure rendezvous reducer
  (`signalingStep`, `ROOM_CAP`) + the browser client (`openRendezvous`,
  `connectViaSignaling`, `DEFAULT_SIGNALING`).
- `rooms.js` — `joinRoom()` / `joinRoomViaCode()`: the three join paths
  (rendezvous, mesh-assisted relay, invite code) and the dial loop.
- `mesh.js` — `createRoomMesh()`: the authenticated peer set. Key methods:
  `addLink(channel, did)`, `send(did, env)` (directed), `broadcast(env, except)`
  (flood), `sign(ch, typ, body)`, `onEnvelope(cb)`, `onPeer/onPeerGone`,
  `relay(via, to, kind, sid, payload)`, `requestRoster(did)`, `peers()`.
- `pairing.js` — `createOffer/acceptOffer/acceptAnswer` (paste-code dance).
- `ice.js` — `connectionPath`, `summarizeCandidates`, `DirectPathUnavailableError`.

### Gossip & messaging — ✅ built (`gossip/`, `messaging/`)
- `gossip/topic.js` — `createGossip({mesh})`: the room-wide flooder.
  `publish(topic, data)`, `subscribe(topic, cb)`, `tap`, `ingest`, `mute`. Has a
  seen-cache (sig-keyed) + per-sender token bucket. **(Base-topic upgrade to a
  gossipsub mesh — D=6, IHAVE/IWANT — is 📐.)**
- `gossip/presence.js` — `createPresence()`: beacons → who's here. → PEER_ANNOUNCE.
- `gossip/sync.js` — `createTopicSync()`: late-join backfill for retained topics.
- `messaging/direct.js` — `createDirect({mesh})`: `send(toDid, data)`,
  `onMessage(cb)` — genuinely-private 1:1 over ch=3 (directed, unforwarded).

### DHT — ✅ built (`dht/`), 🔧 needs the dialer + offscreen wiring
- `dht/distance.js` — the keyspace.
  `nodeIdOf(did) → SHA-256(pubkey)` (32 bytes), `keyOf(bytes)`, `xor`,
  `compareBytes`, `closerTo(target, a, b)`, `bucketIndex(selfId, id)`
  (shared-prefix length, 0..255), `byDistanceTo(key, contacts)`.
- `dht/routing-table.js` — `createRoutingTable({selfId, k=8})`. `seen(contact)`
  (reachable-only insert; returns `{added}` or `{evictCandidate}` for a full
  bucket), `replace(deadDid, contact)`, `closest(key, count)`, `remove`, `has`,
  `staleBuckets(ms)`. LRS-preferring eviction (keep long-lived nodes).
- `dht/records.js` — BEP-44 signed mutable items. `signItem({value, seq, salt}, id)`,
  `verifyItem(item)`, `itemKey(item)`, `mutableKey(pubkey, salt)`,
  `MAX_ITEM_BYTES=2048`. Key = `SHA-256(pubkey || salt)`; monotonic no-downgrade `seq`.
- `dht/store.js` — `createDhtStore({persist?})`. `put(item) → {ok, reason?}`
  (validates sig/key/seq/size; rejects `seq-downgrade`), `get(hexKey)`, 1h TTL.
- `dht/node.js` — `createDhtNode({identity, selfId, store, rpc})`. `handle(from, msg)`
  (serves the 4 RPCs), `lookup(targetKey, {wantValue})` (iterative α=3),
  `put(item)` (store at the k-closest), `get(keyBytes)`, `learn(did, hints)`.
- `dht/transport.js` — `attachDht({mesh, identity, selfId, store, dial})` →
  `{node, detach}`. Binds the node to the mesh: ch=1 signed REQ/RESP, and an
  `rpc()` that ensures a link (reuse or **`dial(contact)` — the 🔧 piece the
  base host supplies**) before round-tripping.

### Assembled host & bridge — ✅ Phase-1 / 📐 base layer
- `room-host.js` — `openRoomHost()`: composes gossip+presence+sync+direct+content
  for one room. **The base-network host (📐) generalizes this**: always-on,
  offscreen, + the DHT + addrman + the base message types.
- `apps/bridge.js` — `createDwebBridge()`: the dwapp postMessage RPC (today the
  room ops). **Becomes `peerd.distributed.*` / `.dwapp` (📐)** with grant+quota.
- `apps/{loader,seed}.js` — verified install-from-peer + the commons seed app.

### Planned base-layer modules — 📐
- `addrman.js` — the IndexedDB bucketed address book (new/tried tables,
  secret-keyed buckets, anchors, feelers, source-diversity caps).
- `base-network.js` — the always-on host: bootstrap order, slot policy, the base
  topic + PEER_ANNOUNCE/DWAPP_ANNOUNCE/PEER_ON_DWAPP/ADDR, score + ban, the DHT
  dialer, suspend/resume.

---

## 4. The DHT, end to end (✅ built)

```
put(item):                              get(key):
  1. itemKey = SHA-256(pubkey||salt)      1. local store hit? → return
  2. store locally (we may be k-closest)  2. lookup(key, wantValue):
  3. lookup(key) → k closest contacts        repeat α=3 parallel FIND_VALUE
  4. STORE (ch=1) to each                       to the closest unqueried,
  5. each holder validates:                     merging returned NODES,
     sig ✓ · key==pubkey-derived ✓ ·            until a holder returns VALUE
     seq not downgraded ✓ · ≤2KB ✓              or the near set is exhausted
```

- **Reachable-only:** a contact enters a routing table only via `learn()`, which
  the lookup calls *after* that contact answered — never on first hearing. In
  browsers (most peers NATed, many send-only) this is the difference between a
  live table and a dead one.
- **No-downgrade across the wire:** a replayed old-`seq` STORE is refused by every
  holder (tested in `dht-over-mesh.test.ts`).
- **What it stores** (all BEP-44 mutable, signed by a known publisher):
  dwapp-announcement records, publisher version pointers, content-provider lists,
  peer-reachability hints. It does **not** store dwapp runtime state — that's
  gossip (ch=4). The DHT is durability (find what you missed); gossip is momentum.

---

## 5. Joining the network — the event sequence

What happens, step by step, when a peerd instance comes online. (✅ = the
mechanism exists today; 📐 = the base-layer wiring that composes it.)

```
0. BOOT (offscreen document loads, dwebEnabled)                          📐
   └─ load the persistent identity (vault did:key)                       ✅
   └─ open IndexedDB: address book, DHT store, ban list                  📐/✅

1. BOOTSTRAP — get a first live link (priority order)                    📐
   a. persisted address book: dial anchors, then tried peers (~10s)      📐
   b. HTTPS bootstrap gateway (CF Worker, bootstrap.peerd.ai):           ✅
        openRendezvous(base room) → SDP/ICE exchange (trickle)           ✅
        → WebRTC data channel to ≥1 peer                                 ✅
   c. paste-code / QR (air-gapped fallback)                              ✅

2. HELLO — authenticate each new link                                    ✅
   └─ createSession: exchange signed HELLO {did, pubkey, caps, nonce}    ✅
   └─ verify sig, prove the remote did, mesh.addLink(channel, did)       ✅
   └─ a link that doesn't complete a signed HELLO in 10s is dropped      ✅

3. DIVERSIFY — don't depend on one source                               📐
   └─ GETADDR the first peer; receive signed ADDR (≤256 records)        📐
   └─ insert into the addrman "new" table, bucketed by source           📐
   └─ cap any one gateway/source at ≤25% of base links                  📐
   └─ feeler: every ~2 min test a random new-table address, then drop   📐

4. JOIN THE BASE GOSSIP MESH (topic peerd/base/1 — "the lobby")          📐(✅ flooder)
   └─ GRAFT to D≈6 mesh peers; eager-push + lazy IHAVE/IWANT            📐
   └─ broadcast PEER_ANNOUNCE {did, caps, hints, seq}  ("I exist")       ✅(presence)
   └─ receive others' PEER_ANNOUNCE / DWAPP_ANNOUNCE / ADDR             📐
   └─ flood-publish our own announce (a partial eclipse can't silence)  ✅

5. FILL THE DHT ROUTING TABLE                                            🔧
   └─ for each mesh neighbour that answers a DHT PING → node.learn()    ✅
   └─ lookup(selfId): a self-FIND_NODE seeds buckets near us            ✅
   └─ refresh stale buckets periodically (staleBuckets)                 ✅
   └─ (lookups to non-linked contacts use the dialer — the 🔧 piece)

6. ANNOUNCE & DISCOVER                                                   ✅(dht)/📐(feed)
   └─ publisher: dwapp.announce → DWAPP_ANNOUNCE on gossip AND          📐
        node.put(signed record) into the DHT (k-closest hold it)        ✅
   └─ peer running a dwapp: PEER_ON_DWAPP gossip + announceProvider     📐
   └─ a late joiner who missed the gossip wave:                         ✅
        dwapp.find(id) → node.get(SHA-256("dwapp:"+id)) → the record    ✅
   └─ DWAPP_ANNOUNCE → a Library entry → install-from-peer (verified)   📐(feed)/✅(loader)

7. STEADY STATE                                                         ✅/📐
   └─ 30s PING/PONG heartbeat; miss 2 → drop the link                  ✅(mesh sweep)
   └─ local score per neighbour; black-hole / rate-violator → prune+ban 📐
   └─ publisher re-PUTs DHT items every ~30 min (1h TTL self-healing)   ✅(store)/📐(timer)

8. SUSPEND / RESUME (lid close, sleep, `online` event)                  📐
   └─ on resume: re-run bootstrap (anchors→tried→gateway),             📐
        re-announce PEER_ANNOUNCE, re-PUT DHT items, reconnect k-closest 📐
```

A dwapp's own join (e.g. opening commons) rides step 6: `peerd.distributed.dwapp.
join("commons")` subscribes the dwapp's gossip topic + direct channel over the
*already-connected* base links, and announces `PEER_ON_DWAPP`. No new rendezvous,
no new mesh — the base layer is already there.

---

## 6. Anti-abuse (honest v1)

- **Sign everything relayed** (HELLO/ADDR/PEER_ANNOUNCE/DWAPP_ANNOUNCE/STORE).
  Control + IHAVE/IWANT frames may be unsigned (point-to-point, no relayed payload).
- **Rate limits** (token bucket, `gossip/topic.js` has the base): global 5 msg/s
  (burst 20); PEER_ANNOUNCE ≤1/10min; DWAPP_ANNOUNCE ≤1/60s; DHT STORE ≤10/s; items ≤2KB.
- **Reduced local score** (never shared): invalid-message (dominant), mesh-delivery
  / black-hole, colocation/diversity, behavioral. Below threshold → ignored; sustained
  negative → local ban (IndexedDB, default 24h, user-clearable).
- **Eclipse mitigations:** anchors-first restart, source-diversity caps, secret-keyed
  addrman buckets, feelers, gossip flood-publish.
- **Sybil — accepted limit:** signed `did:key` stops forgery, not key-minting; local
  scoring + diversity raise cost but don't guarantee. A resourced attacker with many
  `did`s + gateways can still Sybil/eclipse a fresh node. v2: disjoint-path lookups,
  PoW IDs, or social-graph — only on observed pressure.

---

## 7. Build status (this branch)

| Layer | Status |
|---|---|
| identity · content addressing · signed transfer | ✅ |
| WebRTC transport · mesh · HELLO · trickle ICE | ✅ |
| gossip flooder · presence · sync · direct (ch=3) | ✅ |
| rooms (rendezvous · mesh-assisted · invite) | ✅ |
| commons as a Library app (S0) | ✅ |
| **DHT: distance · routing-table · records · store · node · transport** | **✅ (18 tests)** |
| DHT per-hop dialer + offscreen attach | 🔧 |
| base-network host (always-on) · addrman · base message types | 📐 |
| gossipsub mesh upgrade (D=6, IHAVE/IWANT) for the base topic | 📐 |
| `peerd.distributed.*` / `.dwapp` surface (grant+quota) | 📐 |
| Library ↔ DWAPP_ANNOUNCE discovery feed | 📐 |
| score + ban list + eclipse caps + suspend/resume | 📐 |
| gateway delegated-routing · TURN · disjoint paths · PoW IDs | 📐 (v1.1/v2) |
