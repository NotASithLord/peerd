# Testing what's landed (current branch: dweb/phase1-merged)

> What you can verify **right now**, and how. Two halves: the **automated**
> suites (run in seconds, cover all pure logic incl. the DHT) and the **manual
> browser** flows (the live WebRTC path that Bun can't run — the honest
> boundary). Supersedes `PHASE1-TESTING.md` for the current state.
>
> Legend: ✅ ready to test · ⏳ built but not yet runtime-wired (bun-only).

---

## A. Automated — run these first (seconds)

From the worktree root (`Desktop/peerd-dweb-rebase`):

```bash
bun run typecheck                       # strict JSDoc contracts (CI gate)
bun run lint                            # ESLint (CI gate)
bun packaging/check-dweb-boundary.ts    # no module refs leak outside peerd-distributed/
bun test ./tests                        # 1191 pass — full suite
```

The dweb-specific suites and what each proves:

| suite | proves |
|---|---|
| `signaling.test.ts` | the room rendezvous reducer (join/roster/relay/full) |
| `identity.test.ts` | persistent vault-stored did:key |
| `mesh-rooms.test.ts` | mesh boundary rules: 1-hop relay, signer-only forward, misattribution/tamper drop, budget, **kill-the-server** relay join |
| `gossip.test.ts` | flood + sig-keyed dedup, mute, rate limit, presence, late-join sync |
| `direct.test.ts` | ch=3 private 1:1 reaches ONLY the recipient, never a third peer |
| `ice.test.ts` | candidate summary + honest DirectPathUnavailable error |
| **`dht-core.test.ts`** | XOR distance, k-bucket eviction, BEP-44 sign/verify + no-downgrade, store TTL |
| **`dht-node.test.ts`** | the 4 RPCs, iterative lookup, multi-hop convergence via one bootstrap, reachable-only drop |
| **`dht-over-mesh.test.ts`** | put-on-one / get-from-another over the **real signed mesh** (ch=1), downgrade refused across the wire |

Optional (chassis, headless, must stay green):
```bash
bun run gen:dev && bun scripts/cdp/run-inbrowser-tests.mjs   # in-browser suite
bun packaging/package.ts --channel=store                      # store pkg "zero dweb traces"
```

### A.1 · The network simulator — N real nodes, no WebRTC ✅

The node logic is a **pure actor** over the mesh (it only sends/receives opaque
messages), so we can run the *real* logic of many nodes against an in-memory
network and observe emergent behaviour deterministically. `extension/peerd-
distributed/peer-node.js` (`createPeerNode`) is the actor — the same composition
that will run in the offscreen base host; `tests/peerd-distributed/sim.ts`
(`createSimNetwork`) spins up N of them over controllable pipes and plays
rendezvous (DHT lookups dial peers on demand).

```bash
bun test ./tests/peerd-distributed/network-sim.test.ts   # asserted scenarios
bun tests/peerd-distributed/sim-run.ts 16                # WATCH 16 nodes (narrated)
```
What it demonstrates: gossip flooding to every node across a sparse ring+chord,
a DHT put resolved by a far node via dial-on-demand convergence, and a
partition isolating gossip then a heal reconverging — each with a state dump
(per-node links + DHT contacts). Scale it: `sim-run.ts 27` (or any N). This is
where base-layer behaviour (lobby, churn, eclipse, convergence) gets tested as
the host lands — not just unit pieces.

### A.2 · Multi-PROCESS nodes (separate OS processes) ✅

The in-process sim wires nodes with memory pipes; for *independent processes*
(e.g. one per agent), `tests/peerd-distributed/netproc/` adds a relay-backed
`Channel` — a 4th transport (after WebRTC, memoryPair, sim-pipes). Each
`run-node.ts` process spins up a real node, links to every peer via the relay,
and self-tests gossip / direct / DHT / presence, printing PASS/FAIL.

