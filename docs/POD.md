# Peerd Pod

Peerd Pod is the shell-oriented environment between Notebook and WebVM. It is
assembled from peerd's existing execution primitives; it is not a browser Linux
distribution or a second sandbox stack.

```text
Script → Notebook → Pod → WebVM
```

The line describes which environment to choose, not a strict power ordering:

- Script: one fresh headless sealed Worker for quick Web-standard JavaScript.
- Notebook: a durable JavaScript workspace and editor.
- Pod: a fast shell, files, Git, WASI commands, and independent jobs.
- WebVM: a Linux guest for Node/npm, native binaries, POSIX, and system tools.
- App: a local software artifact/runtime rather than a compute tier.

## Architecture

One Pod is a registry record and a named OPFS workspace hosted by a visible tab.
Each shell command runs in a fresh dedicated Worker. The Worker applies the
production Notebook realm seal before loading the shell or WASI runtime, then
receives only Pod-rooted file RPC, brokered Git, and brokered HTTPS capabilities
from its host. A Chromium `js` command runs user code in a second disposable,
sealed module Worker so local ESM can use the existing Notebook resolver without
giving the shell Worker a dynamic-code primitive.

WASI Preview 1 syscalls are synchronous while portable OPFS is asynchronous.
Pod therefore takes a bounded byte snapshot of the workspace, runs the existing
in-memory `peerd:wasi` implementation, and reconciles only changed/deleted files
after exit. The host serializes that snapshot/reconcile transaction against
other Pod file and Git operations. WASM sees descriptors and bytes, never an
OPFS handle or a network import.

The shell is deliberately small. It supports quoting, variables, `;`, `&&`,
`||`, pipelines, stdin/stdout/stderr redirection, background jobs, exit codes,
and the built-ins listed by `help`. It is not a POSIX parser and has no PTY.

## Security boundary

- The command Worker has no ambient `fetch`, `XMLHttpRequest`, WebSocket,
  WebTransport, EventSource, nested Worker, Cache API, IndexedDB, raw OPFS, or
  `chrome`/`browser` extension namespace.
- `curl` and `pod.fetch` use the named postMessage bridge to `webFetch`, retaining
  peerd's scheme, private-network/SSRF, denylist, redirect, size, and audit rules.
- WASI has no network imports. A module cannot open sockets or call the bridge.
- The host page independently ships `connect-src 'none'` as a CSP backstop.
- OPFS operations are rooted at `peerd-pods/<podId>` and reject traversal.
- Actor tools are positively allow-listed for `actorType: 'pod'`; the service
  worker overwrites the target with the actor's bound Pod id.
- Git remote commands require a one-job grant. Agent-issued clone/fetch/push or
  remote changes are confirmed before the trusted Git host accepts them.
- No Pod job receives vault secrets. The Git service may attach an existing
  origin credential only at its trusted transport boundary.

Code running in the trusted Pod tab is extension code. User/agent code runs only
in the sealed job Worker or WASM linear memory; the editor never evaluates file
contents.

## Lifecycle and persistence

- `create`: creates the catalog record; persistent is the default.
- `ready`: a host tab has mounted the rooted workspace and accepts commands.
- `running`: at least one command Worker is live.
- `stopped`: a persistent record/workspace exists but its host tab is closed.
- `failed`: a command failed, timed out, or was cancelled; its job record keeps
  stdout, stderr, exit code, and timestamps while the host remains alive.
- `destroyed`: the catalog, repository metadata, and OPFS subtree are removed.

A persistent Pod reopens after tab or Worker loss with its files and Git history.
Its live jobs, cwd, and environment do not survive because those are process
state. An ephemeral Pod is destroyed when its tab closes. Peerd lifecycle
tracking classifies `pod_exec` as an ambiguous side-effecting operation and does
not replay it after host loss.

## Commands

Run `help` for the live list. Representative flows:

```sh
pwd
mkdir -p src
echo 'hello pod' > src/message.txt
cat src/message.txt | grep pod

# Chromium; see the Firefox note below
js -e 'console.log(args.join("-"))' one two
wasi-demo
wasi tool.wasm input.txt
install-tool jq jq.wasm

git init
git add .
git commit -m 'first commit'
git log -n 5

curl https://example.com/data.json -o data.json
sleep 5 &
jobs
kill job-id
```

The actor flow is `sandbox_create({kind:'pod'})`, then
`message_actor({to:'pod:<id>', message:'…'})`. A Pod actor can use only the
instance-pinned `pod_*` and repository tools exposed by
`peerd-runtime/tools/exposure.js`.

## Compatibility and deliberate limits

