# Hardening roadmap

Prioritized follow-ups to the supply-chain hardening pass, grounded in a
code recon of the actual isolation, packaging, and vendoring surfaces.
This is a *plan*, not a status page: each item names the invariant to
establish and the files that carry it today. Live values (limits, counts,
pin lists) stay in the cited source, per the repo's doc rules.

Companion documents: [`THREAT-MODEL.md`](THREAT-MODEL.md) (invariants and
residual risks referenced below), [`RED-TEAM-RESULTS.md`](RED-TEAM-RESULTS.md).

## What already shipped (the supply-chain slice)

For orientation — enforced by CI, not by this prose:

- Third-party GitHub Actions pinned by full commit SHA, kept current by
  `.github/dependabot.yml`; workflow token default read-only with per-job
  elevation (`.github/workflows/package-and-release.yml`).
- `bun install --frozen-lockfile` in every CI job; `crx3` (the CRX signer)
  exact-pinned like `web-ext` before it (`package.json`).
- Reproducible artifact assembly — normalized mtimes/modes/entry order in
  `packaging/package.ts`, double-build byte-identity asserted in the CI
  package matrix.
- Vendored-byte integrity — every file under `extension/vendor/` pinned in
  `extension/vendor/vendor.lock.json`, verified by `bun run check:vendor`
  (`packaging/check-vendor.ts`) in CI and preflight.
- Release integrity — `SHA256SUMS` + signed build-provenance attestation on
  release artifacts; the release job bound to the `release` GitHub
  Environment; AMO credentials passed by env, not argv (`packaging/sign.ts`);
  the local release path carries the same positive signing proof as CI
  (`packaging/release.ts`).
- Vendor acquisition — `scripts/vendor-cheerpx.sh` stages, verifies every file
  against `scripts/vendor-cheerpx.sha256`, and commits atomically (a mismatch
  or a failed fetch aborts without touching the tree); `--reseed` makes an
  upgrade a reviewable hash diff.
- Security CI (`.github/workflows/security.yml`) — CodeQL, OSV against the
  lockfile, and peerd's own architectural gate `bun run check:invariants`
  (`packaging/check-invariants.ts`): it pins the generated manifest surface for
  store, preview AND dev, every dynamic-code site, and every `runtime.onMessage`
  listener against a blessed baseline, and hard-refuses `content_scripts` /
  `externally_connectable` in any channel. PR dependency review runs alongside
  but is ADVISORY (`continue-on-error`) until the repository's Dependency graph
  setting is enabled — so the copyleft denylist reports without gating today.
- The actor relay sender-pin + grant, the actor-lane spend preflight + cost fold,
  and keyless custody on the spawned-child fallback — see P0-1..3 below, which
  record precisely what shipped and what remains.

## P0 — isolation invariants

### 1. Retire the in-service-worker actor fallback

**Partly shipped; the heap half remains.**

The offscreen-Worker path gives every non-orchestrator loop its own heap with
no key and no tool closures. The fallback path — Firefox, which has no
offscreen API, plus a run that never started — runs the child loop in the
service-worker realm.

Shipped, for the SPAWNED (ephemeral) child lane only: `restrictCtxCapabilities`
already stripped `getSecret`/`safeFetch` from the tool context unconditionally;
the loop itself used to receive the live credentials, and now receives throwing
stubs while the SW-owned `callModel` wrapper adds the real ones at the call
boundary (`keylessCredentials` in `extension/peerd-runtime/actor/spawn.js`).
Both the stubs AND the spread ordering that keeps the lane working are pinned by
`tests/peerd-runtime/spawn.test.ts` — the ordering matters because the stubs and
the real credentials collide in one object literal, and the wrong order hands
every in-SW model call a `getSecret` that throws.

Still open, two things:

1. **The BOUND-actor lane never got the stub custody.** A web/webvm/notebook/app/
   dweb actor with no offscreen client falls through `runActorTurnOffscreen` to
   `runAgentTurn`, which forwards the live `getSecret`/`safeFetch` into the loop
   (`loop/turn-driver.js`). So on Firefox the actors that ingest the most
   untrusted content are exactly the ones still holding credentials. Thread a
   `cappedCallModel`-style wrapper through that path.