```bash
bun run test:netproc            # CI gate: driver spawns relay + 5 nodes, asserts all PASS
bun run test:netproc 8 8        # 8 nodes, full-mesh quorum
```
The driver (`netproc/run-cluster.ts`) binds an ephemeral relay port, spawns N
`run-node.ts` processes, streams their logs, and exits non-zero unless every
node self-tests green — so this tier is now a **CI job** (`dweb netproc`), not
just a manual run. To drive the pieces by hand (e.g. to watch one node):
```bash
bun tests/peerd-distributed/netproc/relay.ts 8810 &          # the switchboard
for n in A B C D E; do \
  bun tests/peerd-distributed/netproc/run-node.ts ws://localhost:8810 node$n 5 & \
done; wait                                                   # 5 real processes form a mesh
```
Each prints e.g. `RESULTS {"peers":4,"presence":true,"gossip":true,"direct":true,"dht":true}`.
The relay is a TEST switchboard (not the production data path — production is
WebRTC). NOTE: this run-node self-test registers all receive-handlers *before*
any node sends — direct (ch=3) is fire-and-forget, so a handler must be up
first (a real ordering lesson the 5-node run surfaced).

### A.3 · Two real browser peers over WebRTC — headless ✅

The live peer-to-peer path (real WebRTC bytes between real browser contexts)
used to be **only** the manual §B checklist. It's now a CI gate too:

```bash
bun run test:twopeer            # CHROME_PATH=… on CI; auto-detects locally
```
`scripts/cdp/run-dweb-twopeer.mjs` stands up the local signaling node on an
ephemeral port, launches one headless Chrome, and opens **two** browser contexts
each running the production runtime composition (`joinRoom` → `createBaseNetwork`,
via `extension/tests/dweb-twopeer.{html,js}`). It exits 0 only when both peers
form a WebRTC mesh **and** each hears the other's gossip — the automated core of
§B2/§B3 below. Same raw-CDP-over-Bun toolchain as the in-browser harness (no npm
CDP client). The richer flows (private-chat consent, kill-the-server, the Library
UI) stay manual — see §B.

---

## B. Manual browser test — the commons chat dwapp ✅

The full UI flows still need a human. The core join + presence + chat beat is
now also automated (§A.3); the rest below is the manual pass. Setup: load the
**preview** build unpacked in **two Chrome profiles** (or two machines on a
network — see §C).

### B0 · Build + load
```bash
bun run gen:dev
bun packaging/package.ts --channel=preview      # → artifacts/peerd-preview-chrome.zip
```
Load unpacked (or the unzipped staging dir) at `chrome://extensions` in each
profile. Open the peerd side panel; create/unlock the vault.
*(Touch ID note: a fresh profile without iCloud-Keychain passkeys hangs on
`residentKey:'required'` — use "Use a passphrase instead".)*

### B1 · The Library — commons is a pre-loaded dweb app
- [ ] Click the **Library** (▦) button in the side-panel header → the Home page.
- [ ] **commons** appears in the grid, tagged **`dweb`**, source **dweb**.
- [ ] (Filter the search by `dweb` → commons matches.)
- [ ] Delete commons → reload the Library → it does **not** silently re-appear
      (the once-ever seed flag respects deletion). *To re-seed during testing,
      clear `kv 'dweb.seededApps'`.*

### B2 · Join a room (both profiles)
- [ ] Open commons (Library → Open). The join screen shows a pre-filled
      rendezvous (`wss://bootstrap.peerd.ai/rendezvous`).
- [ ] In **both** profiles: enter a name + the **same room code** → Join.
- [ ] Each profile shows the two-pane layout; the rendezvous dot reads **up**.
- [ ] The **participant list** ("here now") shows the other peer, with a
      connection-path tag (e.g. `ipv4`/`ipv6`) and a **random brand color**
      avatar (cyan/red/amber/green/magenta — distinct per participant).

### B3 · Global chat (the "everyone" channel)
- [ ] Type in profile A → appears in **both** A and B.
- [ ] Type in profile B → appears in both. Author names are tinted each
      participant's brand color.

### B4 · Private chat (the consent handshake)
- [ ] In A, click the participant → "Start a private chat" + **send chat request**.
- [ ] B's sidebar shows that participant highlighted "**wants to chat**";
      selecting shows **accept / decline**.
- [ ] B **accepts** → both get a composer; messages flow **only** between them.
      Header reads "**direct · only <name> receives this**" (honest: directed +
      DTLS, not relayed through the room).
