# dweb Phase 1 — manual test plan

> The byte-level WebRTC path can't run in Bun (the honest boundary in
> `transport/connect.js`), so the protocol logic is unit-tested and the
> **live peer-to-peer flows are verified by hand** here. This is the
> checklist before merging `dweb/phase1`.
>
> Pair with `NORTH-STAR.md §2` (the five demo beats this validates) and
> `ROADMAP.md` Phase 1 (the build list).

---

## 0. What the automated gates already cover

Run from the worktree root:

```bash
bun run typecheck          # JSDoc contracts (CI gate)
bun run lint               # ESLint (CI gate)
bun packaging/check-dweb-boundary.ts   # no module refs outside peerd-distributed/
bun test ./tests           # full suite, incl. the dweb suites:
                           #   signaling.test.ts        (room reducer)
                           #   identity.test.ts         (persistent identity)
                           #   mesh-rooms.test.ts       (mesh, rooms, KILL-THE-SERVER,
                           #                             relay/attribution boundary rules)
                           #   gossip.test.ts           (flood+dedup, mute, rate limit,
                           #                             presence, sync, fabrication reject)
                           #   ice.test.ts              (candidate summary, honest-failure error)
```

These prove the **reducers and pure logic**: the room protocol, the
mesh boundary rules (one-hop relay, signer-only forwarding, misattribution
drop, tamper drop, budget, idle-drop), gossip dedup/rate-limit/mute,
sync's inner-signature verification, and the ICE candidate summary. What
they do NOT cover — and what this plan does — is **real WebRTC bytes
between real browser contexts**.

Also run the in-browser suite headless once (it exercises the chassis,
not the dweb live path, but must stay green):

```bash
bun scripts/cdp/run-inbrowser-tests.mjs
```

---

## 1. Load the preview package

The dev tree defaults to the preview channel with dweb on
(`shared/build-config.js` checked-in copy). To be sure:

```bash
bun run gen:dev    # regenerate manifest + build-config (preview, dweb on)
```

1. `chrome://extensions` → Developer mode → **Load unpacked** →
   `extension/`.
2. Open the side panel, create the vault (Touch ID or passphrase), and
   **unlock** — the persistent dweb identity is a vault secret, so room
   join needs an unlocked vault.
3. Options (gear → full options page) → **Decentralized web** → **Enable
   dweb**.

For two-peer testing you need two independent peerd instances. Easiest:
**two Chrome profiles** (each loads the unpacked extension, each has its
own vault and its own identity). Two machines on different networks is
the real cross-NAT test (§6).

---

## 2. Rendezvous up — open commons in two profiles

Start a local rendezvous node (no cloud account):

```bash
bun signaling-node/bun-server.mjs    # ws://localhost:8799/rendezvous?key=<room>
```

In **both** profiles: Options → Decentralized web → enter the same room
code (e.g. `demo`) → **Open commons**. In the commons join screen, set
the rendezvous URL to `ws://localhost:8799/rendezvous` in both, pick a
name, **join**.

> Expected: the commons seed app installs on first open (one App tab,
> grouped under "peerd"), the consent bar appears on first join (Allow),
> and after both join each shows the other in **here now** with a path
> tag.

**✅ Beat checks**
- [ ] Both peers appear in each other's "here now" within a second or two.
- [ ] The connectivity HUD shows `rendezvous up` and each peer's path
      (`ipv6`, `ipv4`, or `ipv4-srflx` — see §6 for what to expect on
      which network).
- [ ] The audit log (Options → Activity) shows `joined a dweb room` and
      `dweb identity issued` for each.

---

## 3. The feed (beat 3) + the document (beat 2)

With two peers in the room:

- [ ] **Feed.** Post from A → appears in B within a moment, attributed to
      A's name. Post from B → appears in A. Newest-first ordering holds.
- [ ] **Document.** A clicks **+ paragraph**, types → B sees the
      paragraph and its text live. B edits a *different* paragraph → A
      sees it. Simultaneous edits to *different* paragraphs both survive
      (block-level LWW). Editing the *same* paragraph: last writer wins,
      and neither side's caret gets stomped mid-type (focus defers remote
      updates).
- [ ] **Presence names.** The name each peer typed shows on their posts,
      doc blocks, and the "here now" list.

---

## 4. Late join — backfill (beat 3, the no-server-history claim)

With A and B having posted several feed items and edited the doc:

- [ ] Open commons in a **third** profile C, same room. After C joins,
      C's feed **backfills the existing posts** and the doc shows the
      existing paragraphs — fetched from the peers present, not a server.
