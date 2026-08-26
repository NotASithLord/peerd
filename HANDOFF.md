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

1. Keep the completed model-egress and migrated-tool paths on their single
   controller-semantics/exact-authority execution path. Do not add a fallback.
2. Delete only genuine aggregate or compatibility ownership that still makes
   ordinary semantic growth reachable from the service worker. The next target
   remains the live turn composition path, not another tool-family count.
3. Move the remaining semantic turn owner into the sealed controller and delete
   `kernel-turn-live-factories.js`, `kernel-turn-runtime.js` semantic closures,
   and `controller-turn-semantics.js` from the SW graph in the same executable
   cut. Exact session, actor, confirmation, audit, replay, browser, engine,
   repository, storage, alarm and egress custody stays in the kernel.
4. Only after that ownership cut, finish the frozen legacy lane if its removal
   is still necessary. When its allowlist reaches zero, delete
   `turn.tool.dispatch`, its implementation aggregate and all temporary
   compatibility machinery. New tools may never enter the legacy lane.

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

For every retained checkpoint record semantic service-worker reachability and
privileged context members removed, tools removed from the legacy allowlist,
packaged Store-Chrome bytes and inputs as telemetry, normalized authority graph
results, focused boundary/security results, and inherited failures reproduced
on the checkpoint baseline. A checkpoint is architectural progress when it
makes ownership simpler or makes feature-growth independence enforceable; byte
reduction alone is not a reason to add indirection. Commit and push each
retained checkpoint with a clean worktree before continuing.

Major cutovers and completion also run the full static and Bun gates,
in-browser verification, Store-Chrome package/posture checks, controller parity,
and fresh plus forced-wake cold-start measurements. Existing failures are debt,
not an excuse to stop: inspect them and prove no-new-failures parity against the
relevant baseline.

## Current retained state

The deletion-oriented chain is `2f92849`, `58ebb61`, `31afe71`, `4dd2279`,
`37c91a2`, `7ba4a2d`, `8379fbe`, `d3a99db`, and the current staged
provider-pricing closure.

- The broad `kernel-transfer.js` aggregate and generic controller tool-effect
  lane are deleted. Orchestrator and isolated actors share exact per-domain
  authority bindings while retaining their distinct lifecycle/grant envelopes.
- `kernel-turn-runtime.js` no longer imports the semantic turn driver, goal
  runner or todo implementation. It receives those owners from the one live
  composition path.
- Tool-name ownership now lives only in
  `peerd-runtime/controller-tool-ownership.js`. The authority graph imports a
  fixed class ledger (`local`, actor, Pod, repository, engine kinds,
  persistence, page, introspection, scheduling and dweb) and exact named
  operations. The deleted per-tool SW manifest and every redundant per-handler
  tool-name list no longer authorize effects.
- The frozen legacy allowlist remains at 17. No authority operation was added;
  existing exact handlers still bind owner/session/run, class, arguments,
  cancellation, replay and known/unknown outcome state.

The representative tool-feature fixture now adds a real controller-owned tool
policy (model-facing description and schema), implementation and ownership row
using the existing local authority class. After normalizing only generated
controller identity literals, the candidate has exactly the same SW inputs and
byte-identical authority code. The complete fixture appears only in the
controller graph.

Store-Chrome telemetry for the latest staged checkpoint is 1,304,247 bundled
SW bytes, 447 staged inputs and a 347,857-byte minified cold graph. The
preceding `d3a99db` package was 1,303,760 bytes with the same staged-input and
cold-graph counts. The live `kernel-turn-live-factories.js` graph fell from 292
to 291 modules: `peerd-provider/pricing.js`, `metadata.js` and
`semantic-metadata.js` are no longer reachable, leaving only the fixed provider
error types. Provider selection and price projection now occur in the sealed
controller and isolated actor worker. The SW validates and folds the bounded
price result and retains session spend-limit custody; a missing or malformed
price fails closed. The SW still owns the fixed egress manifest's credential
classification. These numbers are observations, not optimization targets.

The isolated Home harness (only the obsolete byte ceilings relaxed in the
measurement worktree) passed complete route/event/port and actionable-vault
readiness: 3.61 seconds from browser launch, 685 ms from worker target, 133 ms
from Home navigation, and 107 ms for a confirmed forced wake. The assessment
was green and remains inside the accepted functional envelope.

Verification: 197 focused boundary/security tests and the four controller
identity/feature-growth tests passed; static typecheck, lint, tscheck coverage
and the dweb boundary passed; Store packaging/posture passed. The full Bun
suite passed 7,511 tests and reproduced only the same five inherited failures:
the session-support cutover, native-entry identity, test-only vault package,
typed-error minification, and obsolete native cold-size target. The in-browser
suite passed 1,000 tests and reproduced only the same two inherited UI
failures. There are no new failures.

The remaining architectural blocker is narrower but real: the SW still reaches
`controller-turn-semantics.js` through `kernel-turn-live-factories.js`, and that
owner still supplies the turn driver, legacy dispatcher/registry and feature
orchestration. The next retained work must move one of those real closures to
its controller owner and delete its old import in the same checkpoint. Do not
resume per-domain allowlist churn or introduce a generic bridge merely to alter
bundle telemetry.

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