| Workload | Pod support |
|---|---|
| JavaScript | Chromium: Web-standard JavaScript in a sealed module Worker with explicit `pod` helpers. Firefox: unavailable; Firefox MV3 forbids the required dynamic blob Worker from extension pages |
| Node APIs / npm | No. Use WebVM |
| WASI | Preview 1 command modules compiled for `wasm32-wasi` |
| Native Linux binaries | No. Recompile for WASI or use WebVM |
| Git | Browser-native init/status/add/commit/log/branch/checkout and brokered smart-HTTP clone/fetch/push |
| Shell tools | Built-ins or explicitly installed WASI command modules |
| Network | Audited HTTP(S) bridge only; no raw sockets or WebSockets |
| Processes | Independent command Workers with jobs/cancel/timeout; no fork/signals/PTY |

The shell, OPFS, WASI, Git, jobs, persistence, and controlled HTTP bridge are
tested in both Chromium and Firefox. Firefox's MV3 extension CSP permits only
packaged extension scripts for Worker entry points; it rejects the blob module
that contains arbitrary Pod JavaScript. Adding an `unsafe-eval` or opaque-frame
fallback would create a second execution boundary and was rejected for the base
implementation. This is a real compatibility limitation, not a feature flag.

## Performance evidence

These measurements come from real packaged/unpacked extension tabs on the test
machine, not pure-function benchmarks. Values are individual smoke-run samples,
so they establish scale rather than a statistical performance envelope.

| Operation | Chromium | Firefox 153 |
|---|---:|---:|
| Worker/editor cold boot | 24–35 ms | 11–22 ms |
| Create request to ready | 268–294 ms | not sampled by the Firefox page harness |
| Warm `pwd` / simple shell | 1 ms | 11–14 ms for a file/pipeline workflow |
| `wasi-demo` | 4–5 ms | 2–6 ms |
| Persistent reopen | 9–10 ms | 5–25 ms |
| Idle Pod renderer JS heap | 15.4–20.0 MiB | not exposed by the Firefox harness |

## Dependencies and licenses

Pod adds no runtime dependency and vendors no new third-party bytes. It composes:

- `browser_wasi_shim` 0.4.2, MIT OR Apache-2.0, for WASI Preview 1 syscalls.
- `isomorphic-git` 1.38.6, MIT, plus its already-vendored browser Buffer
  transitive code (`buffer` and `base64-js`, MIT; `ieee754`, BSD-3-Clause).
- peerd's own shell parser/userland, OPFS adapter, sealed Worker, egress, actor,
  and lifecycle code, all covered by peerd's Apache-2.0 license.

## Optional language-runtime path

Python is intentionally not part of the base Pod. Pyodide is the credible first
follow-up: it already runs CPython in a module Worker, supports pure-Python wheels
through `micropip`, and ships many precompiled scientific packages. Production
work would still need a vendored/lazy asset registry with integrity pins, an
explicit Pod-workspace sync adapter, package egress through the broker, cache and
quota policy, cancellation tests, and a Firefox design because Pyodide requires a
module Worker. Expect a large first download, materially slower cold start than
base Pod, and no support for arbitrary native CPython extensions. This is a
moderate standalone follow-up, not a trivial command alias.

Ruby is technically plausible through the official `ruby.wasm` CRuby WASI
builds, including a `wasm32-unknown-wasip1` target. It should be tested first as
an installed WASI tool. The current upstream runtime has no WASI networking or
threads, and gems with native extensions need WebAssembly-specific builds. That
makes Ruby useful for scripts and some pure-Ruby gem workflows, but a less
complete ecosystem story than Pyodide.

Node is not on a credible small path. A JavaScript engine is already present,
but Node compatibility is the filesystem/process/streams/module-resolution/
CommonJS/package-script/native-addon surface around it. Browser shims do not
turn that into Node, and npm parity would make peerd own a compatibility runtime.
Keep Node/npm in WebVM unless an embeddable, permissively licensed browser
runtime emerges. Bun is still less suitable: its Zig runtime embeds
JavaScriptCore and native OS/package-manager machinery and has no browser/WASI
distribution target. Porting it would be a runtime project, not a Pod feature.

## Reproducible demo

Run `bun run e2e:verify --only=pod-runtime` to create a real persistent Pod,
exercise shell/files/pipelines, JavaScript (Chromium), WASI, local Git, controlled
and denied egress, concurrent/cancelled jobs, job isolation, close/reopen
persistence, performance sampling, and screenshots. Run
`bun run test:firefox:pod` for the packaged Firefox smoke covering the same base
substrate and the explicit JavaScript compatibility policy.