- [ ] A new post made *before* C joined but by a peer who was offline
      then comes through once that peer reconnects (symmetric sync) — to
      test: have B leave, A post, B rejoin → A's post reaches B and B's
      pre-leave posts are still on A.

---

## 5. KILL THE SERVER (beat 4 — the headline)

With A, B (and optionally C) connected through the local rendezvous:

1. [ ] **Stop the Bun rendezvous node** (Ctrl-C the `bun-server.mjs`).
2. [ ] The HUD flips to `rendezvous down`; the room keeps working —
       posting and co-editing between the already-connected peers is
       **uninterrupted**.
3. [ ] **A new peer D still joins, with no server**, via an invite code:
       - In A's commons, sidebar → **invite via code** → copy the code.
       - In D's commons join screen → expand "join with an invite code" →
         paste A's code → **answer invite** → copy the **answer code**.
       - Back in A → paste D's answer into the invite box → **complete**.
       - D connects to A, then **crawls the room through A** (roster +
         mesh-assisted `RELAY` signaling) and ends up connected to B (and
         C) too — verify D sees every member in "here now", and a post
         from D reaches everyone.

> This is the load-bearing demo: the server was only ever an
> introduction, and the room outlives it. If D reaches *only* A but not
> B/C, the mesh-assisted `RELAY` crawl (`transport/rooms.js`
> `expandViaPeer` / `dialViaRelay`) is the thing to debug.

---

## 6. Connectivity (beat 5 — the IPv6 bet, honest failure)

- [ ] **Same machine, two profiles:** expect `ipv4` or `ipv6` host
      candidates (loopback / local) — fast, no STUN needed.
- [ ] **Two machines, same LAN:** expect `ipv6` if the LAN has it, else
      `ipv4` host.
- [ ] **Two machines, different networks (real cross-NAT):** expect
      `ipv6` direct where both have IPv6 (the bet paying off), or
      `ipv4-srflx` via public STUN where one side is IPv4-NATed.
- [ ] **Honest failure:** a pair that genuinely can't connect (symmetric
      NAT IPv4 both ends, no IPv6) must **fail with a named cause**, not
      hang or silently relay. Check the audit log for the
      candidate-type summary; there is **no TURN** (D-5) and that's
      intentional.

---

## 7. The bridge boundary (security — §13 of the threat model)

- [ ] **Consent.** First room-join raises the confirm bar (showing the
      room + rendezvous URL). Deny → no join, audited
      `dweb room join denied`. Allow → join, and the grant is remembered
      for that app (a second join to a room skips the bar; still audited).
- [ ] **Custom rendezvous is disclosed.** Joining with a non-default
      `wss://` URL shows that URL in the confirm bar.
- [ ] **Install is confirmed every time.** Share an app (sidebar → **share
      this app**) from A; in B's feed the post carries a `peerd://` link
      with an **install this app** button. Click it → B gets an install
      confirm **every time** (never remembered) → Allow → the app is
      fetched from the room, verified, and installed as a new App tab.
- [ ] **Tamper rejection.** (Code-level, already unit-tested, but worth a
      glance:) the install path verifies the manifest signature + every
      chunk; a corrupted bundle is rejected before install.
- [ ] **Vault-locked.** Lock the vault, then try to join a room from
      commons → a legible "peerd is locked — unlock it" error, not a
      crash.

---

## 8. Store-build safety (the dweb stays out of the store artifact)

```bash
bun run package            # or the channel build per PACKAGING.md
bun packaging/verify-store-artifact.ts   # must pass: zero "peerd-distributed" refs
```

- [ ] The **store** artifact contains no `peerd-distributed/` files and
      no `peerd-distributed` string (the commons app + all Phase 1 code
      ride only the preview package).
- [ ] The **preview** artifact contains `peerd-distributed/apps/commons/`
      (the seed app).

---

## 9. Known boundaries (not bugs)

- **Room scale** is tens of peers (full-mesh + flood). The HUD and the
  fan-out cap are where a smarter mesh slots in later (`NORTH-STAR.md §7`).
- **The document is block-level LWW**, not a character CRDT — same-block
  concurrent edits resolve last-writer-wins (D-7's sanctioned fallback;
  the Yjs-in-bundle upgrade is recorded, not built).
- **No global feed** — the feed is room-scoped until the DHT (Phase 3).
- **Identity is vault-random**, not PRF-derived yet (Phase 3); it's
  persistent per profile, which is all Phase 1 needs.
- **Firefox**: the app-tab host should work (no offscreen dependency in
  Phase 1), but it's Chrome-verified here; Firefox is its own pass.
