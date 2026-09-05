# Thin service-worker integration handoff

## Delivery state

- Delivery branch: `fork/architecture/execution-protocol`
- Runtime candidate measured below: `b363d54546ea8fc807b5ffded2f1f8bf1b903348`
- Comparison base: `09032f7bf7c68b7ae5c958cf85eeba96f29af62a` (`origin/main` at review time)
- Architecture, product cleanup, hardening, and local acceptance are complete. Any delivery-tip commit after the runtime candidate is documentation-only unless its diff says otherwise.
- Landing verdict: approve after the required pinned-runner CI release/cold-start lane is green. Do not resume mechanical tool migration or byte-target optimization.

Numbers in this document are a commit-bound acceptance snapshot, not permanent documentation. Executable budgets, generated badges, package verification, and CI remain the source of truth.

## Result

There is one tool architecture. The sealed controller owns tool definitions, metadata, exposure, semantic execution, provider/turn semantics, and result shaping. The service worker is a finite authority kernel: it owns browser and tab access, network egress, exact credential use, durable state, engine custody, actor grants, confirmation, audit, replay, sessions, epochs, and lifecycle.

All production tools execute through the controller. The legacy allowlist, service-worker tool registration/execution, `turn.tool.dispatch`, compatibility execution fallbacks, and superseded semantic aggregates are gone. No generic authority proxy, open operation selector, JSON authority tunnel, mutable function bag, authority/transport/execution alias, or dual execution path remains. Three old saved-manifest names survive only as data migrations in `tools/manifests.js`; they cannot execute.

The durable growth rule is precise: ordinary controller-only tools and semantic features that reuse existing exact authority operations add zero service-worker inputs and zero normalized authority bytes, apart from a generated build-identity literal. A genuinely new privileged capability, or an intentional change to the frozen lifecycle kernel, may legitimately add reviewed service-worker code.

## Product and capability outcome

- Removed obsolete `page_eval`, `page_exec`, `page_keys`, toolbox, `wait_until`, `dweb_guide`, and review/request-review concepts.
- Replaced separate cache readers with one session-bound, source-fenced `read_result` spill pager.
- Unified document reading includes searchable PDF and DOCX. OCR remains unavailable until production integrity metadata exists.
- Preserved both Web/App direct and code surfaces.
- Preserved the full deterministic site-client subsystem as a Web-actor capability:
  - tab Web actors may run, read, write, and capture;
  - origin-pinned API Web actors may run, read, and write, but never capture;
  - main, spawned, and non-Web actors receive none of these operations.
- Origin pinning, write confirmation, live Act checks, capture/document identity, target-change fencing, header filtering, and network policy remain host-authoritative.

Repository and App file operations use disposable offscreen module Workers. Each receives only its exact operation channel, while the service worker keeps keyed custody until the matching termination acknowledgement. A lost operation can retire only its own epoch, never a healthy successor.

Vault key custody now lives in the sealed vault Worker. The service worker brokers bounded session resume and receives only explicitly requested plaintext at an exact egress handler; neither the controller nor actor heaps receive credential or generic-fetch authority.

## Package graph compared with main

| Package | Main | Candidate | Change |
| --- | ---: | ---: | ---: |
| Store Chrome | 2,060,109 B / 458 modules | 2,040,345 B / 400 modules | -19,764 B / -58 modules |
| Preview Chrome | 2,060,446 B / 458 modules | 2,155,257 B / 406 modules | +94,811 B / -52 modules |
| Store Firefox | 2,060,112 B / 458 modules | 416,064 B / 87 modules | -1,644,048 B / -371 modules |
| Preview Firefox | 2,060,138 B / 458 modules | 421,463 B / 89 modules | -1,638,675 B / -369 modules |

The Preview-Chrome byte increase is fixed preview-only authority for dweb, updates, contributor mode, and debugger support, not semantic/tool graph leakage. Store Chrome is smaller than main, and both Firefox workers lose most of main's semantic graph. Size is telemetry; the architectural win is that ordinary future semantic growth no longer joins these worker graphs.

Current exact graph ceilings live in `scripts/bench/cold-start-budgets.js`. Store/Preview boundaries and all four packaged feature-growth cells are enforced by tests and packaging.

## Cold-start evidence

