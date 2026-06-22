# peerd-distributed — Protocol & Wire Formats

> Precise enough to implement without reading peerd's source. Defines
> identity encoding, signing payloads, the wire envelope, content
> manifests, DHT records, messaging, and audit event types.

**Conventions used throughout.**

- **Bytes** are shown as fixed-length fields; multi-byte integers are
  big-endian unless noted. `||` is concatenation.
- **base64** means standard base64 (with padding) of raw bytes, unless a
  field says `base64url`.
- **JSON canonicalization**: all signed JSON objects are serialized with
  **JCS (RFC 8785)** — sorted keys, no insignificant whitespace, UTF-8.
  The signature is computed over the JCS bytes of the object **with the
  `sig` field absent**, then `sig` is added. Verifiers reconstruct by
  removing `sig`, re-serializing with JCS, and checking.
- **Signing domain separation**: every signature is over
  `ASCII(domain_tag) || 0x00 || payload`. Domain tags are namespaced
  `peerd/<purpose>/v1`. The `0x00` byte prevents tag/payload ambiguity.
  This makes a signature for one purpose useless for another.
- **Hashes** are SHA-256 (32 bytes). When a hash appears in a URI or JSON
  string it is lowercase hex unless the field says `multibase`.
- **Time** is integer milliseconds since the Unix epoch (matches the V1
  `now: Date.now` injection and UUIDv7 ordering).
- All crypto is **WebCrypto** (`crypto.subtle`): Ed25519, X25519, HKDF-
  SHA256, AES-256-GCM, SHA-256, PBKDF2 (the last only inside the vault).
  No vendored crypto library.

---

## 1. Identity encoding

### 1.1 did:key (Ed25519)

```
did:key:z<base58btc( 0xed01 || ed25519_pubkey[32] )>
```

- `0xed` `0x01` is the multicodec varint for an Ed25519 public key.
- `z` is the multibase prefix for base58btc.
- The resulting string is the canonical, stable identifier of a peer. It
  is what `peerd://<publisher_did>/…` embeds and what the trust tiers key
  on.

`identity/did.js` exposes:

```js
encodeDidKey(pubkey32: Uint8Array): string       // → "did:key:z6Mk..."
decodeDidKey(did: string): Uint8Array            // → pubkey32, throws on bad prefix/codec
nodeIdOf(did: string): Uint8Array                // → SHA-256(utf8(did)), 32B Kademlia node ID
```

### 1.2 Key material summary

| Key | Curve | Source | Stored |
|---|---|---|---|
| Identity | Ed25519 | HKDF(PRF output) seed, or vault-random fallback | vault secret `distributed/identity/seed` |
| Agent subkey | Ed25519 | per-agent random | vault secret per agent |
| Encryption subkey | X25519 | random, generated once | vault secret `distributed/enc/x25519` |
| Per-message ephemeral | X25519 | random per message | not stored |

---

## 2. Certificates (subkey binding)

A certificate binds a subkey to an identity. JCS-serialized JSON, signed
by the **identity** key.

### 2.1 Agent cert

```json
{
  "v": 1,
  "type": "agent-cert",
  "user": "did:key:z6MkUser...",
  "agent": "<base64 ed25519 agent pubkey>",
  "notBefore": 1733650000000,
  "notAfter": 1765186000000,
  "sig": "<base64 ed25519 sig>"
}
```

- Signing payload: `"peerd/agent-cert/v1" || 0x00 || JCS(obj without sig)`.
- Publishing the cert is **optional**. Omit it to keep the agent
  unlinkable from the user; present it on demand to prove ownership.

### 2.2 Encryption cert

Identical shape with `"type": "enc-cert"`, `"key": "<base64 x25519 pub>"`,
domain tag `peerd/enc-cert/v1`. Always publishable (needed so others can
seal to you), and itself published as a DHT record (§5.4, `key:` class).

### 2.3 Republish delegation

Authorizes a relay to re-`PUT` specific records while the publisher is
offline (`ARCHITECTURE.md §5.4`).

```json
{
  "v": 1,
  "type": "republish-delegation",
  "user": "did:key:z6MkUser...",
  "recordKeys": ["<hex>", "<hex>"],
  "relay": "did:key:z6MkRelay...",
  "notAfter": 1767000000000,
  "sig": "<base64>"
}
```

Domain tag `peerd/republish/v1`. The relay may only re-publish records the
publisher already signed; it gains no authoring power.

---

## 3. The wire envelope

