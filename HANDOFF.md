# Thin service-worker branch closeout

## Status

- Remote: `fork/architecture/execution-protocol`
- Accepted architecture candidate: `a0df6d5bf6452f40f11f4ae2f25c870f59eda442`
- The branch is merge-ready after the final closeout commit and normal CI review.
- No architecture migration remains. Do not resume mechanical tool movement or byte chasing.

## Product outcome

The extension now has two execution roots:

- The sealed controller owns tool definitions, metadata, exposure, semantic dispatch, provider and turn semantics, result shaping, and feature planning.
- The service worker is a stable authority kernel. It retains credentials and egress, browser and tab authority, storage and vault custody, engine custody, actor grants and lifecycle, confirmation, audit, replay classification, sessions, epochs, and finite exact effect handlers.

All production tools use the controller path. The legacy allowlist, service-worker tool registration and execution, `turn.tool.dispatch`, compatibility fallbacks, and superseded semantic aggregate roots are gone. Ordinary semantic feature additions are proven to add zero service-worker inputs, zero normalized authority bytes, and zero native bundle bytes.

The approved product cleanup is complete. Obsolete page-eval, page-exec, page-keys, toolbox, wait, guide, and review concepts were removed. Result spill paging is one session-bound `read_result` surface. Document reading includes PDF handling through the unified document path.

Site clients remain a Web-actor capability. Tab Web actors may run, read, write, and capture. Origin-pinned API Web actors may run, read, and write but cannot capture. Main, spawned, and non-Web actors never receive these tools. Origin pinning, capture identity, confirmation, fencing, and network policy remain authoritative.

No generic privileged proxy, catch-all operation selector, JSON tunnel, function bag, alias path, or dual execution path was introduced.

## Performance outcome

Historical measurements below are bound to the accepted candidate and the then-current `fork/main` base.

| Surface | Main | Branch | Change |
|---|---:|---:|---:|
| Store Chrome native service worker | 2,060,109 B | 1,338,125 B | 35.0% smaller |
| Store Chrome authored authority graph | 4,704,518 B / 458 modules | 3,992,852 B / 410 modules | 711,666 B and 48 modules removed |
| Store Chrome offscreen cold graph | 546,292 B | 19,676 B | 96.4% smaller |
| Store Firefox service worker | 2,060,112 B / 458 modules | 406,651 B / 88 modules | 80.3% smaller and 370 modules removed |

Measured actionable startup stayed inside the accepted few-second envelope:

- Chrome: 1.630 seconds from fresh browser launch in the final exact-hash review, 699 ms from worker target, and 105 ms forced wake. An earlier accepted device run measured 2.368 seconds from full launch.
- Firefox: 1.326 seconds for the full session, 152 ms install-to-ready, and 98 ms idle-discard wake.

These are outcome measurements, not future byte targets. The no-growth architecture and its ratchets are the durable contract.

## Acceptance evidence

The accepted candidate passed:

- the complete local preflight with the four-target package matrix;
- the full Bun suite, strict typecheck, lint, complete `// @ts-check` coverage, source and copy hygiene, dweb boundary, import closure, vendor and action integrity, and security invariants;
- Store and Preview packages for Chrome and Firefox, including Store posture and packaged-page boot;
- Chrome Actor Fabric, the complete non-network functional matrix, lifecycle and controller-fault lanes, cold-start evidence, and controller feature-growth proof;
- Firefox product, controller, cutover, Pod, event-page recovery, browser-shard, and cold-start lanes;
- final adversarial reviews of architecture and security, correctness and lifecycle, maintainability, user and model behavior, dead concepts, and test honesty.

The release gate now exercises packaged probes through their real owners: notebook remote imports, Options artifact import, Home repository operations, the singleton offscreen host, and the native side panel. Synthetic targets are closed rather than leaked. Timeout custody tests use deterministic clocks or exact packet settlement instead of millisecond sleeps.

## Deliberate exclusion

The owner explicitly excluded the two remaining broad Chrome network suites from this closeout:

- `browser-network-rules`
- `browser-network-floor`

They were not required for this branch acceptance and must not be represented as run. Focused network authority, sender provenance, package policy, static security, and existing browser coverage passed. Resume those broad suites only as separate follow-up work if desired.

## Future change rule

New tools and semantic features belong in the sealed controller. A change is acceptable only if it preserves the exact authority boundaries and passes the feature-growth proof without adding a new service-worker input or normalized authority byte. A genuinely new privileged capability requires its own named, bounded, run-scoped operation and explicit custody tests.

Do not weaken sender provenance, vault or credential custody, browser or network authority, actor isolation, confirmation, audit, replay, or lifecycle fencing to make a feature easier to wire.

## Resume point

There is no remaining branch implementation task. The next action is normal PR and CI review. If CI finds an environment-specific issue, fix that concrete issue on the existing architecture and rerun its affected gate. Do not reopen the architecture unless new evidence disproves the feature-growth or cold-start contracts above.