- [ ] Verify a third profile (if present) never sees the private messages.
- [ ] **Decline path:** from a fresh pair, B **declines** → A sees "declined,
      ask again"; B's rail shows "declined". A re-request works.
- [ ] **Unsolicited guard:** there's no way to message before acceptance; an
      incoming message from someone you didn't accept shows as a request, its
      content hidden until you accept.

### B5 · Leave
- [ ] Click **leave** → you disappear from the other profile's participant list
      promptly (it calls `dweb('leave')` before reloading — presence tears down).

---

## C. Multi-device (different devices, same network) ✅
Same as §B but across two machines. Both load the preview build, both join the
same room code over `bootstrap.peerd.ai`. This exercises real cross-NAT ICE +
the trickle path (offer/answer immediate, candidates streamed). Watch the DWEB
console logs (magenta badge) for `✅ CONNECTED … direct-ipv4/ipv6`.

## D. Kill-the-server (room outlives the rendezvous) ✅
With ≥2 peers connected, the rendezvous going away must not drop the room:
- [ ] After both are connected, the room keeps working peer-to-peer (the mesh
      holds; the HUD note says so). A brand-new peer can still join through a
      connected member (mesh-assisted relay) — this is the kill-the-server beat.

---

## E. Not yet browser-testable (bun-only for now) ⏳
- The **DHT** (`dht/`) — verified by `bun test` (§A), not yet attached to a live
  base network (needs the per-hop **dialer** + connecting the node to the
  offscreen base host's connection pool). The lobby gossip path works without it;
  the DHT adds durable late-join discovery (`findDwapp`'s second hop).

## F. The always-on base network (S1b + S4) — in-browser ⏳ needs verify
**Built, gates green, NOT yet browser-verified.** The runtime path
(worker → tab → SW → offscreen → WebRTC lobby) can't run under bun, so verify by
watching the logs. Open **two** DevTools consoles: the **service worker** (`[sw]`)
and the **offscreen document** (`[offscreen/dweb]`) — `chrome://extensions` →
peerd → *service worker* / *Inspect views: offscreen.html*.

1. **Always-on start.** Load the preview build (dweb on), unlock the vault. Expect:
   - `[sw] dweb base network — auto-start on unlock`
   - `[offscreen/dweb] starting base network…` → `joining lobby "peerd/base/1" as …<did8>`
   - `[offscreen/dweb] ✅ base network ONLINE — lobby joined, presence beaconing`
   - `[sw] dweb base network ONLINE { did, peers, present }`
   A signaling outage must NOT break unlock — it logs `auto-start failed
   (non-fatal)` and the side panel still unlocks. Lock+unlock again → it restarts;
   a SW respawn (30s idle) → session-resume re-fires (`auto-start on resume`).
2. **Two devices** (as in §C) on the same lobby → each console shows the other's
   `PEER_ON_DWAPP` / presence; `present` count rises.
3. **The `peerd.distributed.*` read surface.** Open a Notebook, run:
   ```js
   peerd.self.display(await peerd.distributed.whoami());    // { available:true, did:'did:key:…' }
   peerd.self.display(await peerd.distributed.status());     // { running:true, rendezvous, peers, present, dhtSize }
   peerd.self.display(await peerd.distributed.peers());      // [{ did, name, linked, path, lastSeen }, …]
   peerd.self.display(await peerd.distributed.presence());   // same roster (mesh links ∪ gossip presence)
   await peerd.distributed.publish({});  // throws: placeholder — needs grant+quota (#21)
   ```
   With dweb **off** / store build: `whoami()` → `{ available:false, did:null }`,
   `peers()` → `[]` (inert, never throws).

---

## Gotchas seen in testing
- **Touch ID hang** on a fresh profile → use a passphrase (B0).
- **"room is full" with no real peers** → stale rendezvous connections; use a
  fresh room code (the node reaps dead connections on join).
- **Empty rendezvous field** → it pre-fills the working default; if blank, the
  join silently falls back to the same default.
- **commons not in the Library** → it seeds on Library open (preview build,
  unlocked vault). If absent, check `DWEB_ENABLED` (preview only) + the vault.
