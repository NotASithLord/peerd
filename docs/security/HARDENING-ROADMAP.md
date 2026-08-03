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

## P0 — isolation invariants

### 1. Retire the in-service-worker actor fallback

The offscreen-Worker path gives every non-orchestrator loop its own heap
with no key and no tool closures. The fallback path (taken on Firefox, or
when a run never starts offscreen) runs the child loop in the service-worker
heap: `restrictCtxCapabilities` (`extension/peerd-runtime/actor/spawn.js`)
strips `getSecret`/`safeFetch` from the *tool context*, but the fallback
branch in the same file hands the real `getSecret`/`safeFetch` into the
child's turn runner, and the child's untrusted transcript shares a realm
with the vault broker and every engine client.

The prose currently overstates this: `CLAUDE.md` and THREAT-MODEL R1 call
the fallback "keyless", which is true of the tool ctx and not of the heap.

Target invariant: **no separate heap ⇒ no untrusted-content actor.** When
an isolated host cannot be created, degrade the feature with an explicit
"secure actor isolation unavailable" state instead of executing in the
privileged realm. For Firefox, evaluate an extension-page-hosted dedicated
Worker as the isolated host before accepting the degradation. Reconcile the
"keyless" wording in `CLAUDE.md` and `docs/security/THREAT-MODEL.md` in the
same change.

### 2. Bind actor relay identity to the channel, not the payload

The actor relay routes (`extension/background/offscreen-actor-client.js`)
authenticate the *sender class* (first-party extension context, via
`extension/shared/sender-trust.js`) but trust identity fields in the
payload: `actor/tool-dispatch` builds a tool context from a caller-supplied
`actorSessionId`, and `actor/model-call` proceeds on an unknown `runId`.
Any first-party page — engine tabs included — can therefore address these
routes with a forged identity. (Contrast: the Worker itself cannot forge a
session — the runner injects the session id server-side — and the `script`
lane already enforces run-owner checks in
`extension/background/service-worker.js`.)

Target invariant: **privileged routes derive identity from the channel.**
Pin the actor relay routes to the offscreen document's sender URL; check
`runId` liveness and ownership on `actor/model-call` the way the script
lane does; longer-term, move offscreen↔SW traffic onto per-run
`MessagePort`s bound at spawn to (actor, session, generation) so messages
stop carrying identity at all.

### 3. Close the actor-lane spend gap

Per-lane limits exist and are real (child depth/steps/output/wall-clock in
`spawn.js`, delegation budgets keyed by lineage root in
`extension/peerd-runtime/actor/actor-messaging.js`, dweb inbound rate caps,
and a reserve-then-reconcile model-call quota on the `script` lane in
`extension/peerd-runtime/tools/provider-call-api.js`). But the aggregate
`spendLimitUsd` gate does not bound actors: `actor/model-call` has no spend
preflight, offscreen actor-turn cost is broadcast to the UI without being
folded into a session tally, and spawned-child usage is summed but
deliberately not folded into the parent.

Target invariant: **every model call debits one hierarchical budget**
(session → actor → call), so per-actor limits cannot be bypassed by
fan-out. Give the actor lane the same quota + preflight the script lane
has, then fold both into the session spend tally.

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

`vendor.lock.json` now catches any post-commit change to vendored bytes,
but the *acquisition* step is uneven: `scripts/vendor-cheerpx.sh` downloads
the highest-privilege vendored code in the tree (including wasm) with no
expected hashes and continues on partial failure, and
`scripts/vendor-codemirror.ts` records caret ranges rather than the
resolved versions it actually bundled. The shell scripts that do it right
(`scripts/vendor-argon2.sh`, `vendor-moonshine.sh`, `vendor-wasi-shim.sh`,
`vendor-tesseract.sh`) refuse to vendor on digest mismatch.

Target invariant: **every vendor script verifies a predeclared digest
before writing into `extension/vendor/`, and records resolved versions.**
Bring `vendor-cheerpx.sh`, `vendor-xterm.sh`, `vendor-transformers.sh`, and
`vendor-codemirror.ts` up to the argon2 pattern; fix the CheerpX
`SOURCE.txt` file-list drift while there.

## P1 — architectural payoff

- **Capability handles over context closures.** The
  `CAPABILITY_CONSUMERS` map in `spawn.js` is already a capability→consumer
  inventory; evolve it from "delete unused closures from a shared object"
  into service-worker-issued, expiring, quota-carrying tokens that tool
  implementations redeem — the reference-monitor shape. Sequencing note:
  item P0-2 (channel-bound identity) is the prerequisite; tokens without
  channel binding are replayable by any first-party page.
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
- **Security CI.** Add CodeQL, OSV/dependency review, and repo-specific
  semgrep-style rules (raw `fetch` outside `peerd-egress`, storage writes of
  secrets outside the vault, message handlers without schema validation,
  manifest permission/CSP diffs) as first-class jobs beside the existing
  boundary/drift gates.

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