Every byte that crosses a peer boundary — a DHT RPC, a chunk request, a
message — travels in one envelope. The envelope is **CBOR** on the wire
(compact, binary-clean for chunk payloads; a vanilla CBOR encoder for the
handful of types used is ~150 lines and Apache-2.0-cleanly written
in-tree). JSON is used only for human-facing signed documents (certs,
manifests, list records) which are also embedded as CBOR byte strings when
they travel.

### 3.1 Envelope structure

```
Envelope = {
  v:    1,                       // uint, protocol version
  ch:   uint,                    // logical channel id (§3.4)
  typ:  uint,                    // message type within channel
  id:   bytes16,                 // UUIDv7 request/correlation id
  from: tstr,                    // sender did:key
  body: bytes | map,            // type-specific
  ts:   uint,                    // sender clock (ms)
  sig:  bytes64                  // Ed25519 over the signing payload below
}
```

- **Signing payload**: `"peerd/envelope/v1" || 0x00 || CBOR({v,ch,typ,id,from,body,ts})`
  (the map without `sig`, canonical CBOR: definite lengths, sorted integer
  keys). The receiver verifies `sig` against `from`'s identity key (or an
  agent subkey, if `from` is an agent and the cert is presented in the
  control handshake).
- Envelopes are **always signed**. Unsigned bytes on a data channel are a
  protocol violation → drop + audit `peer_protocol_violation`.
- Envelopes are **not** themselves encrypted at the envelope layer; the
  DTLS data channel encrypts the hop, and message bodies that need at-rest
  / at-relay secrecy are sealed (§3.3) inside `body`.

### 3.2 Logical channels (`ch`)

| `ch` | Name | Reliability | Purpose |
|---|---|---|---|
| 0 | control | reliable, ordered | handshake, capability exchange, ping/pong, cert presentation |
| 1 | dht | reliable, ordered | Kademlia RPC (§5) |
| 2 | content | reliable, unordered | chunk request/serve (§4) |
| 3 | message | reliable, ordered | direct + relay messaging (§6) |
| 4 | pubsub | unreliable, unordered | gossip topics, presence |

Channels 0–3 map to a reliable `RTCDataChannel` (`ordered: true` except
content which sets `ordered: false`); channel 4 maps to an unreliable
channel (`ordered: false, maxRetransmits: 0`). One peer connection
multiplexes all five.

### 3.3 Seal (X25519 + HKDF + AES-256-GCM)

Used for `message`-type bodies and any payload needing end-to-end secrecy
independent of the transport. Resolves brief Q6: **no NaCl, no vendored
ChaCha** — all native WebCrypto.

**Seal(recipient_x25519_pub, plaintext) →**

```
1. eph = X25519 keypair (ephemeral, per message)
2. shared = ECDH(eph_priv, recipient_pub)              // crypto.subtle.deriveBits, X25519, 256 bits
3. key = HKDF-SHA256(ikm=shared,
                     salt=0x00*32,
                     info="peerd/seal/v1" || recipient_pub || eph_pub,
                     L=32)                              // → AES-256 key
4. iv  = random 12 bytes
5. ct  = AES-256-GCM(key, iv, plaintext, aad="peerd/seal/v1")
6. output SealedBox = { epk: eph_pub[32], iv: iv[12], ct: bytes }
```

**Open(recipient_x25519_priv, SealedBox)**: ECDH(recipient_priv, epk) →
same HKDF → AES-GCM decrypt. Per-message ephemeral key gives forward
secrecy for the content key. The sender's identity is **not** implied by
the seal (the box is anonymous); authenticity comes from the enclosing
signed envelope or an inner signature when the message is relayed
detached (§6.2).

### 3.4 Control handshake (`ch=0`)

On data-channel open:

```
typ=0 HELLO     body={ proto:1, did, caps:[...], agentCert?:{...} }
typ=1 HELLO_ACK body={ proto:1, did, caps:[...] }
typ=2 PING      body={ nonce }
typ=3 PONG      body={ nonce }
typ=4 PRESENT_CERT body={ enc-cert | agent-cert }   // on demand
typ=5 ROSTER_REQ body={ room }                         // Phase 1 (§3.6)
typ=6 ROSTER     body={ room, members:[did] }          // Phase 1 (§3.6)
typ=7 RELAY      body={ room, to, kind, sid, payload } // Phase 1 (§3.6)
```

