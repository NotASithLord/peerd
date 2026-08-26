# Thin service-worker migration

## Objective

Chrome's service-worker cold graph must scale with a small, fixed authority
kernel rather than with ordinary feature count. The sealed controller and
isolated actor workers own growing semantics. The final package size is
telemetry; correctness, maintainable ownership and the accepted functional
cold-start envelope are the gates.

## Final ownership

The sealed controller owns provider request shaping and response semantics,
model metadata and selection, tool schemas/catalog/registration,
implementations and planning, turn orchestration, actor reasoning and result
shaping, memory and scheduling semantics, and ordinary feature orchestration.

The service worker owns synchronous listener registration, sender provenance,
lifecycle and replay custody, sessions and epochs, vault plaintext and
credentials, fixed network egress policy, confirmation and audit, actor grants,
lineage, mailbox and cancellation, and exact browser, engine, repository,
storage and alarm effects. Authority registries may remain; semantic registries
may not.

## Migration sequence

1. Move model execution end to end. Controller adapters shape requests, apply
   retry/failover policy, decode streams and interpret responses. The kernel
   resolves a compact provider authority manifest and owns fixed endpoints,
   credential binding, authentication, request/response limits, stream lifetime
   and cancellation. Apply the same path to orchestrator and isolated actors,
   including model inventory and live context-window reads. Delete direct
   adapter `getSecret`/`safeFetch` execution from the service-worker graph in
   the same checkpoint.
2. Introduce a frozen explicit allowlist for the temporary legacy tool lane.
   A tool is controller-owned or legacy-owned, never both, and new tools cannot
   enter the legacy lane.
3. Before moving another tool domain, delete broad aggregate edges and
   duplicate orchestrator/isolated-actor authority wiring. Each retained seam
   checkpoint must remove superseded service-worker reachability and reduce
   the actual package or the disposable fixed-authority projection; revert
   preparation-only changes. Exact per-domain route modules may be shared, but
   generic dispatch and opaque payload envelopes remain prohibited.
4. Resume cohesive tool-domain relocation only after the projected authority
   floor trends downward. When the allowlist reaches zero, delete
   `turn.tool.dispatch`, the old
   dispatcher/context aggregate, the temporary migration machinery, and every
   synchronous service-worker import of the controller semantic root, provider
   implementations, tool catalog/definitions, turn driver and actor semantics.

## Boundary rules

- No generic operation dispatcher, nested action selector, JSON tunnel,
  arbitrary storage-key API, raw browser-method proxy, raw fetch proxy, generic
  privileged callback or duplicate implementation path.
- An authority operation represents one complete domain action and validates
  owner/session/actor grants, limits, cancellation, replay and honest
  known/unknown outcome state.
- The controller never receives vault plaintext, credential names, URLs,
  authentication headers or arbitrary fetch options. It supplies a provider
  identity and provider-native body through the fixed egress authority class.
- Ordinary semantic additions may update the controller build-identity literal
  but must add no service-worker inputs, normalized authority code or authority
  operation.
- A genuinely new browser, vault, storage or egress capability class requires
  explicit authority review and a ledger update.

## Checkpoint evidence

For every retained checkpoint record the semantic service-worker modules and
privileged context members removed, tools removed from the legacy allowlist,
packaged Store-Chrome bytes and inputs, normalized authority graph telemetry,
focused boundary/security results, and any inherited failure reproduced on the
checkpoint baseline. Commit and push each retained checkpoint with a clean
worktree before continuing.

Major cutovers and completion also run the full static and Bun gates,
in-browser verification, Store-Chrome package/posture checks, controller parity,
and fresh plus forced-wake cold-start measurements. Existing failures are debt,
not an excuse to stop: inspect them and prove no-new-failures parity against the
relevant baseline.

## Current course-correction checkpoint

The retained seam work is `2f92849` followed by `58ebb61`.

- Both service-worker imports of `peerd-runtime/kernel-transfer.js` were
  replaced by exact transfer, persistence, policy and self-sync custody leaves;
  the aggregate module was deleted.
- Orchestrator and isolated-actor relays now bind the same exact per-domain
  authority implementations. Repeated repository-authority construction was
  deleted from the actor route table. The remaining host adapters are
  intentionally distinct: one binds turn-call custody, while the other binds
  sender-pinned actor grants, relay quotas and run settlement. Collapsing those
  lifecycle envelopes would require the prohibited generic callback/dispatcher
  shape.
- No authority operation or legacy tool was added or removed. The frozen legacy
  allowlist remains at 17.

Measured from clean commits with Store posture verification:

| Commit/artifact | Store SW bytes | Inputs | Minified cold graph |
|---|---:|---:|---:|
| `7ff9fae` decision point | 1,318,602 | 452 | 347,757 |
| `58ebb61` actual | 1,317,300 | 451 | 347,757 |
| `7ff9fae` authority-only projection | 1,101,421 | 362 | 347,757 |
| `58ebb61` authority-only projection | 1,100,140 | 362 | 347,757 |

The actual worker decreased by 1,302 bytes and one input; the projected fixed
authority floor decreased by 1,281 bytes without adding an input. The exact
input deleted is `peerd-runtime/kernel-transfer.js`. The current projection
still removes 89 semantic inputs and 217,160 bundled bytes without removing a
background authority handler or adding a projection input.

The Home cold harness at `58ebb61`, run from an isolated measurement worktree
with only the obsolete byte ceilings relaxed, reached full actionable readiness
in 2.36 seconds from browser launch and 841 ms from worker target. A confirmed
forced wake reached actionable readiness in 137 ms. Both route-readiness and
timing assessments passed.

Focused boundary/security verification passed 123 tests with no failures. The
full Bun run passed 7,532 tests and reproduced only the five inherited failures;
the in-browser run passed 1,000 tests and reproduced only its two inherited UI
failures. Typecheck, lint, tscheck coverage, the dweb boundary, and both Store
posture checks passed. The ordinary packaged-import command still stops at the
inherited 300 KB Preview cold-graph ceiling rather than an import defect.

Next work remains deletion-first at the three projected semantic roots:
`kernel-turn-live-factories.js`, `kernel-turn-runtime.js`, and
`controller-turn-semantics.js`. Do not count further allowlist churn as
architectural progress unless the same checkpoint makes one of those real
imports or its superseded aggregate closure disappear.

## Completion condition

The production Store-Chrome service worker no longer contains provider
implementations, tool catalog/definitions, semantic turn or actor
implementations, or the controller semantic root. The legacy tool dispatcher
and every compatibility fallback are physically deleted. A representative
controller-only feature fixture proves ordinary semantic growth leaves the
normalized authority graph and service-worker input ledger unchanged apart from
the generated controller identity literal. Behavior and security have no new
failures, cold start remains within the accepted functional envelope, and all
retained work is committed and pushed.
