# Peerd Pod integration report

Peerd Pod is implemented as a first-class peerd execution environment on the
`feature/peerd-pod` branch. The integration confirms the architectural premise:
Pod is a moderate amount of shell/job/product glue around peerd's existing
sealed Worker, OPFS, WASI, Git, egress, actor, and lifecycle primitives. It is
not a browser Linux distribution and did not require a new runtime dependency.

The recommendation is **B: a moderate standalone environment worth owning**.
The base environment is useful, fast, and substantially smaller than WebVM.
Reaching Node/npm compatibility would change that answer by turning Pod into a
runtime-compatibility project, so Node remains explicitly out of scope.

## What was built

- Persistent and ephemeral Pod registry records with visible, recoverable host
  tabs and Pod-rooted OPFS workspaces.
- A lightweight shell with quoting, variables, conditionals, pipelines,
  redirection, exit codes, cwd/environment state, and practical file/text
  built-ins.
- Fresh sealed command Workers, a host-owned job table, concurrent/background
  jobs, cancellation, timeout, timestamps, output caps, and explicit outcomes.
- WASI Preview 1 commands over a bounded workspace snapshot/reconciliation
  adapter. The old isolated `runWasi()` path remains intact.
- Chromium Web-standard JavaScript through the existing Notebook module
  resolver and Worker-source builder, with Pod-scoped helpers and no Node claim.
- Practical Git commands mapped to the existing isomorphic-git repository
  service, including brokered remote operations.
- Explicit HTTP(S) through the existing audited `webFetch` path and no ambient
  Worker or WASI networking.
- First-class Pod actor binding and instance-pinned Pod tools.
- Minimal UI: the existing workspace editor/file tree plus a terminal panel.
- Chromium E2E and packaged Firefox smoke coverage, including persistence and
  security-negative assertions.

## Architecture and reuse

```text
orchestrator / Pod actor
          |
   instance-pinned Pod tools
          |
trusted Pod tab host ---- existing Git service ---- existing webFetch
     |          |
rooted OPFS   fresh sealed command Worker
                  |       |       |
                shell     JS     WASI P1
```

The Pod registry is a small use of the existing registry factory. Pod tab
tracking uses the shared engine tab tracker. The service-worker route uses the
same sender-to-owning-tab check as the other engine hosts. The editor is the
Notebook editor mounted against a Pod-rooted workspace. Git adds `pod` as a
repository kind rather than adding another Git implementation. The command
realm seal is the production Notebook seal with an explicit Pod capability
profile. Lifecycle classification marks execution as ambiguous and
non-replayable after host loss.

The only substantive lower-level extension is WASI workspace support. Portable
OPFS is asynchronous while WASI Preview 1 filesystem calls are synchronous, so
the trusted host supplies a bounded byte snapshot to the existing in-memory
WASI implementation and reconciles the result under the workspace mutation
queue. WASM receives only descriptors and bytes. Existing Notebook/Script
callers retain the prior fresh in-memory behavior.

## Code size and dependencies

The implementation adds no package dependency and vendors no new bytes. Its
runtime foundations were already present:

- `browser_wasi_shim` 0.4.2 — MIT OR Apache-2.0.
- `isomorphic-git` 1.38.6 — MIT.
- isomorphic-git's vendored browser Buffer dependencies: `buffer` and
  `base64-js` — MIT; `ieee754` — BSD-3-Clause.
- peerd-owned shell, OPFS, isolation, actor, and lifecycle code — Apache-2.0.

The final change is 97 files and 4,081 added/156 removed lines: 2,197 product
code lines, 1,132 browser/Bun/E2E/Firefox test and harness lines, 740
documentation lines, and 12 packaging/config lines. Of the product code, 1,571
lines are new focused Pod files; the rest are integration changes to existing
primitives. Vendored/dependency code added: **zero lines**. No code from the
standalone `/private/tmp/peerd-pod-poc` architecture was imported. The commit's
`git show --numstat` is the machine-readable authority for these counts.