`caps` is a list of supported capability tags (`dht`, `relay`, `content`,
`pubsub`, `inbox`). A peer that doesn't advertise `relay` won't be asked to
store messages. Capability mismatch is non-fatal; it scopes what the two
peers will ask of each other. (Phase 1 rooms advertise
`['content','pubsub']`.)

**Phase 1 note — single-`HELLO` handshake.** `transport/session.js` sends
one signed `HELLO` (`typ=0`) each way; each side verifies the other's
signature + `proto` and hands the channel to the application. There is no
distinct `HELLO_ACK` frame yet — `typ=1` is reserved for when the
handshake needs a capability-negotiation round. Control `typ 2–7` are
live; `typ 5–7` are specified in §3.6.

### 3.5 ICE configuration (no TURN — D-5)

> **Superseded 2026-06-12.** This section specified turnREST ephemeral
> TURN credentials (`CRED_REQUEST`/`CRED_GRANT` over the signaling
> WebSocket). **Deleted under D-5** (`NORTH-STAR.md` T3): peerd ships
> no TURN client, no credential flow, and no relay-server tier. Git
> history holds the old wire format if the bet is ever re-argued.

What remains needs no credential wire contract. STUN servers are
listed in the ICE config directly (`DEFAULT_ICE_SERVERS` — public
Google + Cloudflare; community/peer-published sets later), candidate
policy prefers IPv6 pairs, and a pair with no direct path fails with
a diagnostic (a `connect_failed` audit event carrying a candidate-type
summary) rather than falling back to a relay server. Peer-assisted
relay (`ARCHITECTURE.md §6.5` Tier 2, Phase 2+) rides ordinary signed
envelopes over data channels the relay peer already holds — no new
wire format in this section.

### 3.6 Rooms, mesh & rendezvous (Phase 1)

A room is a rendezvous `key` plus the mesh of authenticated links among
its members (`NORTH-STAR.md` D-9: the room is the consent and spam
boundary). Three wire surfaces.

**(a) Rendezvous (WebSocket, the `signalingStep` reducer).** The node
pairs members under a `key` and relays opaque blobs. Members are labeled
by the node's per-connection `connId` — meaningless outside the node;
real identity (`did:key`) is established peer-to-peer by the signed
`HELLO` once a data channel opens, never by the rendezvous.

```
client → node:  { t:'signal', to, payload }    // relay an opaque blob to a member
node → client:  { t:'room',   self, members:[connId] }  // you joined; OFFER to each member
                { t:'joined', member }          // someone joined — await their offer
                { t:'left',   member }           // a member dropped
                { t:'signal', from, payload }    // a member's relayed (opaque) blob
                { t:'full' }                     // room at ROOM_CAP (16)
```

Role is deterministic: **the joiner offers** to every member already
present; an existing member never offers to a joiner, so offer/offer
"glare" is structurally impossible. Relay is room-scoped — `to` must be a
current member of the sender's own room (and not the sender), else the
frame is dropped (a stale/forged target must not become a probe). The
node never inspects `payload` (the SDP) — PROTOCOL §9, enforced by the
reducer never reading it.

**(b) Mesh control (`ch=0`, signed envelopes).** Once members hold data
channels, three control types run the room server-optionally:

```
ROSTER_REQ (typ=5)  body={ room }
ROSTER     (typ=6)  body={ room, members:[did] }   // self + my links, minus the asker
RELAY      (typ=7)  body={ room, to, kind, sid, payload }
```

`RELAY` is **mesh-assisted signaling** — the kill-the-server beat. A
newcomer with one link into the room reaches the rest by asking its
neighbor for `ROSTER`, then sending `RELAY{kind:'offer'}` frames the
neighbor forwards to each target; answers come back `RELAY{kind:'answer'}`
correlated by `sid`. Forwarding rules, enforced at receipt:
- **One hop only**, and only to a *directly-linked* target — a relay
  delivers to a neighbor or drops; it never routes multi-hop.
- **Forward only frames received directly from their signer** (`env.from
  === link.did`): a relay cannot launder a third party's envelope.
- The forwarded envelope is **immutable** — it carries the origin's
  signature end-to-end, so the relay is opaque to and cannot alter it.
- `ROSTER_REQ`/`ROSTER` are **link-local**: the signer must be the
  neighbor itself (`env.from === link.did`), else dropped.

