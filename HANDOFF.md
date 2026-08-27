# Thin service-worker completion

## Objective

Chrome's service-worker graph is a fixed authority kernel. Ordinary tools,
providers, actors, prompts and feature semantics grow only in the sealed
controller or isolated actor workers. Bundle size is telemetry; the enforced
outcomes are clean ownership, no ordinary authority-graph growth, and complete
actionable readiness inside the accepted few-second cold-start envelope.

## Ownership boundary

The sealed controller owns provider request encoding and response semantics,
model selection and metadata, tool catalog/schema/registration, tool
implementations and planning, turn orchestration, actor reasoning and result
shaping, memory and scheduling semantics, composer/attachment shaping, Goal
continuation and ordinary feature orchestration.

The service worker owns synchronous listeners, sender provenance, sessions and
epochs, vault plaintext and credentials, fixed egress manifests and transport
custody, confirmation and audit, actor grants/lineage/mailbox/cancellation,
replay and outcome custody, and exact browser, engine, repository, storage and
alarm effects. Authority registries are allowed. Semantic registries are not.

No generic operation dispatcher, nested action selector, JSON tunnel,
arbitrary storage-key API, browser-method proxy, raw fetch proxy, privileged
function bag, duplicate implementation path or compatibility alias is allowed.
Each reverse call is one named domain operation with exact owner, session,
actor/run, argument, limit, cancellation, confirmation, replay and honest
known/unknown-outcome validation.

## Current retained surface

The model-egress vertical and migrated controller tools already have one
controller-semantic/exact-authority path. The service worker does not import
provider implementations or the growing tool catalog. The representative
controller-only feature fixture proves a normal semantic addition contributes
zero service-worker inputs and leaves normalized authority code byte-identical
apart from generated controller identity literals.

The current product-surface deletion checkpoint does all of the following:

- deletes `page_eval`, `page_exec` and `page_keys`, including their controller
  definitions, exact authority routes, actor relays and debugger-only residue;
- deletes the complete toolbox product and `peerd:toolbox/*` import surface;
- deletes `wait_until` and `dweb_guide` with their implementations and public
  metadata;
- replaces `read_web_cache` and `read_run_cache` with one public
  `read_result` capability backed by one session-owned opaque spill store for
  `fetch_url`, `read_doc`, `read_page` and `script`;
- keeps one producer-stamped provenance/fencing record, bounded pagination,
  opaque handles and fail-closed cross-session reads;
- removes the old disposable web-cache object store during the normal schema
  upgrade.

The public catalog contains 75 tools. Document/web/result semantics now run in
the sealed controller through exact constrained-web, document-extraction and
opaque-result operations. The temporary legacy set is the
exact list in `extension/shared/legacy-tool-allowlist.js`:

- `site_client_run`, `site_client_read`, `site_client_write`, `site_capture`;
- `sandbox_create`, `script`, `edit_file`, `a2a_run`.

The site-client subsystem is deliberately retained. It is Web-actor-only:

- tab-backed Web actors may run/read/write/capture;
- origin-pinned API Web actors may run/read/write but never capture;
- the Web code surface keeps its deliberate separate `site_client_run` path;
- the orchestrator, spawned generic actors, engine actors, App actors and the
  dweb actor never receive these tools.

Origin pinning, denylist/SSRF/egress policy, confirmation for persistence and
writes, session/actor custody, untrusted fencing and capture document identity
remain mandatory.

The obsolete 300 KB artifact target is deleted. Normal packaging enforces the
achieved per-channel no-growth graph ratchets and records bytes as telemetry;
the browser harness enforces graph integrity plus actionable-readiness timing.
There is no substitute arbitrary byte target.

## Verification baseline

The current Store-Chrome artifact packages and passes Store posture at
1,258,927 bundled service-worker bytes, 419 staged inputs and a 347,603-byte
release-minified cold graph. The preceding checkpoint was 1,263,238 bytes,
425 inputs and the same cold-graph size. These values are observations, not
goals.

Static typecheck, lint, checked-file coverage, dweb boundary, controller
identity, ownership boundaries and focused security tests pass. The full Bun
suite passes 7,407 of 7,409 tests. The two inherited failures are the
session-support loss-accounting test and the typed-error minification harness
that cannot import its temporary bundle. The in-browser suite passes 940 of
942 and reproduces its two inherited UI-copy assertions. The functional E2E
harness still refuses `settings/update` with the inherited
`kernel-demand-routes-load-failed` startup result. Do not treat these debts as
new regressions, and do not add new failures.

## Remaining deletion sequence

Continue with cohesive controller migrations. Every retained cut removes its
legacy name/import in the same commit and keeps one execution path:

1. Sandbox/headless semantics: `sandbox_create`, `script`. Authority retains
   exact engine instance, job, cancellation, confirmation and settlement
   operations.
2. Cross-kind editing: `edit_file`. Authority retains exact repository and
   engine file mutations, confirmation, audit and outcome custody.
3. Mesh execution: `a2a_run`. Authority retains A2A grants, mesh identity,
   confirmation, lifecycle and settlement.
4. Site clients: all four retained site-client tools move together while the
   service worker keeps the exact origin-pinned store/runtime/capture effects
   and every Web-actor restriction above.

When the list reaches zero, physically delete
`legacy-tool-allowlist.js`, `legacy-implementations.js`, `turn.tool.dispatch`,
service-worker tool registration/execution and all strangler tests/docs. Do not
leave a fallback.

Then finish the residual semantic-root cut: relocate remaining composer and
attachment shaping, Goal continuation, scheduler/memory orchestration and
actor result shaping to their sealed owners. Delete
`controller-turn-semantics.js`, `kernel-turn-live-factories.js` and any
superseded aggregate/compatibility machinery once no authority caller needs
them. Fixed session, vault, egress, browser/storage/engine, confirmation/audit,
actor, alarm, replay and lifecycle custody stays in the service worker.

## Completion condition

Every public tool has exactly one controller semantic owner. The production
Store-Chrome service worker imports no provider implementation, tool
definition/catalog, semantic registry, turn/actor implementation or controller
semantic root. The legacy dispatcher and every compatibility path are deleted.
An ordinary controller-only feature adds no service-worker input, normalized
authority code or authority operation apart from the generated identity
literal. Static, Bun, browser, security and package verification have no new
failures; fresh and forced-wake readiness remains inside the accepted envelope;
the worktree is clean; and every retained checkpoint is committed and pushed.