## Security analysis

The security boundary is layered rather than dependent on shell parsing:

1. User/agent commands execute in a disposable dedicated Worker, not in the
   trusted extension host or service worker.
2. The production realm seal removes ambient `fetch`, XHR, WebSocket,
   WebTransport, EventSource, nested Worker, Cache API, IDB, OPFS, and extension
   namespaces. The Pod page also uses `connect-src 'none'`.
3. File RPC is rooted to `peerd-pods/<podId>` and rejects traversal. The service
   worker accepts it only from the tab owning that exact registry record.
4. WASI has no network import and receives an in-memory filesystem view, never
   an OPFS handle.
5. `curl`, Pod JavaScript's named `pod.fetch`, and Git smart HTTP cross trusted
   host bridges where peerd applies scheme, SSRF/private-network, denylist,
   redirect, output-size, credential, and audit policy.
6. Pod actor tools use a positive allow-list. Dispatch replaces any caller
   target with the actor's bound Pod id, so arguments cannot retarget another
   Pod or acquire browser/WebVM/vault authority.
7. Remote Git mutations require a per-job authorization; ambiguous
   side-effecting jobs are never automatically replayed after Worker/tab loss.

Browser tests prove absence of the blocked globals and extension APIs. Red-team
tests cover cross-Pod paths, remote imports, egress bypass attempts, vault/API
access, actor retargeting, and authority escalation. The trusted host page and
service worker remain trusted code, as they already are for Notebook.

## Filesystem and job semantics

Persistent Pod bytes and Git metadata survive command Worker loss, Pod tab
closure, service-worker restart, and reopen. Ephemeral Pod storage is removed
with its host. cwd, environment variables, live jobs, and buffered terminal
history are process state and do not survive reopening.

Each command gets an independent Worker. Compute jobs can overlap. Workspace
mutations, WASI snapshot/reconciliation, editor writes, and Git operations pass
through the shared workspace serialization boundary. Ordinary file writes use
last-writer-wins semantics; Git mutations retain the repository service's
serialization. A background job cannot overwrite the foreground shell's cwd or
environment. This is useful for agent workflows but is not POSIX process or
filesystem coherence: there is no fork, PTY, signal model, mmap, file locking,
or shared live descriptor table.

## Compatibility

| Capability | Result |
|---|---|
| Shell/files/pipelines | Chrome and Firefox |
| Persistence | Named OPFS workspace in both browsers |
| JavaScript | Chromium sealed module Worker; explicitly unavailable on Firefox |
| Node/npm | Not supported; WebVM territory |
| WASI | Preview 1 `wasm32-wasi` command modules |
| Native Linux | Not supported; recompile to WASI or use WebVM |
| Git | Local workflows plus policy/credential-gated smart HTTP |
| Build tools | WASI builds that fit Preview 1 and the snapshot bounds; no general native toolchain |
| Networking | Audited HTTP(S) bridge only; no raw sockets/WebSockets |
| Jobs | Independent Workers with cancel/timeout; no POSIX processes |

Firefox 153 rejects the dynamic blob module Worker that the existing
Notebook-derived arbitrary-JavaScript path needs in an MV3 extension page. Pod
therefore returns a clear unsupported result for `js` on Firefox while its
shell, OPFS, WASI, Git, jobs, egress, and persistence remain functional. An
opaque iframe or unsafe dynamic-evaluation fallback was rejected because it
would add a second, weaker execution boundary just for parity.

## Performance

Measured from real Pod extension tabs on the development machine:

| Operation | Chromium | Firefox 153 |
|---|---:|---:|
| Worker/editor cold boot | 24–35 ms | 11–22 ms |
| Create request to ready | 268–294 ms | not sampled by the Firefox page harness |
| Warm `pwd` / simple file-pipeline workflow | 1 ms | 11–14 ms |
| `wasi-demo` | 4–5 ms | 2–6 ms |
| Persistent reopen | 9–10 ms | 5–25 ms |
| Idle Pod renderer JS heap | 15.4–20.0 MiB | unavailable through the Firefox harness |