2. **The part that matters most: no separate heap ⇒ no untrusted-content actor.**
   Keyless custody does not buy memory separation; the child's untrusted
   transcript still shares a realm with the vault broker and the engine clients.
   When an isolated host cannot be created, the feature should degrade with an
   explicit "secure actor isolation unavailable" state rather than execute in the
   privileged realm. For Firefox, evaluate an extension-page-hosted dedicated
   Worker as the isolated host before accepting that degradation.

### 2. Bind actor relay identity to the channel, not the payload

**Shipped.** The three relay routes in
`extension/background/offscreen-actor-client.js` used to authenticate only the
*sender class* (first-party extension context, via
`extension/shared/sender-trust.js`) and then trust identity fields in the
payload — so any first-party page, engine tabs included, could dispatch a tool
as an arbitrary actor session or spend the key on a dead run just by naming it.

Two checks now, and both are load-bearing:

- **The sender pin is the boundary.** Every relay requires `isOffscreenSender`
  (`extension/shared/sender-trust.js`) — an exact match on the offscreen document
  URL, not merely "first-party". This is what stops another extension page, and
  it is required because the token is *not* a secret from those pages:
  `runtime.sendMessage` has no way to address a single extension context, so the
  `actor/run` job — token included — is broadcast to every listener in the
  extension, engine tab pages among them. A grant alone would have been a shared
  secret handed to the adversary it was defending against.
- **The grant carries run identity and liveness.** Minted service-worker-side,
  stamped by the offscreen runner on every relay, never given to the Worker; the
  session id is no longer sent at all. Retiring it when the run settles refuses a
  replayed relay, which is the `script` lane's owner-check posture.

Neither alone suffices: the sender check cannot say *which* run is speaking, and
the token cannot say *who* is holding it.

Still open: targeted delivery — per-run `MessagePort`s bound at spawn to (actor,
session, generation) would stop broadcasting the job at all, making the token
genuinely private and letting relays drop payload identity entirely. Related and
pre-existing: `actor/abort` in `offscreen/offscreen.js` still takes a `runId`
from any first-party sender, so any extension page can cancel an in-flight actor
turn.

### 3. Close the actor-lane spend gap

**Preflight + fold shipped; hierarchical budgets remain.**

Per-lane limits were already real (child depth/steps/output/wall-clock in
`spawn.js`, delegation budgets keyed by lineage root in
`extension/peerd-runtime/actor/actor-messaging.js`, dweb inbound rate caps, and
a reserve-then-reconcile model-call quota on the `script` lane in
`extension/peerd-runtime/actor/provider-call-api.js`). The aggregate
`spendLimitUsd` gate, though, did not bound actors at all: `actor/model-call`
had no preflight, and offscreen actor-turn cost was broadcast to the UI without
ever being written to a tally — so delegating was a way around the cap.

Shipped: the actor turn's cost is folded into its session record
unconditionally, no longer only when a side panel happens to be connected, and
`actor/model-call` preflights before the key-bearing call. The preflight tests
**two** tallies, and which ones is the whole point:

- the ACTOR's own record — the one the fold writes. Preflight and fold naming the
  same record is what makes the check mean anything; an earlier revision of this
  work read the root chat's tally while the fold wrote the actor's, so the gate
  could never fire on actor spend at all. It is also the only check that works
  for the dweb daemon actor, a global singleton with no parent chat to walk to.
- the ROOT CHAT (`rootChatSessionFor`, bounded and cycle-guarded) — so a
  conversation that already blew its cap cannot keep spending by delegating.

Still open: **every model call debits one hierarchical budget** (session → actor
→ call). A fan-out across many actors, each individually under the cap, still
gets through, and spawned-child usage is summed but deliberately not rolled into
the parent. Rolling it up changes user-visible cost accounting, so it wants its
own design pass rather than a ride-along.

### 4. Full integrity for the WebVM root filesystem

The head-byte TOFU pin (`extension/peerd-engine/image-pin.js`, enforced in
`extension/engine-tabs/vm-tab/vm-tab.js`) fails closed on a *changed* head
and is honest about its limits: it detects accidental image drift, not a
malicious host serving a faithful head with a tampered tail (THREAT-MODEL
R8). It also deliberately fails open when the host is unreachable.

Target invariant: **every byte the VM reads is verified against a digest
shipped in the signed extension.** Preferred path: self-host an immutable,
content-addressed image and verify a signed Merkle chunk manifest during
ranged streaming, so no chunk reaches CheerpX unverified; keep rollback to
the previously trusted image; never silently update. The pin machinery and
its storage shape are the natural place to grow this.

