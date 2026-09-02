# Thin service-worker integration handoff

## State

- Delivery branch: `fork/architecture/execution-protocol`
- Integration worktree branch: `fix/thin-sw-final-integration`
- Architecture and production changes are complete. Final packaged-browser and release verification is in progress.
- Do not resume mechanical tool migration or optimize byte counts for their own sake.

## Durable architecture

The extension has two execution roots:

- The sealed controller owns tool definitions, metadata, exposure, semantic dispatch, provider and turn semantics, result shaping, and feature planning.
- The service worker is the authority kernel. It owns credentials and egress, browser and tab authority, storage and vault custody, engines, actor grants and lifecycle, confirmation, audit, replay classification, sessions, epochs, and finite exact effect handlers.

All production tools use the controller path. The legacy tool allowlist, service-worker registration/execution path, `turn.tool.dispatch`, compatibility fallbacks, and superseded semantic aggregates are gone. The feature-growth gate proves an ordinary controller-only tool adds no service-worker input or normalized authority code.

Site-client tools remain strictly Web-actor capabilities. Tab Web actors may run, read, write, and capture. Origin-pinned API Web actors may run, read, and write but cannot capture. Main, spawned, and non-Web actors never receive them. Origin pinning, capture identity, confirmation, fencing, and network policy remain authoritative.

Repository and App file operations run in a disposable offscreen module Worker per operation. The service worker transfers the exact operation channel end to end and holds its keyed lane until the matching Worker termination acknowledgement. A lost operation can retire only its own host epoch; it cannot kill a healthy successor. No generic proxy, operation selector, JSON tunnel, function bag, alias, or dual execution path exists.

## Final hardening in this integration pass

- Browser-origin and denylist state now fail closed on malformed persisted snapshots while preserving valid first-run absence.
- Keyed origin credentials rehydrate before actor/controller recovery after unlock.
- Spend-limit authority failure cannot open provider custody.
- A failed durable audit append latches the run or actor grant, preserves exact physical receipts and outcome knowledge, refuses later privileged effects, and prevents clean semantic finalization.
- Result paging and attachment recovery messages describe retained data precisely and never suggest blindly replaying effectful work.
- Proven dead helpers, fake configuration knobs, duplicate test-only mirrors, and an unused checkpoint manager were removed. Broader security-sensitive bridge duplication remains intentionally untouched.

## Product cleanup retained

Obsolete page-eval, page-exec, page-keys, toolbox, wait, guide, and review concepts remain deleted. Result spill paging is one session-bound `read_result` surface. Document reading includes PDF support through the unified document path.

## Acceptance still to record

Before landing, replace this section with the exact final commit, package measurements, Chrome/Firefox cold-start evidence, full suite results, and local/remote identity. The final candidate must have a clean worktree and no diagnostic tracing.

## Future change rule

New semantic features belong in the sealed controller. A new privileged capability requires its own named, bounded, run-scoped authority operation and custody tests. Do not weaken sender provenance, vault or credential custody, browser or network authority, actor isolation, confirmation, audit, replay, or lifecycle fencing to simplify wiring.
