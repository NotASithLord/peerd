# Thin service-worker branch handoff

## Resume point

- Remote: `fork/architecture/execution-protocol`
- Implementation checkpoint: `5c697873a114726481b52c07d00de4e360cebe5a`
- Local checkout used for the checkpoint: `fix/thin-sw-final-integration`
- The implementation checkpoint is pushed. This document is the only expected follow-up commit.
- This is a strong integration checkpoint, not yet a merge-ready final acceptance. The remaining work is validation and ratchet reconciliation, not another architecture migration.

## Product goal

Keep the MV3 service worker a small, stable authority kernel whose cold graph does not grow when ordinary tools, prompts, providers, or semantic features are added. A cold launch within a few seconds is acceptable. Maintainability and feature-count-independent SW growth are primary; further byte reduction is bonus telemetry.

The final boundary must remain:

- Sealed controller: tool definitions and metadata, exposure/projection, semantic dispatch, model/turn semantics, result shaping, and other feature semantics.
- Service worker: credentials and egress, browser/tab/debugger authority, storage/vault, engine custody, actor grants/lineage/cancellation, confirmation, audit, replay classification, sessions/epochs, lifecycle, and finite exact effect handlers.

Never introduce a generic privileged proxy, catch-all dispatcher, operation selector, JSON tunnel, function bag, compatibility fallback, or dual execution path.

## What is complete

- Remaining tool semantics were consolidated behind the sealed controller. The old SW tool registration/execution path, legacy allowlist, `turn.tool.dispatch`, and superseded aggregate roots are absent from production code. Boundary tests retain those names only as forbidden-edge assertions.
- Approved product deletion/consolidation is complete: obsolete page-eval/exec/keys, toolbox, wait, guide, and review concepts were removed; cache spill paging is one session-bound `read_result` surface.
- Site clients remain a core Web-actor capability with the intended split: tab Web actors may run/read/write/capture; origin-pinned API Web actors may run/read/write but not capture; non-Web actors do not receive the surface.
- Authority is expressed through finite named run-bound operations. Browser, network, storage, vault, credential, engine, actor, confirmation, audit, replay, and lifecycle custody remain in the SW.
- Controller startup, worker-loss, exact-offer fencing, reverse-effect custody, bounded routing, actor isolation, and Firefox lifecycle coverage were expanded substantially.
- The checked-in controller build identity was restamped after the final source change.

## Latest fix at the checkpoint

Actor Fabric exposed a Chrome controller lifecycle bug. A controller feature lease can be shared by work outside the semantic client, but the client retired its channel when its own local call count reached zero. A later call under the still-live exact lease re-offered the same generation; the host correctly rejected it.

The fix in `extension/background/offscreen-controller-client.js` now:

- binds the client to the complete exact lease identity;
- reuses one channel only for that identical lease;
- replaces it only for a different/newer lease;
- lets exact lease release, authenticated host loss, or explicit retirement close it;
- object-fences close callbacks so a delayed predecessor cannot clear its successor;
- removes the local leased-user retirement heuristic;
- keeps the host's same-generation rejection strict;
- adds no retry queue, priority lane, generic dispatch, or second path.

The focused regression holds the controller lease externally across local semantic gaps, proves one offer/channel is reused, releases the exact lease, and proves the successor reconnects cleanly.

## Evidence at `5c69787`

Passed after the latest fix:

- focused controller, controller-host, actor-client, production actor factory, and spawn suites;
- turn-slot regression suite;
- strict typecheck;
- ESLint;
- full `// @ts-check` coverage ratchet;
- dweb boundary;
- source hygiene;
- controller build-identity verification.

Earlier on the same integrated branch, Firefox acceptance was green across Store and Preview, including controller/cutover/pod lanes, the in-browser Gecko suite, event-page recovery, and cold/actionable startup. Focused Chrome options/PDF, script fanout, dweb, actor reconnect/error/A2A/overview, and session-boundary lanes were also green. Treat those as checkpoint evidence; rerun the final matrix on the final hash rather than copying counts into durable docs.

Prior cold evidence was within the accepted few-second envelope on both browsers. It must be remeasured after ratchets are reconciled; do not optimize to an arbitrary byte target if the stable architectural boundary and timing envelope hold.

## Deliberately deferred

The owner explicitly stopped the remaining broad Chrome network work for this checkpoint.

1. **Physical Actor Fabric rerun.** The exact lease bug now has focused executable coverage, but `actor-fabric-hierarchy` has not been rerun in real Chrome after this final fix. Run this single state before the broad suite. Its previous failure was `turn.actor.message` reaching projection and then receiving `handshake-failed` from the duplicate same-lease offer.
2. **Chrome browser-network-floor sequence.** A prior broad sequence reached only part of its assertions. Evidence pointed to sequence/state contamination around previously visited origins/DNR scope plus a missing child-policy result, but it was not fully classified or fixed. Do not conflate this with the controller lease bug. Resume only if the owner wants the broad network lane completed.
3. **Full Chrome functional matrix.** Not rerun after the final lease fix.
4. **Package/cold ratchets.** Exact authored/package graph baselines are stale after the full integration and must be recomputed intentionally for every Store/Preview and Chrome/Firefox target. Do not blindly copy old measurements or relax ceilings.
5. **Final all-up acceptance.** Full Bun, package/security/browser/cold matrix and a final adversarial review should run on one exact hash. Separate inherited/environmental failures from new regressions.

## Recommended continuation order

1. Confirm the handoff commit and remote are identical and the worktree is clean.
2. Run only `actor-fabric-hierarchy` in Chrome. If it fails, inspect exact lease identity/offer count first; do not add concurrency retries or loosen host fencing.
3. Recompute and review cold/package graphs. The success criterion is that representative controller-only feature growth adds zero SW inputs and no normalized authority-code growth other than unavoidable build identity.
4. Run the full non-network test/package/security matrix.
5. Decide explicitly whether to resume the deferred browser-network-floor lane. It is the only intentionally skipped broad Chrome area.
6. Run one final adversarial review on the exact candidate hash, fix only concrete findings, rerun affected checks, push clean, then write the PR summary.

## Useful commands

Use the repository scripts in `package.json`; they are the authority. The focused continuation starts with:

```sh
bun scripts/cdp/run-e2e-verify.mjs --functional --only=actor-fabric-hierarchy
bun test tests/background/semantic-controller-client.test.ts tests/background/offscreen-controller-prototype.test.ts tests/background/offscreen-actor-client.test.ts tests/background/kernel-turn-live-factories.test.ts tests/peerd-runtime/spawn.test.ts
bun run typecheck
bun run lint
bun run check:tscheck
bun run check:boundary
bun run check:hygiene
```

Then use the current package, cold-graph, Firefox, in-browser, and preflight scripts named in `package.json`; do not rely on command inventories copied into this handoff.

## Stop conditions

Course-correct immediately if continuation adds semantic feature imports to the SW, recreates any legacy tool path, broadens authority into the controller, adds a generic operation surface, accepts a repeated exact lease, creates a preparation-only abstraction, or starts chasing byte reductions without improving the stable boundary or measured cold behavior.