### 5. Verify at vendoring time, not only after

**CheerpX shipped; three scripts remain.**

`vendor.lock.json` catches any post-commit change to vendored bytes, but the
*acquisition* step was uneven. The worst case is fixed:
`scripts/vendor-cheerpx.sh` — the highest-privilege vendored code in the tree,
wasm included, previously fetched from a single-vendor CDN with no expected
hashes and a warn-and-continue on failure — now stages to a temp tree, verifies
every file against `scripts/vendor-cheerpx.sha256`, and only then writes, with
`--reseed` as the explicit, reviewable path for a genuine upgrade. The
`SOURCE.txt` file-list drift (four shipped-but-undocumented `tun/` files) is
fixed in the same place.

Target invariant, still open for the rest: **every vendor script verifies a
predeclared digest before writing into `extension/vendor/`, and records
resolved versions.** `vendor-xterm.sh` and `vendor-transformers.sh` still
download-then-print rather than verify-then-write; `scripts/vendor-codemirror.ts`
records caret ranges rather than the versions it actually bundled and emits no
hash at all, so its output is not reproducible from its own provenance record.
The pattern to copy is `scripts/vendor-argon2.sh` (or the CheerpX script above,
for the multi-file case).

## P1 — architectural payoff

- **Capability handles over context closures.** The
  `CAPABILITY_CONSUMERS` map in `spawn.js` is already a capability→consumer
  inventory; evolve it from "delete unused closures from a shared object"
  into service-worker-issued, expiring, quota-carrying tokens that tool
  implementations redeem — the reference-monitor shape. The relay grant from
  P0-2 is the first instance of that shape and the prerequisite for the rest
  (an unbound capability token is replayable by any first-party page); what
  remains is extending it from "which run is speaking" to "what this call is
  allowed to touch" — origin, method, byte and call ceilings, expiry.
- **Durable operation registry + startup reconciliation.** Today the only
  durable operation store is the actor mailbox; live-children registries,
  turn slots, script runs, and in-flight offscreen state are all in-memory
  and die with the SW (a lost child is reported interrupted, never
  resumed — the honest but minimal posture). Introduce one lease-bearing
  operation record (owner, generation, expiry, idempotency class) shared by
  actors, engine runs, and long web operations, reconciled at SW startup —
  and classify tools by restart-retry safety so non-idempotent operations
  surface "may have completed; verify" instead of a generic failure.
- **Sandbox tiers for Apps.** The dev-manifest sandbox CSP is one broad
  profile (`manifests/base.json`); split runner pages into static /
  interactive-local / networked tiers with distinct CSPs rather than one
  permissive profile every artifact inherits.
- **Remote-module pinning by default.** The notebook/job module resolver
  (`extension/peerd-engine/module-resolver.js`) supports `#sha256` pins but
  they are opt-in, and module source rides the allowlist-free `webFetch`
  lane. Flip the default: unpinned `https:` imports require an explicit
  grant, or at minimum a per-run origin allowlist.
- **Security CI — extend the invariant gate.** The lane exists
  (`.github/workflows/security.yml`) and `packaging/check-invariants.ts` covers
  the manifest attack surface, dynamic-code sites, and message-listener sites.
  Rules still worth adding, each needing its own allowlist pass first: raw
  `fetch` outside `peerd-egress`, storage writes of secret-shaped keys outside
  the vault, and `runtime.onMessage` handlers that don't route through
  `makeDispatcher` (several narrow per-page handlers legitimately don't today,
  so this one needs the exceptions enumerated before it can gate).

## P2 — higher assurance

- **Taint-aware egress.** Coarse per-actor provenance (origins read) gating
  first contact with unrelated origins; GET-side limits (query length,
  entropy triggers, per-origin rates) on top of the existing body-method
  confirmations.
- **Differential isolation tests.** Assert actual heap separation and
  capability absence (not just functional outcomes) across Chrome
  stable/beta and Firefox, as an in-browser suite lane.
- **Privileged-core audit boundary.** Carve the reference-monitor subset of
  the service worker (message validation, gates, vault/egress brokers,
  durable state) behind a lint-enforced import rule, then treat it as the
  bounded target for external audit.
- **Local support bundle.** A no-telemetry diagnostics export (versions,
  schema versions, sanitized audit tail, failed invariant names) for field
  incident analysis.