**(c) Liveness.** `PING`/`PONG` (`typ 2/3`) on a per-link idle timer
(default: ping at 15 s idle, drop at 45 s). Every inbound signed frame
refreshes the link's `lastSeen`. A per-link control-rate token bucket
(default 60 / 10 s) bounds ping/roster flooding; over-budget control
frames are dropped + audited (`peer_ctrl_rate_limited`).

**Connection budget.** A mesh admits at most `budget` links (default 16,
= `ROOM_CAP`); a link past the cap is refused and closed
(`peer_budget_refused`). Crossing links (two peers dialing each other at
once) resolve last-in-wins: the duplicate closes, both sides converge
without a tiebreak protocol.

---

## 4. Content addressing & transfer

### 4.1 URI grammar (ABNF)

```
peerd-uri   = "peerd://" [ did "/" ] content-hash [ "/" path ]
did         = "did:key:z" 1*base58char
content-hash= 64HEXDIG                    ; SHA-256 of the manifest, hex
path        = segment *( "/" segment )    ; optional, selects within an app bundle
```

`content/uri.js`: `parsePeerdUri(s)` → `{ did?, hash, path? }`;
`formatPeerdUri({did?, hash, path?})` → string.

### 4.2 Manifest

JCS JSON, signed by the publisher (omit `publisher`/`sig` for pure
content-addressed bundles).

```json
{
  "v": 1,
  "type": "app",
  "publisher": "did:key:z6MkUser...",
  "mime": "application/peerd-app",
  "size": 524288,
  "entry": "index.html",
  "chunks": [
    { "hash": "<hex sha256>", "size": 262144 },
    { "hash": "<hex sha256>", "size": 262144 }
  ],
  "created": 1733650000000,
  "sig": "<base64 ed25519>"
}
```

- `type`: `app` | `data` | `message`.
- `entry`: present for `app`; the bundle's entry file (fed to the existing
  `composeApp`).
- Signing payload: `"peerd/manifest/v1" || 0x00 || JCS(obj without sig)`.
- **content_hash** (the URI hash) = `SHA-256(JCS(obj without sig))`. The
  address commits to the chunk list, which commits to every byte.
- Max chunk size **262144 (256 KiB)**. Last chunk may be smaller.

### 4.3 Chunk transfer (point-to-point, parallel — brief Q4 resolved)

For V1/V2 content (apps typically <5MB) we use **simple parallel
point-to-point pulls**, not WebTorrent swarming. Justification: WebTorrent
is a large bundler-assuming dependency (conflicts with no-build-step), and
its rarest-first / tit-for-tat machinery earns its keep only at scale we
don't have yet. Content-addressed chunks already give us the essential
property (fetch any chunk from any holder, verify independently).

`ch=2` messages:

```
typ=0 HAVE?     body={ hashes:[...] }         // do you hold these chunks?
typ=1 HAVE      body={ hashes:[...] }         // subset I hold (announce set only)
typ=2 GET       body={ hash }
typ=3 CHUNK     body={ hash, bytes }          // bytes is a CBOR byte string
typ=4 NOCHUNK   body={ hash }                 // not in my announce set
```

Fetch algorithm (`content/fetch.js`):

1. Resolve manifest (from a known holder or DHT `FIND_VALUE` on the hash).
2. Verify manifest signature + that URI hash matches.
3. For each chunk, find holders (peers that answered `HAVE` or DHT
   `FIND_VALUE` on the chunk hash), fetch up to `α=3` chunks in parallel,
   round-robining holders.
4. Verify each chunk's SHA-256 on arrival. Mismatch → drop the serving
   peer, re-request elsewhere, audit `bundle_verify_failed`.
5. Assemble, re-verify whole-bundle hash, install.

**Swarming is a later optimization**, gated on observed need (large/popular
content). The `HAVE?/HAVE` exchange is forward-compatible with adding a
bitfield + rarest-first later without a wire break.

### 4.4 The announce set (liability firewall)

A peer answers `HAVE` / serves `CHUNK` **only** for hashes in its announce
set — content it explicitly published or pinned. There is no
pass-through caching. `content/store.js`:

```js
announce(hash)          // add to announce set; now serveable
unannounce(hash)        // stop serving (also unpins bytes if unreferenced)
isAnnounced(hash)       // membership test consulted before every HAVE/CHUNK
```

---

## 5. DHT (Kademlia)

### 5.1 Node ID & distance

- Node ID = `SHA-256(utf8(did:key))`, 32 bytes / 256 bits.
- Distance = XOR of node IDs, compared as a 256-bit big-endian integer.
- Routing table: 256 k-buckets, `k = 20`, lookup parallelism `α = 3`.