These are smoke samples, not a statistical benchmark. A full shared-browser E2E
run naturally reports noisier create/heap numbers after exercising the rest of
peerd. The focused measurements establish the intended order of magnitude: Pod
is meaningfully faster and lighter than booting a Linux WebVM.

## Verification snapshot

The completed branch passed:

- the full Bun suite (4,635 tests across 362 files);
- the full in-browser suite (731 tests);
- typecheck, ESLint, source hygiene, vendor, generated-file, and dweb-boundary
  gates;
- all four channel/browser package builds and packaged-page boot checks;
- the full Chromium E2E verify loop (42 states, 153 checks), including the Pod
  visual state;
- the packaged Firefox Pod smoke, including shell/pipeline/files, real WASI,
  controlled-network denial, concurrent jobs, cancellation, foreground-state
  isolation, and persistent reopen;
- Firefox package lint with no errors and the repository's unguarded-Chrome-API
  check.

The Chromium Pod state specifically covers shell files/pipelines, JavaScript,
WASI, local Git, allowed and denied egress, concurrent and cancelled jobs,
background job isolation, close/reopen persistence, and timing capture.

## Language-runtime path

### Python

[Pyodide](https://pyodide.org/en/stable/usage/webworker.html) is the best first
optional runtime. It already runs CPython in a Web Worker. It supports
pure-Python wheels and a curated set of compiled packages, with package loading
documented in its [package guide](https://pyodide.org/en/stable/usage/packages-in-pyodide.html).
The clean Peerd path is a separately scoped, lazy-loaded runtime pack with
integrity-pinned assets, a Pod workspace adapter, brokered package fetches,
quota/cache policy, cancellation, and browser-specific tests. It will have a
large cold download and cannot run arbitrary native CPython extensions. This is
a moderate follow-up, not something the base Pod should wait for.

### Ruby

The official [ruby.wasm](https://ruby.github.io/ruby.wasm/README_md.html)
project makes Ruby plausible as an installed WASI runtime, starting with its
`wasm32-unknown-wasip1` CRuby build. It is a good fit for scripts and some
pure-Ruby gems. Upstream's current lack of WASI networking and threads, plus
native-extension gem compatibility, makes it less complete than Pyodide. It
should begin as an experimental lazy tool pack, not a promise of general Bundler
or native-gem compatibility.

### Node and npm

There is no credible small integration path. Node compatibility is not merely
a JavaScript engine: it includes Node's filesystem/process/stream/module loader,
CommonJS, package lifecycle scripts, and native-addon expectations. The Node
project has explicitly closed browser/WASM compilation requests as not planned
([nodejs/help#3774](https://github.com/nodejs/help/issues/3774)). Owning that
compatibility surface would move Peerd Pod from category B to category C. Keep
Node and npm in WebVM unless a permissively licensed, embeddable browser runtime
with a sustainable upstream appears.

### Bun

[Bun](https://bun.sh/docs/runtime) is a native Zig/JavaScriptCore runtime with
OS and package-manager machinery, not a browser or WASI distribution. Porting
it would be a major runtime project and conflicts with Pod's purpose. It should
remain a lofty WebVM workload, not a base-Pod roadmap item.

### Bottom line on the “95%” hypothesis

Python plus Ruby would make Pod cover a much broader set of scripting and data
workflows, but Node/npm is the hard discontinuity. “Shell + WASI + Git + Python
+ Ruby” is a credible browser-native product. “Node/npm/Bun parity” is not a
credible extension of this architecture. For mixed modern web-development
workloads the execution choice should remain automatic and honest: use Pod for
fast local scripts/tools and hand Node/native work to WebVM.

## Remaining limitations

- Firefox arbitrary JavaScript is unavailable under the current secure
  architecture.
- The shell is intentionally non-POSIX and has no PTY, interactive programs,
  shell functions, globbing, command substitution, or signal semantics.
- WASI is Preview 1 and snapshot-backed; huge workspaces or tools needing
  sockets, threads, shared memory, or Linux syscalls do not fit.
- Jobs do not survive host loss, and side-effecting commands are not replayed.
- Git behavior is isomorphic-git compatibility, not native Git parity.
- Python and Ruby are evaluated follow-ups, not shipped commands.
- Node, npm, native Linux tools, and Bun remain WebVM workloads.

## Product assessment

The integration still looks worth owning. The useful substrate was already in
peerd; the feature mostly composes and hardens it. Its maintenance surface is a
small shell, job host, workspace-WASI adapter, and environment wiring. That is a
reasonable category-B commitment and gives Peerd a visibly faster middle tier.

The stop condition is equally clear: do not grow the shell toward Linux or the
JavaScript command toward Node. If product expectations require Node/npm parity
or arbitrary native packages inside Pod, use WebVM or revisit an optional
external backend rather than turning this feature into a category-C runtime.

## Reproduction and visual evidence

```sh
bun run e2e:verify --only=pod-runtime
bun run test:firefox:pod
```

The Chromium command creates a persistent Pod, exercises the full workflow,
closes and reopens it, records performance, and writes the before/reopen
screenshots under `scripts/cdp/artifacts/`. The live command inventory is
available through `help`; the end-user walkthrough is in `docs/POD.md`.

## Exact changed-file manifest

The feature commit changes the following files (the commit's
`git show --name-status` is the machine-readable authority):

- Project/docs: `CLAUDE.md`, `README.md`, `docs/POD.md`,
  `docs/POD-INTEGRATION-REPORT.md`, `docs/design/POD-IMPLEMENTATION-PLAN.md`,
  `docs/security/THREAT-MODEL.md`, `package.json`,
  `packaging/check-tscheck.ts`, `packaging/security-baseline.json`,
  `packaging/web-target.ts`, `packaging/templates/pod-client.web.js`.
- Background: `extension/background/pod-client.js`,
  `extension/background/pod-tab-tracker.js`,
  `extension/background/routes/engine.js`,
  `extension/background/service-worker.js`,
  `extension/background/tab-tracker.js`.
- Notebook/WASI shared substrate:
  `extension/engine-tabs/notebook-tab/notebook-neutralizers.js`,
  `extension/engine-tabs/notebook-tab/notebook-wasi.js`,
  `extension/engine-tabs/notebook-tab/worker-source.js`.
- Pod tab: `extension/engine-tabs/pod-tab/index.html`,
  `extension/engine-tabs/pod-tab/pod-job-worker.js`,
  `extension/engine-tabs/pod-tab/pod-realm-seal.js`,
  `extension/engine-tabs/pod-tab/pod-tab.js`,
  `extension/engine-tabs/pod-tab/styles.css`.
- Engine/storage/Git: `extension/peerd-egress/storage/idb.js`,
  `extension/peerd-engine/index.js`, `extension/peerd-engine/opfs.js`,
  `extension/peerd-engine/pod-registry.js`,
  `extension/peerd-engine/pod-shell.js`,
  `extension/peerd-engine/registry-factory.js`,
  `extension/peerd-engine/repository/paths.js`,
  `extension/peerd-engine/repository/repository-service.js`.
- Runtime integration: `extension/peerd-provider/system-prompt.txt`,
  `extension/peerd-runtime/actor/actor-messaging.js`,
  `extension/peerd-runtime/actor/spawn.js`,
  `extension/peerd-runtime/lifecycle/engine-liveness.js`,
  `extension/peerd-runtime/lifecycle/store-registry.js`,
  `extension/peerd-runtime/lifecycle/tool-retry-class.js`,
  `extension/peerd-runtime/loop/prewalk.js`,
  `extension/peerd-runtime/loop/system-prompt.js`,
  `extension/peerd-runtime/permissions/policy.js`,
  `extension/peerd-runtime/sessions/store.js`,
  `extension/peerd-runtime/sessions/types.js`,
  `extension/peerd-runtime/tools/defs/actor-list.js`,
  `extension/peerd-runtime/tools/defs/app-create.js`,
  `extension/peerd-runtime/tools/defs/app-history.js`,
  `extension/peerd-runtime/tools/defs/app-remote.js`,
  `extension/peerd-runtime/tools/defs/app-version.js`,
  `extension/peerd-runtime/tools/defs/index.js`,
  `extension/peerd-runtime/tools/defs/js-create.js`,
  `extension/peerd-runtime/tools/defs/message-actor.js`,
  `extension/peerd-runtime/tools/defs/pod-cancel.js`,
  `extension/peerd-runtime/tools/defs/pod-create.js`,
  `extension/peerd-runtime/tools/defs/pod-destroy.js`,
  `extension/peerd-runtime/tools/defs/pod-exec.js`,
  `extension/peerd-runtime/tools/defs/pod-read.js`,
  `extension/peerd-runtime/tools/defs/pod-status.js`,
  `extension/peerd-runtime/tools/defs/pod-write.js`,
  `extension/peerd-runtime/tools/defs/sandbox-create.js`,
  `extension/peerd-runtime/tools/defs/vm-create.js`,
  `extension/peerd-runtime/tools/exposure.js`.
- Shared/UI: `extension/shared/sender-trust.js`,
  `extension/shared/tool-types.js`,
  `extension/sidepanel/components/chat-view.js`,
  `extension/sidepanel/components/message-list.js`,
  `extension/sidepanel/styles.css`.
- Browser tests: `extension/tests/index.js`,
  `extension/tests/mocks/idb.js`,
  `extension/tests/unit/background/pod-client.test.js`,
  `extension/tests/unit/engine-tabs/notebook-tab/fixtures/pod-seal-probe-worker.js`,
  `extension/tests/unit/engine-tabs/notebook-tab/notebook-seal.test.js`,
  `extension/tests/unit/peerd-engine/pod-opfs.test.js`,
  `extension/tests/unit/peerd-engine/repository.test.js`,
  `extension/tests/unit/red-team/sandbox-escape.test.js`.
- Chromium/Firefox harness: `scripts/cdp/e2e-harness.mjs`,
  `scripts/cdp/run-e2e-verify.mjs`, `scripts/cdp/states.mjs`,
  `scripts/firefox/pod-smoke-page.js`, `scripts/firefox/run-pod-smoke.mjs`.
- Bun tests: `tests/background/routes-engine.test.ts`,
  `tests/engine-tabs/notebook-tab/notebook-neutralizers.test.ts`,
  `tests/engine-tabs/notebook-tab/notebook-wasi.test.ts`,
  `tests/engine-tabs/notebook-tab/wasi-test-module.ts`,
  `tests/engine-tabs/notebook-tab/worker-source.test.ts`,
  `tests/peerd-engine/pod-registry.test.ts`,
  `tests/peerd-engine/pod-shell.test.ts`,
  `tests/peerd-engine/registry-idb.test.ts`,
  `tests/peerd-engine/repository-paths.test.ts`,
  `tests/peerd-runtime/actors-api.test.ts`,
  `tests/peerd-runtime/exposure.test.ts`,
  `tests/peerd-runtime/lifecycle/tool-retry-class.test.ts`,
  `tests/peerd-runtime/prewalk.test.ts`,
  `tests/peerd-runtime/tools/actor-list.test.ts`,
  `tests/peerd-runtime/tools/pod-tools.test.ts`,
  `tests/peerd-runtime/tools/schema-diet.test.ts`,
  `tests/red-team/scenarios/06-sandbox-escape.ts`,
  `tests/shared/sender-trust.test.ts`.