The release-sized clean sample immediately before the final 180-byte private-network guard change completed 15/15 Chrome launches and wakes and 7/7 Firefox launches and recycle cycles:

- Chrome median full launch to actionable: about 1.53 s; worker-to-actionable about 0.73 s; navigation-to-actionable about 0.17 s; forced wake about 0.24 s.
- Firefox median WebDriver-session launch to actionable: about 1.21 s; install-to-actionable about 0.14 s; idle wake about 0.08 s.

The final runtime checkpoint's local lane remained green after the guard: Chrome navigation-to-actionable 185.76 ms and forced wake 214.34 ms; Firefox install-to-actionable 186.31 ms and idle wake 74.35 ms. The guard adds 180 minified bytes and no modules to both Chrome packages; Firefox graphs are unchanged.

These results are comfortably inside the accepted few-second envelope. Release promotion still requires the repository's pinned CI runner identity; local runs must not spoof it.

## Verification snapshot

At the runtime checkpoint:

- Full Bun suite: 7,845 passed, 0 failed.
- Full preflight: passed, including generated-file drift, lint, strict typecheck, 1,024/1,024 checked-file coverage, dependency/security boundaries, exact graph ratchets, package posture, docs, copy, and source/vendor checks.
- Four unsigned release packages: passed exact graph and Store/Preview boundary validation.
- Chrome physical E2E: 44 states, 366/366 checks, no visual movement; browser-network floor 58/58.
- Firefox registered browser suite: 967/967 across eight shards on the reviewed architecture. Final physical Store-Firefox cutover, credentialed Smart HTTP, persistence, cleanup, recovery, and UI checks also passed after the security fix.
- Focused final architecture/security suite: 166 passed, 0 failed.
- No new regression was accepted.

The final adversarial swarm separately reviewed correctness, security, maintainability, model/user UX, performance, graph ownership, dead code, and test adequacy. It found and closed two material evidence gaps:

1. Repository Smart HTTP had lost the shared private/special-host guard. The exact transport now refuses private, local, metadata, obfuscated-IP, mapped, and NAT64 targets before credential-bearing fetch; exhaustive classifier tests and a wiring assertion cover it.
2. The packaged controller-only growth proof omitted Store Firefox. All four Store/Preview × Chrome/Firefox cells are now covered.

No remaining release-blocking implementation finding survived review. The deleted service-worker monolith removed 8,712 lines, the core tool/cutover slice is net 3,007 lines smaller, all 97 tool-semantic modules are shared by the main controller and actor Worker, none enters the Chrome worker graph, and no executable module was found orphaned. The remaining explicit main/actor authority bridges are deliberate custody wiring; consolidating them would recreate the generic dispatcher/function-bag design this branch removes.

## Honest residuals

- The aggregate release assessment is not promotable from a developer machine because runner identity is a release-safety requirement. The pinned `ubuntu-24.04` CI lane in `.github/workflows/package-and-release.yml` must pass on the delivery tip.
- Firefox intentionally omits capabilities requiring Chrome's offscreen host. Model-visible exposure and compatibility guidance account for those omissions.
- Searchable PDFs work; scanned-PDF OCR remains unavailable until the production OCR assets have integrity metadata.
- Chrome cannot extend DNR protection to page-service-worker WebSockets, and blocked navigation may still permit a limited TCP preconnect. These are documented platform limits, not branch regressions.
- Deterministic model-wire fixtures prove schemas, sequencing, receipts, failure states, and UI behavior; they do not substitute for optional real-model quality smoke testing.
- Lexical network checks do not solve DNS rebinding, audit integrity assumes a trusted extension origin, and site-client GET requests can be effectful. These pre-existing threat-model limits remain explicit.

## Landing and future work

Run the required PR/release CI on the pushed delivery tip. If it is green, land this branch without reopening the architecture. A later feature should stay controller-only whenever existing exact authority suffices. A new privileged capability must introduce its own named, bounded, run-scoped authority operation with sender, lifetime, replay, confirmation, audit, and custody tests.

Useful final checks:

```sh
bun run preflight
bun run package:all --no-sign
bun run test:e2e:all
bun run test:firefox
bun run test:firefox:controller
bun run test:firefox:cutover
git status --short
git rev-parse HEAD
git rev-parse fork/architecture/execution-protocol
```