### 5.2 RPC (`ch=1`)

| `typ` | Op | body (request) | body (response) |
|---|---|---|---|
| 0 | PING | `{}` | `{ ok:true }` |
| 1 | FIND_PEER | `{ target: nodeId }` | `{ peers:[ PeerInfo ] }` (k closest) |
| 2 | FIND_VALUE | `{ key: hex }` | `{ value: Record }` or `{ peers:[ PeerInfo ] }` |
| 3 | PUT / STORE | `{ record: Record, pow: PoW }` | `{ stored:bool, reason? }` |
| 4 | ANNOUNCE_PEER | `{ key: hex, addr: PeerInfo, pow }` | `{ ok:bool }` |

`PeerInfo = { did, transports:[ TransportAddr ], lastSeen, encCert? }`.

In the P2P setting an "address" is **how to reach this peer**, not a stable
IP. `transports[]` is the set of reachability descriptors the connect()
selector tries cheapest-first (`ARCHITECTURE §6.5`); it is a hint, not a
gate (connect still falls through on stale entries):

```
TransportAddr =
  | { kind: 'inproc' }                       // same JS realm (local rendezvous)
  | { kind: 'bcast',   origin }              // same browser profile + origin
  | { kind: 'webrtc',  signaling: [urls] | 'mesh' }   // via bootstrap or peer mesh
```

A peer typically advertises only the transports reachable from outside its
own machine (`webrtc`); `inproc`/`bcast` are discovered locally rather than
announced in the DHT.

### 5.3 Record format

```json
{
  "v": 1,
  "class": "identity | enc-cert | inbox | list | content | presence",
  "key": "<hex>",
  "publisher": "did:key:z6Mk...",
  "value": { /* class-specific */ },
  "created": 1733650000000,
  "notAfter": 1733736400000,
  "sig": "<base64 ed25519>"
}
```

- Signing payload: `"peerd/dht-record/v1" || 0x00 || JCS(obj without sig)`.
- **Validation on receipt (reject + audit on any failure):**
  1. `sig` verifies against `publisher`.
  2. `key` equals the canonical key for the class (e.g. for `inbox`,
     `key == hex(SHA-256("inbox:" || publisher))`; for `content`,
     `key == content_hash`). No key/value mismatch.
  3. `notAfter > now` and `notAfter - created ≤ classMaxTTL`.
  4. PoW valid (§5.5).
  5. Per-key record cap not exceeded (max N per key, oldest/lowest-PoW
     evicted).

### 5.4 Record classes & TTL

| class | key | value | default TTL |
|---|---|---|---|
| `identity` | H(did) | `{ pub, didDoc }` | 30 d |
| `enc-cert` | H("enc:"+did) | enc-cert (§2.2) | 30 d |
| `inbox` | H("inbox:"+did) | `{ pointers:[ {relay, msgId, size} ] }` | 24 h |
| `list` | H("list:"+did+":"+name) | list head hash (§7) | 7 d |
| `content` | content_hash | `{ holders:[ did ] }` (pointers!) | 24 h |
| `presence` | H("presence:"+did) | `{ online, caps }` | 15 m |

`content` records are **pointers to holders**, never content
(`ARCHITECTURE.md §4.3`).

### 5.5 Proof-of-work

`pow = { nonce: uint }`. Valid iff
`SHA-256("peerd/pow/v1" || record_key || publisher || nonce)` has ≥ `D`
leading zero bits, with `D` tuned so the median solve is ~100 ms on a
mid-range 2025 laptop (start `D≈20`, adjust from telemetry — but peerd has
no telemetry, so `D` is a shipped constant revised per release). PoW binds
to `(key, publisher)` so it can't be precomputed across keys or replayed
by a different publisher.

### 5.6 Rate limits (per remote peer)

- ≤ 50 DHT ops / min (brief §3.8). Excess → drop + audit.
- ≤ N records per key (default N=8).
- PUTs without valid PoW rejected before signature check (cheap reject).

---

## 6. Messaging

### 6.1 Direct (`ch=3`, both online)

```
typ=0 MSG    body={ sealed: SealedBox, msgId: bytes16 }
typ=1 ACK    body={ msgId }
```

The enclosing envelope is signed by the sender (authenticity); `sealed` is
opened with the recipient's X25519 subkey (confidentiality).

