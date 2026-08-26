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
3. Move cohesive tool domains in dependency order. Each retained checkpoint
   adds finite named domain effects shared by orchestrator and isolated actors,
   moves semantic execution out of the service worker, removes the matching
   privileged context members and imports, and shrinks the allowlist.
4. When the allowlist reaches zero, delete `turn.tool.dispatch`, the old
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