> **As built (Phase 1, `messaging/direct.js`):** the both-online direct path
> is implemented and is what the commons demo's private chats ride. It
> carries an **opaque plaintext `data`** body — `body={ data }` — not the
> sealed form above. why that is already private: `mesh.send` delivers a
> `ch=3` frame over ONLY the recipient's link, and the mesh never forwards a
> non-`ch=4` frame (`handle()` requires `env.from === link.did`), so the
> bytes never reach a third peer; the WebRTC link is DTLS-encrypted in
> transit. So an online 1:1 message is private at the **routing** layer with
> no E2E seal. The `sealed: SealedBox` form lands together with §6.2
> store-and-forward, where a **relay holds the ciphertext** and
> confidentiality genuinely requires end-to-end encryption — the moment E2E
> earns its keep. `typ=1 ACK` and `msgId` are likewise deferred to that step
> (the demo echoes locally; no receipts yet).

### 6.2 Async store-and-forward

**Store on a relay** (`ch=3`):

```
typ=2 RELAY_STORE body={ recipient: did,
                         msgId: bytes16,
                         sealed: SealedBox,        // sealed to recipient enc-key
                         senderProof: bytes64,     // see below
                         notAfter }                // ≤ now + 30d
typ=3 RELAY_OK    body={ msgId }
typ=4 RELAY_FULL  body={}                          // at 100MB cap, oldest-evict
```

- `senderProof = Ed25519-sign(sender_id, "peerd/relay-store/v1" || recipient || msgId || H(sealed))`.
  The relay verifies the sender is **in the relay's social graph** (Tier
  0/1) before accepting — strangers cannot fill relays with garbage
  (brief §3.7). The proof also lets the recipient confirm sender identity
  after opening.
- Relay stores `{ recipient, msgId, sealed, sender, notAfter }`, caps at
  100MB, evicts oldest. Cannot read `sealed`.
- Relay then `PUT`s/updates the recipient's `inbox` DHT record adding the
  pointer `{ relay: own_did, msgId, size }` (or the sender does, if the
  relay lacks DHT write capability — either is valid).

**Fetch on coming online** (`messaging/inbox.js`):

1. `FIND_VALUE` on `H("inbox:"+own_did)` → pointers.
2. For each `(relay, msgId)`: connect to relay, `ch=3`:

```
typ=5 INBOX_FETCH body={ msgId }
typ=6 INBOX_MSG   body={ msgId, sealed, sender, notAfter }
typ=7 INBOX_ACK   body={ msgId }     // recipient confirms receipt → relay may evict
```

3. Open `sealed` with X25519 subkey; verify `senderProof`; deliver.

### 6.3 Topic gossip (`ch=4`, Phase 1 — as built)

> **Supersedes the earlier `SUB/UNSUB/ttlHops` sketch** (`NORTH-STAR.md`
> §6, D-7/D-9). Pre-release, the design was replaced, not kept
> (DECISIONS #17 ethos). The deliberately-dumb flooder is what shipped:
> ~200 lines, room-scoped, no mesh-optimization protocol.

```
PUB       (typ=0)  body={ topic, data }
SYNC_REQ  (typ=2)  body={ topic, haves:[sig] }      // §6.4
SYNC_RESP (typ=3)  body={ topic, envs:[envelope] }  // §6.4
```

`topic` is an app-chosen string scoped to the room — typically a label
like `"feed"` or `"doc"` (presence rides the reserved topic
`"~presence"`). `data` is **opaque** — the platform never interprets it
(D-7); a CRDT update, a post, a cursor are all the same bytes.

Flood mechanics:
- **Subscription is local**, not on the wire — there is no `SUB`/`UNSUB`
  frame. A peer re-broadcasts every valid `PUB` it hasn't seen to all
  links except the one it arrived on; local subscribers are delivered
  in-process.
- **Dedup keys on the envelope `sig`**, not `id`. The signature is
  unforgeable, so a flooder cannot pre-poison the seen-cache against an
  honest frame (an `id`-keyed cache could be front-run with a fake frame
  bearing a victim's `id`). The seen-cache is the loop guard; it is
  LRU-capped (default 4096) and evicts oldest-first.
- **No `ttlHops`.** A mutable hop counter inside a signed body is
  unverifiable; the seen-cache stops loops and the room cap (16) bounds
  amplification, so no hop field is carried.
- **Per-sender token bucket** (default ~20 msg/s sustained, burst 40) and
  **per-`did` mute** are the D-9 spam ceiling. A `PUB` from a
  rate-limited sender is dropped *and not re-broadcast* (a flood dies at
  the first honest hop); a muted sender's frames are dropped silently
  with no relay. Rate-limit drops are audited (`gossip_rate_limited`).

Best-effort, room-scoped, unreliable channel — no delivery guarantee for
the live flood (durability is §6.4's job).

### 6.4 Topic sync — late-join backfill (`ch=4`, Phase 1)

A feed with no home server still has history: whoever is in the room
holds it. `SYNC_REQ`/`SYNC_RESP` reconcile a **retained** topic between
two members.

- On every new link, **both** sides send `SYNC_REQ{ topic, haves }` for
  each retained topic, where `haves` is the flat list of envelope `sig`s
  they already hold (capped 512). Symmetric by construction — a
  rejoiner's offline publishes flow forward exactly like a newcomer's gap
  flows back.
- The receiver answers `SYNC_RESP{ topic, envs }` with the original
  signed envelopes it holds that aren't in `haves` (capped 256 per
  response).
- Both carrier frames are **link-local** (`env.from === neighbor`), and
  **every inner envelope in a `SYNC_RESP` is signature-verified** before
  ingest — a member can serve history but cannot fabricate it. Verified
  envelopes are delivered through the same seen/mute discipline as the
  live flood and are **never re-broadcast** (backfill is point-to-point;
  peers that want it ask for it).

> **Demo-scale, and the code says so.** Flat have-list + flat response is
> the right amount of protocol for hundreds of posts among ≤16 peers. Set
> reconciliation (range hashes, IBLTs) is a Phase 2+ upgrade with its own
> measurements; the over-cap cases audit (`sync_haves_overflow` /
> `sync_resp_overflow`) rather than silently truncate forever.

---

## 7. Curation & social graph

### 7.1 List record

A list is an append-mostly, signed, hash-linked log. The DHT `list` record
points at the **head hash**; the head is a content bundle (§4) so lists
distribute over the same chunk path.

```json
{
  "v": 1,
  "type": "list",
  "publisher": "did:key:z6Mk...",
  "name": "apps",
  "prev": "<hex of previous head, or null>",
  "items": [
    { "kind": "app",   "uri": "peerd://did.../<hash>", "title": "..." },
    { "kind": "peer",  "did": "did:key:z6Mk...",        "note": "..." },
    { "kind": "topic", "topic": "<hex>",                "title": "..." },
    { "kind": "post",  "uri": "peerd://did.../<hash>",  "ts": 1733650000000 }
  ],
  "created": 1733650000000,
  "sig": "<base64>"
}
```

Domain tag `peerd/list/v1`. `prev` chains history so a subscriber can
fetch incrementally and verify continuity.

### 7.2 The social network is a view, not a service

- **Post a note** = publish a `data`/`post` content bundle under your
  identity, and append a `post` item to your `posts` list.
- **Follow** = subscribe to someone's list (store their did + list name in
  the `curation` store; periodically refresh the `list` DHT record).
- **Feed** = union of subscribed lists' `post` items, ordered by `ts`,
  fetched as content bundles.
- **App Store / messaging client / discovery** = different renderers over
  the same list + content + message graph. One data model, many views
  (brief §3.6).

### 7.3 Blocklist record

```json
{
  "v": 1, "type": "blocklist", "publisher": "did:key:z6Mk...",
  "bloom": "<base64 bloom filter bits>", "k": 7, "m": 65536,
  "count": 1234, "created": 1733650000000, "sig": "<base64>"
}
```

Bloom filter of blocked `did:key`s. Personal blocklist is gossiped
opportunistically; users subscribe to others' blocklists uBlock-style;
peerd ships a default community blocklist (append-only, openly curated).
Membership is probabilistic (false-positive only, never false-negative) —
acceptable for "should I even talk to this stranger," and a Tier-0 peer is
never auto-blocked by a subscribed list without explicit user opt-in.

---

## 8. Audit event types (added to the existing egress log)

New `AuditEventType` values appended to `peerd-egress/audit/types.js`. No
new logging subsystem; same `{ id, when, type, sessionId?, details }`
shape, same IDB `audit_log` store, never transmitted.

```
peer_pairing_started        details: { method: 'qr'|'paste'|'mesh' }
peer_pairing_completed      details: { did, tier }
peer_connected              details: { did, caps }
peer_disconnected           details: { did, reason }
peer_blocked                details: { did, source: 'tier'|'blocklist'|'manual' }
peer_protocol_violation     details: { did, reason }
signaling_node_added        details: { url }            // user-granted bootstrap
dht_put_rejected            details: { key, reason }
dht_record_evicted          details: { key, reason }
content_announced           details: { hash, type }
content_unannounced         details: { hash }
bundle_verify_failed        details: { hash, chunk?, reason }
relay_stored                details: { recipient, msgId, bytes }
relay_evicted               details: { msgId, reason: 'cap'|'ttl'|'acked' }
relay_store_rejected        details: { sender, reason: 'not_in_graph'|'cap' }
message_sealed              details: { recipient, mode: 'direct'|'async' }
message_opened              details: { sender }
app_installed               details: { uri, publisher }
app_permission_granted      details: { uri, permission }
app_permission_denied       details: { uri, permission }
identity_created            details: { did, source: 'prf'|'fallback' }
subkey_certified            details: { kind: 'agent'|'enc', notAfter }
```

### 8.1 Phase 1 — as built

The names above were the planning surface; the events Phase 1 actually
emits all carry the **`dweb_` prefix** (the `dweb/audit` SW route accepts
any `dweb_`-prefixed type, so a page can append to the one audit log
without a new subsystem). Two emit paths:

**SW routes** (`auditLog.append` directly):
```
dweb_identity_issued   details: { did }                  // persistent identity issued to a page
dweb_app_installed     details: { appId, uri, publisher } // verified bundle stored as an App
dweb_seed_installed    details: { appId }                 // commons seed first-run
```

**Page-hosted room** (mesh / gossip / sync / bridge, forwarded through
the bridge's `dweb_`-prefixing audit). High-signal, user-facing:
```
dweb_room_joined       details: { roomId, did, rendezvous }
dweb_room_left         details: { roomId }
dweb_bridge_join_granted / dweb_bridge_join_denied  details: { appId, appKey, roomId }
dweb_app_shared        details: { uri }
dweb_app_install_denied details: { uri }
dweb_peer_muted_by_app details: { did }
```
Internal diagnostics (also `dweb_`-prefixed; raw-label rows in the
Activity UI by design):
- link/mesh: `dweb_peer_connected`, `dweb_peer_link_closed`,
  `dweb_peer_budget_refused`, `dweb_peer_ctrl_rate_limited`,
  `dweb_peer_envelope_invalid`, `dweb_peer_envelope_misattributed`,
  `dweb_peer_path` (the D-5 connectivity telemetry: `{ did, path }`).
- room join (`transport/rooms.js`): `dweb_peer_did_mismatch` (a peer
  authenticated as a different did than expected),
  `dweb_room_accept_failed` / `dweb_room_dial_failed` (rendezvous-path
  accept/dial failure), `dweb_rendezvous_lost`.
- mesh-assisted signaling: `dweb_relay_join_accepted`,
  `dweb_relay_accept_failed`, `dweb_relay_dial_failed`,
  `dweb_relay_target_unreachable`.
- gossip/sync: `dweb_gossip_rate_limited`, `dweb_gossip_muted`,
  `dweb_sync_env_invalid`, `dweb_sync_haves_overflow` /
  `dweb_sync_resp_overflow`.
- content: `dweb_app_published`.

The planned non-prefixed names (`peer_pairing_*`, `relay_store_*`,
`message_*`, `subkey_certified`, …) land with their phases (pairing/
messaging/identity-maturity) and are not emitted yet.

---

## 9. Non-logging commitment (constraint §6)

Bootstrap nodes (`THREAT-MODEL.md §7`) see WebRTC offer/answer SDP in
transit. **They must not log it.** The reference signaling node ships with
logging of message bodies disabled at the code level (not just config),
and the protocol is designed so a bootstrap node needs only the ephemeral
pairing-session routing key, never the SDP contents, to do its job — it
relays opaque blobs between two session participants and forgets them when
the session ends. peerd collects no telemetry anywhere; this is the same
commitment extended to the one server-shaped component in the system.

---

## 10. Versioning

- `v: 1` appears in every envelope, record, manifest, and cert. A peer
  rejects a major version it doesn't understand (audit
  `peer_protocol_violation`) rather than guessing.
- Channel/type tables are additive: new `typ` values within a channel are
  forward-compatible (unknown `typ` → ignore on best-effort channels,
  error on reliable control). New record classes are additive.
- Domain tags are versioned independently (`peerd/seal/v1` etc.) so a
  crypto construction can be rotated without a wire-version bump.
