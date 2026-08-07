<p align="center">
  <br>
  <img src="docs/store/assets/peerd-wordmark.svg" alt="peerd" width="240" height="48">
  <br>
  <br>
</p>

[![CI](https://github.com/NotASithLord/peerd/actions/workflows/package-and-release.yml/badge.svg)](https://github.com/NotASithLord/peerd/actions/workflows/package-and-release.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Status: 0.x experimental](https://img.shields.io/badge/status-0.x%20experimental-orange.svg)](#install)
[![Manifest V3](https://img.shields.io/badge/Manifest%20V3-Chrome%20%26%20Firefox-informational.svg)](#install)
[![No build step](https://img.shields.io/badge/build-none%20(vanilla%20JS)-success.svg)](#getting-started)
<!-- types badge: STATIC while the repo is private (shields can't fetch raw.githubusercontent on a private repo → "resource not found"). At public launch, swap the line below for the auto-updating endpoint badge — the JSON is already generated + drift-gated:
[![types: ts-check coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/NotASithLord/peerd/main/badges/tscheck.json)](packaging/check-tscheck.ts) -->
[![types: 100% ts-check](https://img.shields.io/badge/types-100%25%20%2F%2F%20%40ts--check-brightgreen.svg)](packaging/check-tscheck.ts)
[![Security policy](https://img.shields.io/badge/security-policy-blue.svg)](SECURITY.md)

<br>

# The browser-native agent harness

**peerd runs general-purpose agents inside your own Chrome or Firefox — no
cloud browser or MCP connection required.**

It gives agents the environment the web already lives in: your tabs and
authenticated sessions, local compute, adaptive site clients, browser Apps,
memory, and the supported model provider you choose.

Browser-native is not only a capability choice. Browsers have spent decades
learning how to run powerful software while assuming the content it touches may
be hostile. peerd applies that shape to agents: environment-specific actors,
browser execution boundaries, brokered credentials, policy-gated tools,
explicit egress controls, and lifecycle-aware recovery.

**The browser is both the capability surface and the security boundary.**

[Get Peerd Extension](#install) · [peerd.ai](https://peerd.ai) ·
[Architecture](#a-mixture-of-actors-not-one-omnipotent-agent) ·
[Security](SECURITY.md)

<p align="center">




https://github.com/user-attachments/assets/d2e4c285-6952-4c95-bf5a-d06087de084d




</p>

> **0.x experimental beta.** Breaking changes are likely. peerd drives your
> browser, executes code, and handles secrets on your behalf; read the
> [security model](SECURITY.md) and use it accordingly. The code under
> `extension/peerd-*/` is the product specification.

## Why I built peerd

I think we're putting agents in the wrong place.

A lot of agent systems run somewhere else and reach back into your computer
through a cloud browser or a growing collection of external tool servers. But
your browser already contains the applications, sessions, identity, networking,
security model, and increasingly the compute an agent needs.

It also has decades of scar tissue from running powerful software against
hostile content.

peerd started from a simple question: **what if the browser wasn't another tool
for the agent, but the harness itself?**

That's still the project.

## Why the browser?

Agent harnesses are rediscovering a problem the web has spent roughly 30 years
learning to live with: how do you give software enormous capability while
assuming the content it interacts with may be hostile?

The web never answered that by trusting the content. Browsers assume origins may
be adversarial, arbitrary code will execute, vulnerabilities will happen, and
sensitive state still has to coexist with all of it. Their answer is layered:
separate execution contexts, origin boundaries, sandboxes, brokered privileges,
permission gates, Content Security Policy, and mediated access to the network
and local state.

**The web already solved the shape of this problem.** peerd builds on those
primitives instead of placing a monolithic agent beside the browser and giving
it remote control.

That choice does not trade capability away. The browser is where your
applications, identity, sessions, storage, UI, networking, WebAssembly, Workers,
WebGPU, and WebRTC already meet. It gives peerd a path toward both sides of the
equation: more capability and stronger isolation.

## What makes it different?

| Surface | peerd's approach |
|---|---|
| Runtime | Runs inside your real browser instead of outsourcing its primary execution environment to a cloud browser |
| Architecture | A privileged orchestrator delegates to environment-specific, capability-narrowed actors |
| Web | Page tools, a code-first interaction surface, and reusable origin-scoped site clients |
| Compute | Sealed JavaScript workers, persistent Notebooks, compiled WASI tools, browser Apps, and Chrome WebVMs |
| State | Local sessions, memory, workspaces, Apps, and browser-native Git history for Apps and Notebooks |
| Security | Untrusted reasoning is separated from privileged authority where the browser contract supports it; every tool call is checked again at the privileged boundary |
| Recovery | Ambiguous side effects remain unknown instead of being silently converted into retries |
| Providers | Bring a supported cloud provider or use supported local inference; a peerd-hosted model proxy is not required |
| A2A | Preview builds can communicate directly browser-to-browser over the peerd mesh |
| License | Apache 2.0 |

## A mixture of actors, not one omnipotent agent

A general-purpose harness needs broad capability. That does not mean every
reasoning context should inherit every capability.

```text
                           peerd
                  privileged orchestrator
                         plans work
                              │
                       delegates goals
                              │
       ┌──────────────────────┼──────────────────────┐
       │                      │                      │
       ▼                      ▼                      ▼
   web actor              VM actor           Notebook / App actor
   one live tab           one WebVM           one local workspace
   narrowed tools         narrowed tools      narrowed tools
       │                      │                      │
       └────────────── brokered requests ───────────┘
                              │
                              ▼
                    privileged policy layer
                  credentials · egress · gates
                       audit · lifecycle
```

The orchestrator plans and delegates. Bound actors operate one tab, VM,
Notebook, or App with only that environment's tools. Their model and tool calls
cross a service-worker boundary that reconstructs the actor's permitted context
and checks the request again. Credentials stay behind the broker; untrusted
results return through explicit fences.

On Chrome, non-orchestrator loops run in dedicated, keyless Worker heaps. The
current Firefox fallback is keyless but does **not** provide the same dedicated
heap boundary; that difference is tracked as a residual risk in the
[threat model](docs/security/THREAT-MODEL.md#8-known-residual-risks). The WebVM
also currently depends on Chromium's cross-origin-isolation support.

**Capability is composed. Authority is not ambient.**

## The browser is the runtime, not just the target

- **Web actors.** A dedicated actor can read and operate a live tab without
  attaching raw page tools to the orchestrator.
- **Adaptive site clients.** A web actor can derive an origin-scoped client from
  observed site traffic, ask the user before persisting it, then reuse that
  programmatic interface on later visits. Derived dossiers stay fenced and
  clients remain pinned to their origin.
- **Code-first browser work.** Where enabled, a web actor can use a sealed
  JavaScript REPL with a Playwright-shaped `page` surface. Each operation still
  maps onto the same gated page tools; code changes the vocabulary, not the
  authority.
- **Local compute.** The headless `script` worker handles quick computation;
  Notebooks add a visible, persistent OPFS workspace; compiled WASI programs run
  with no ambient network; WebVMs boot Linux in a browser tab on Chromium.
- **Browser Apps.** Agents can build multi-file local software, open it in an
  opaque-origin iframe, keep Git history, inspect diffs, restore versions, and
  optionally attach a remote.
- **Memory and continuity.** Sessions, approved memory, local workspaces, Apps,
  routines, and audit history persist in browser storage.
- **Delegation.** Bound actors and short-lived actors let the orchestrator split
  work across specialized contexts without giving every context the full tool
  surface.
- **Lifecycle-aware execution.** peerd records an operation before dispatch. If
  a worker disappears after a non-idempotent side effect may have landed, the
  outcome becomes `outcome_unknown`; peerd will not blindly replay it without
  evidence.
- **Model choice.** Model calls go from the extension to the supported provider
  you select. No peerd account, hosted browser, or hosted agent backend is
  required to run the Extension.
- **P2P A2A (Preview).** The preview channel adds signed identity, a WebRTC mesh,
  peer-distributed Apps, and direct agent-to-agent work between browsers. It is
  experimental and does not ship in Store packages.

## Assume the page wins the prompt injection

**Prompt injection is a containment problem, not a filtering problem.** peerd
does not depend on a model perfectly recognizing malicious instructions. It
assumes hostile content can influence reasoning and limits what that reasoning
can actually reach.

1. **Isolate untrusted reasoning.** Environment actors consume page, command,
   file, and peer content outside the orchestrator's normal context. Chrome adds
   a dedicated Worker heap per non-orchestrator loop.
2. **Keep secrets behind the broker.** Sandboxes and actor workers do not receive
   model keys. Provider credentials are injected only at the egress boundary.
3. **Re-check capability use.** Exposure rules, actor-kind pins, instance pins,
   Plan/Act policy, confirmations, denylist/SSRF checks, and audit still apply at
   dispatch.
4. **Recover truthfully.** A lost response after a possible side effect is not
   proof of failure and is not permission to do it again.

Security comes from architecture, not a system prompt asking the model to ignore
malicious instructions. It is not a claim that prompt injection, browser bugs, or
model mistakes are solved. Read the [formal threat model](docs/security/THREAT-MODEL.md),
[red-team results](docs/security/RED-TEAM-RESULTS.md), and
[security policy](SECURITY.md) for the exact guarantees and residual risks.

## Run it in the browser you already use

**Peerd Extension** adds the peerd runtime to your Chrome or Firefox
installation. It is available now from source and preview packages. Store links
will replace the current source/preview install path when approvals land.

## Install

**Developer preview:**
Load the source tree unpacked using the steps below. This is the current
source-of-truth install path for contributors and early testers.

**Store packages:**
Chrome Web Store / Firefox Add-ons listings will be linked here once they
are approved. Store packages omit the preview-only dweb module. The initial
Chrome Store artifact also omits the CDP automation path; it uses the
scripting/DOM-walk surface shared with Firefox.

**Dweb preview (research package):**
Use the artifacts attached to the current GitHub release when present; the
source install path below remains the fallback.

The preview package includes the decentralized web (dweb) layer:
peer-to-peer dwapps between peerd instances. It's intended for
contributors and early testers, since the dweb protocol is research-grade
and subject to change. Once the store listings are live, most users will want
one of those packages. The preview installs alongside a store package as a
separate extension ("peerd preview") with its own isolated storage; move state
between them explicitly via **Settings → Export & import**.

Preview package install paths (Firefox is the smoother of the two):

- **Firefox:** click `peerd-preview-firefox.xpi` on the release page.
  It's AMO-signed, installs like any extension, and auto-updates.
- **Chrome on macOS / Windows (recommended): load the release source unpacked.**
  Chrome hard-disables off-store CRX installs on these platforms
  ("may have been added without your knowledge", enable toggle locked),
  and field testing showed even an `ExtensionInstallAllowlist`
  policy visible in `chrome://policy` does NOT unlock it on an
  unmanaged machine (Chrome wants MDM-grade management). So don't
  fight it: download the release's source archive, unzip it, enable
  Developer mode at `chrome://extensions`, **Load unpacked**, and pick
  its `extension/` folder. Caveats: no auto-update (download the new
  release explicitly) and the extension ID is machine-specific. This is a
  Chrome platform restriction on all self-hosted extensions, not a peerd choice.
- **Chrome on Linux (or any policy-managed Chrome):** download
  `peerd-preview-chrome.crx`, enable Developer mode at
  `chrome://extensions`, and drag the file onto the page. Auto-update
  then follows the feed at `peerd.ai/updates/`.

**Extension identity:** verify the installed package in
`chrome://extensions` or `about:debugging`. Generated manifests, release
artifacts, and update feeds are authoritative; unpacked Chrome installs receive
a machine-specific ID.

## Getting started

peerd has **no extension build step**: load the `extension/` folder as it
exists on disk. You need Chrome/Chromium or Firefox and one configured model.
The live provider inventory is defined in
[`peerd-provider/registry.js`](extension/peerd-provider/registry.js); it includes
BYOK cloud providers and keyless local options. Provider secrets live in the
encrypted local vault and are injected only into requests to the configured
provider origin.

**1. Get the code**

```
git clone https://github.com/NotASithLord/peerd.git
cd peerd
```

**2. Load the extension in Chrome**

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (toggle, top-right).
3. Click **Load unpacked**.
4. Select the **`extension/`** folder inside the repo, *not* the repo
   root. (The folder with `manifest.json` in it.)

peerd now appears in your extensions list. Click the puzzle-piece icon
in the toolbar and **pin** peerd so its icon is always visible.

**3. Open peerd and set up the vault**

Click the peerd toolbar icon and the side panel opens. On first run you
create a local vault: unlock with **Touch ID / a passkey** (recommended)
or a recovery passphrase. Keys, chat history, approved memory, and the audit
log are stored locally. Model traffic goes to the provider you select; web
work reaches the origins the task requires through peerd's audited egress
paths; preview P2P traffic uses the peerd mesh.

**4. Configure a provider**

Open **Settings** (gear icon) → **Providers**. Configure any supported provider
you want to use, choose a default model for new chats, and switch models per
chat. Keyed providers are stored independently in the vault; supported local
providers do not require a peerd account or model proxy.

**5. Chat**

Back in the chat, type a message. peerd can delegate work to web actors, run
local code, build Apps, use persistent Notebooks, and on Chromium boot a
sandboxed in-browser Linux VM. Plan/Act mode, write confirmations, origin
rules, and egress policy control which side effects can proceed.

**Updating after a code change.** Hit the **reload icon** on the peerd
card in `chrome://extensions`. The side panel, offscreen document, and
any open VM/JS/App tabs reload with it.

**Firefox (temporary source install).** Generate a Firefox manifest with the
packaging script, then use `about:debugging#/runtime/this-firefox` → **Load
Temporary Add-on**. Firefox does not currently support the WebVM or Chrome's
dedicated offscreen Worker-heap isolation path; see the threat model before
assuming browser parity.

**Generated files.** `extension/manifest.json` and
`extension/shared/channel-config.js` are GENERATED (the checked-in copies
are the dev defaults: preview channel, dweb on). Don't hand-edit
them; change `manifests/*.json` or `packaging/default-settings.mjs` and run
`bun run gen:dev`. CI fails if they drift.

**Why the permissions?** peerd asks for broad host access (`<all_urls>`,
and `debugger` on the preview/dev channels) because driving arbitrary
tabs and reading the page the agent is acting on is the whole point. Each
permission, why it's needed, and what the store build strips is spelled
out in
[`docs/store/PERMISSION-JUSTIFICATIONS.md`](docs/store/PERMISSION-JUSTIFICATIONS.md),
and the trust boundaries (vault, egress, untrusted-content handling, current
data practices) in [`SECURITY.md`](SECURITY.md).

## Project conventions (the short version)

- Plain vanilla JS, ES2024+. No TypeScript, no JSX, no bundler, no `npm`
  inside `extension/`.
- ES modules only. Strict mode by default.
- Pure functions and reducers over classes. Classes only where lifecycle is
  real (vault, VM, ports).
- `safeFetch` / `webFetch` for all outbound HTTP; bare `fetch` is forbidden.
- Comments explain *why*, not *what*. The codebase is security-sensitive
  and is meant to be read carefully.

The full version of these conventions and the architectural rationale
lives in [`CLAUDE.md`](CLAUDE.md) (orientation) and in the module code under
`extension/peerd-*/`: the code is the spec (vault crypto, dispatcher
gates, prompt-injection defenses, and the MV3 keepalive trick all live
in the modules that own them).

## The five modules

The five-letter wordmark *is* the architecture: each colored letter is
one top-level module, each owning its public API through `index.js`:

| | Module | Role |
|---|---|---|
| **`p`** · cyan | [`peerd-provider`](extension/peerd-provider/) | Model adapters — the registry is the live inventory; adapters normalize streaming, tool use, context windows, cost, and retries |
| **`e`** · red | [`peerd-egress`](extension/peerd-egress/) | Security — the vault, the egress chokepoint, the denylist, the audit log |
| **`e`** · amber | [`peerd-engine`](extension/peerd-engine/) | Sandboxes — WebVMs, Notebooks, Apps, and the headless worker |
| **`r`** · green | [`peerd-runtime`](extension/peerd-runtime/) | The orchestrator — agent loop, tools, the `message_actor` delegation channel, actors, sessions, memory, skills, review, goal mode, voice |
| **`d`** · magenta | [`peerd-distributed`](extension/peerd-distributed/) | The dweb — the peer-to-peer network (preview channel only) |

The brand IS the architecture: cross-module imports go through each
module's `index.js`, never deep paths; nothing outside
`peerd-distributed/` imports it at all. Each module's `index.js` is its
public API and the dependency graph.

## Trust boundaries

peerd's safety is *who is allowed to do what*: boundaries enforced by the
browser platform and by the privileged broker. Two principles run through all
of it: **the reasoning that consumes raw environment content does not receive
provider credentials or ambient tools**, and **the model never gets the final
word on correctness: observed effects and durable lifecycle records decide
what happened.**

The orchestrator delegates; an actor does the work. Each tab, VM,
notebook, and app is owned by one actor that holds only that
environment's tools, runs without keys, and hands back a fenced summary.
So isolation between environments is structural, not a convention: even a
fully prompt-injected main agent cannot reach an environment it was not
asked to, because it never held the tool.

| Actor | Trusted with | Never |
|---|---|---|
| **The vault** (`peerd-egress/vault`) | API keys and secrets, unlocked by Touch ID / passkey / passphrase with an auto-lock policy | exposing plaintext secrets to actors or sandboxes; provider keys are injected at the brokered egress boundary |
| **The orchestrator** (`peerd-runtime/loop`) | the conversation, planning, delegating a goal to an actor via `message_actor` | holding any environment's tools, reading raw page bytes, or running untrusted code directly |
| **A bound actor** (`peerd-runtime/actor`) | driving one tab / VM / Notebook / App with an instance-pinned toolset; keyless and in its own Worker heap on Chrome | touching another instance, receiving provider keys, or returning anything except a fenced summary |
| **An ephemeral actor** (`peerd-runtime/actor`) | short-lived delegated reasoning with a narrowed grant; keyless and in its own Worker heap on Chrome | escalating past its grant or reaching another heap; every tool call is rebuilt and re-checked service-worker-side |
| **The egress chokepoint** (`safeFetch` / `webFetch`) | every outbound byte — provider allowlist + denylist + SSRF guard | being bypassed; a bare `fetch` is lint-forbidden |
| **The sandboxes** (WebVM · Notebook · App) | running code — V8 isolates + opaque-origin iframes | extension access; their HTTP routes back through egress |
| **Web content** | nothing by default | being trusted — all of it is fenced as untrusted input |

The AI proposes and drives; the browser platform (WebCrypto vault,
WebAuthn unlock, V8 isolates, SRI) and the live DOM decide what actually
happens. Full detail in [`SECURITY.md`](SECURITY.md) and the
`peerd-egress` / `peerd-runtime` code.

## Threat model and red-team suite

peerd's security model is documented and testable, not only asserted. The
formal **threat model**
([`docs/security/THREAT-MODEL.md`](docs/security/THREAT-MODEL.md)) defines the
actors, trust boundaries, assets, adversaries, numbered invariants, and known
residual risks. A **red-team suite** ([`tests/red-team/`](tests/red-team/))
turns those invariants into runnable probes: each drives a real defense function
with hostile input and records whether it held. It runs in CI and covers API-key
exfiltration, induced cross-origin fetches, summarizing secrets into model
context, SSRF, sandbox escape, hostile peer bundles, and A2A / tool-poisoning
analogs. The live pass/fail matrix is regenerated into
[`docs/security/RED-TEAM-RESULTS.md`](docs/security/RED-TEAM-RESULTS.md) by
`bun run red-team:report`.

Read this honestly: these are runnable security probes for peerd's core
invariants, not a complete adversarial audit. Most probes run at the unit level
against the real defense functions; the real Worker and iframe realm escapes are
verified in the in-browser suite. The threat model is explicit about what is out
of scope and about the residual risks that remain, including the current Firefox
fallback, memory poisoning, trusted skill bodies, open-web exfil paths, and broad
host permission. See [`tests/red-team/README.md`](tests/red-team/README.md) for
how to run and extend the suite.

## Documentation

The code is the spec. Read [`CLAUDE.md`](CLAUDE.md) for orientation, each module's
`index.js` for its public API, and the code itself for the rest.
`SECURITY.md` and [`docs/security/`](docs/security/) cover the trust boundaries,
the formal threat model, and the red-team results; `docs/store/` holds the
store-listing and compliance material.

## Repo layout

The five-letter wordmark *is* the architecture (the module code is the
detail). Each colored letter maps to a top-level module:

```
peerd/
├── extension/                # the extension itself — load this dir unpacked
│   ├── manifest.json
│   ├── peerd-provider/       # p · cyan    — model adapters; registry.js is the live inventory
│   ├── peerd-egress/         # e · red     — vault, allowlist, denylist, confirm, audit
│   ├── peerd-engine/         # e · amber   — execution-instance registries (WebVM, Notebook, App). Tab runtimes in engine-tabs/<kind>-tab/; the headless script worker in offscreen/.
│   ├── peerd-runtime/        # r · green   — agent loop, tools, actors, sessions, lifecycle, memory, skills, review, voice, DOM
│   ├── peerd-distributed/   # d · magenta — the dweb layer between peerd instances (ships ONLY in preview packages)
│   ├── background/           # chassis: service worker + per-kind tab trackers + clients
│   ├── offscreen/            # chassis: the actor/actor worker heaps, headless script runs, voice, SW keepalive
│   ├── sidepanel/            # chassis: chat UI (Mithril)
│   ├── engine-tabs/          # chassis: the three peerd-engine tab-host pages, grouped
│   │   ├── vm-tab/           #   WebVM tab page (CheerpX + bash + xterm)
│   │   ├── notebook-tab/     #   Notebook tab page (Web Worker + OPFS)
│   │   └── app-tab/          #   App tab page (stored HTML in sandboxed iframe)
│   ├── eval/                 # live end-to-end eval harness (runner.html)
│   ├── shared/               # base types and utilities (importable everywhere)
│   ├── tests/                # in-browser test runner — open runner.html
│   ├── vendor/               # third-party deps, committed as-is (CheerpX, xterm, mithril, Moonshine)
│   └── permissions/          # permission-grant pages (mic, etc.)
├── manifests/                # base manifest + per-channel patch documents
├── packaging/                # Bun packaging scripts: manifest gen, channel artifacts, signing, feeds
├── tests/                    # Bun test suite (bun test ./tests)
├── update-feeds/             # generated auto-update feeds served at peerd.ai/updates/ (copied to peerd-site to deploy)
├── docs/                     # store/ — store-listing + compliance material
├── signaling-node/           # dweb rendezvous server shells (share the pure signaling reducer)
└── scripts/                  # dev helpers (cdp/ headless harness, dev-server.sh, vendor-*)
```

peerd ships from this one tree in **two channels**: `peerd` (Chrome Web
Store / Firefox Add-ons, no dweb code in the artifact) and
`peerd preview` (GitHub Releases, dweb enabled, signed,
auto-updating). Same source, same version, same release; the channel
only decides whether the dweb module ships. The `packaging/` scripts
have the whole story.

Cross-module imports go through each module's `index.js`, never deep
paths. ESLint enforces. Within a module, deep imports are fine.

## Execution instances

`peerd-engine` hosts Sandboxes: four execution kinds (taxonomy in the
`peerd-engine/` code). Three are
discrete, persistent browser tabs the user can
see, focus, and close, grouped under "peerd" in the tab strip and
surviving browser restarts: the WebVM, the Notebook, and the App. The
fourth, the headless worker (`script`), runs the Notebook's sealed worker
offscreen with no tab: ephemeral, for the agent's own quick compute. The
orchestrator picks the lightest kind that fits the task, bootstraps the
instance, and then delegates the work to that instance's actor; the
tool lists below are the surface an actor drives, not the main agent. One
main-agent tool spans all of them: **`actor_list`** enumerates every
addressable actor (WebVMs, Notebooks, Apps, open tabs, and API integrations),
each tagged with its `type` and the handle to pass to `message_actor`.

**WebVM**: CheerpX-emulated Debian (sandboxed Linux). Own disk overlay, own
bash, own POSIX. Use it when you need real binaries, a shell, or multi-language
stacks. The current WebVM requires Chromium.

HTTP egress from the VM (curl / wget / git clone) is intercepted by
bash function wrappers that route every request through `peerd-egress`
before it leaves the browser.

**Notebook**: a sealed Web Worker with its own JS realm and an OPFS file
tree, in a visible tab. `peerd.egress.fetch` is the
worker's only network, routed through `peerd-egress` so it's honest. Each
`js_notebook` run spawns a fresh worker, so in-memory state (`globalThis`,
`let`/`const`) does NOT carry between runs; persist via
`peerd.self.writeFile`/`readFile` to the OPFS file tree. The sealed worker
also runs **compiled wasm32-wasi binaries** via the `peerd:wasi` builtin —
SQLite over a user's `.sqlite` file, codecs, language runtimes — against an
in-memory filesystem, with zero ambient capabilities (a wasm module has no
network path even in principle; it sees only the stdin/files the call
passes it).

**Headless worker** is the same sealed worker as a Notebook, but headless:
`script` runs it in the offscreen document with no tab, ephemeral scratch
discarded after. It's the agent's own quick compute and peerd's code mode
(one script instead of a chain of tool/MCP calls), not a workspace you
watch. A distinct kind from the Notebook, same substrate.

**App**: a multi-file local artifact the agent built for the user, rendered in
an opaque-origin sandboxed iframe with no extension access. Its workspace lives
in OPFS, participates in the browser-native repository service, and can be
versioned, diffed, restored, and connected to a Git remote. The App actor edits
that workspace; the iframe receives only the composed runtime document.

## Tests

Three surfaces, different jobs (see [`CLAUDE.md`](CLAUDE.md)):

**In-browser**: things that need a real browser (DOM, `chrome.*`, IDB,
side-panel components, the SW). Open
`chrome-extension://<ext-id>/tests/runner.html` in a tab and refresh to
re-run. Tiny custom framework covering the vault, the tool dispatcher,
introspection tools, provider streaming + tool_use, the
session store, agent loop, denylist matcher, egress, and more. The same
suite runs headless in CI via the CDP harness
(`scripts/cdp/run-inbrowser-tests.mjs`, headless Chrome over the
DevTools Protocol, no MCP).

**Bun**: pure logic that runs without a browser (registries, the module
resolver, the Markdown renderer, the OpenAI/OpenRouter format layer).
Fast and runnable from the terminal:

```
bun install        # once — pulls the dev-only test deps (e.g. fake-indexeddb)
bun test ./tests
```

(Bun is only needed for these terminal tests and for re-vendoring
third-party deps; running the extension itself needs no toolchain at
all.)

**Live E2E**: `bun run e2e:verify` loads the unpacked extension into the
pinned Chrome for Testing and exercises service-worker, vault, provider, actor,
and side-panel flows end to end. UI work is not complete until the structured
result and captured screenshots have both been inspected.

**Types: JSDoc + `// @ts-check`, mandatory for browser files.** The
extension is no-build vanilla JS, so types come from JSDoc checked by a
`// @ts-check` directive, not a `.ts` toolchain. `bun run typecheck`
(strict `tsc`) checks every annotated file; `bun run check:tscheck` is a
CI gate on coverage. **Every browser file (`extension/**/*.js`) now
carries `// @ts-check` (100%), and it is required on new ones:** add the
directive and make the file type-clean (`bun run typecheck`), or CI
fails. (The Bun tests under `tests/` are real TypeScript, since Bun runs
`.ts` directly; only code the browser loads is JSDoc-on-JS.)

## Open-source components

peerd stands on a lot of excellent open-source work. The MV3 CSP
forbids remote script execution (`script-src 'self' 'wasm-unsafe-eval'`),
so every third-party runtime dependency is **vendored**: committed
pre-built under `extension/vendor/`, pinned to a version, and SHA-verified
by a `scripts/vendor-*.sh` (or `.ts`) re-vendor step. Each directory
carries a `SOURCE.txt` recording the upstream, the pinned version, the
hash, and the update procedure. A fresh clone runs with **no build and no
network fetch** for code. You only touch the vendor scripts when *updating*
a dependency, and the regenerated bytes are checked in; peerd's own code is
plain ES modules loaded directly, never bundled.

Thank you to the maintainers of all of these projects.

### Vendored runtime dependencies

| Component | Version | License | Used for |
|---|---|---|---|
| [CheerpX](https://leaningtech.com/cheerpx/) ([docs](https://cheerpx.io/docs)) | 1.2.8 | Proprietary — license your responsibility¹ | x86 Linux in WebAssembly — the WebVM sandbox runtime (`peerd-engine`, `engine-tabs/vm-tab/`) |
| [xterm.js](https://xtermjs.org/) (`@xterm/xterm` + `@xterm/addon-fit`) | 5.5.0 / 0.10.0 | MIT | In-browser terminal emulator rendering the WebVM's PTY (`engine-tabs/vm-tab/`) |
| [Mithril.js](https://mithril.js.org/) | 2.3.8 | MIT | UI framework for the side panel and Apps |
| [CodeMirror 6](https://codemirror.net/) (`@codemirror/*`) | 6.x | MIT | Code editor in the App tab (`peerd-engine/editor.js`) |
| [Moonshine](https://github.com/moonshine-ai/moonshine) (`@moonshine-ai/moonshine-js`) | 0.1.29 | MIT | Local, in-browser speech-to-text for voice input (`peerd-runtime/voice/`) |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (`onnxruntime-web`) | 1.22.0 | MIT | WASM/WebGPU inference backend Moonshine runs on (`vendor/onnxruntime-web/`) |
| [Silero VAD](https://github.com/snakers4/silero-vad) (`@ricky0123/vad-web`) | 0.0.24 | MIT | Voice-activity detection / speech endpointing for Moonshine (`vendor/vad-web/`) |
| [hash-wasm](https://github.com/Daninet/hash-wasm) (Argon2 bundle) | 4.12.0 | MIT | Argon2id KDF deriving the vault's key-encryption key (`peerd-egress/vault/`) |
| [browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim) (`@bjorn3/browser_wasi_shim`) | 0.4.2 | MIT OR Apache-2.0 | WASI preview1 syscall layer behind the `peerd:wasi` builtin — runs wasm32-wasi binaries in the sealed worker (`engine-tabs/notebook-tab/notebook-wasi.js`) |
| [webextension-polyfill](https://github.com/mozilla/webextension-polyfill) | 0.12.0 | MPL-2.0 | One promise-based `browser.*` API across Chrome and Firefox |
| [Transformers.js](https://github.com/huggingface/transformers.js) (`@huggingface/transformers`) | 4.2.0 | Apache-2.0 | WebGPU runtime for the on-device local-inference runner (`offscreen/local-model.js`)² |

¹ **CheerpX is proprietary, closed-source software** — the one vendored
dependency here that is *not* under an open-source license, and the only
one with a paid tier. Per Leaning Technologies'
[EULA](https://github.com/leaningtech/cheerpx-meta/blob/main/LICENSE.txt)
and [licensing terms](https://cheerpx.io/docs/licensing), the free
*Community* tier covers **individuals and one-person companies for any
purpose** (including revenue-generating, public-facing products);
**organizations of more than one person** may use it for free only for
evaluation and testing — production use requires a paid **Commercial
License** (contact-sales; no public price list). Separately, **bundling
and redistributing the CheerpX runtime — which peerd does by vendoring it
into `extension/vendor/cheerpx/` — and self-hosting it off Leaning's CDN
is gated**: their terms state that downloading a CheerpX build to host it
elsewhere is not permitted without a commercial license. **peerd ships
the runtime as a convenience and makes no licensing grant. If you run,
fork, distribute, or build a commercial offering on peerd, obtaining
whatever CheerpX license your use requires is your responsibility, not
peerd's** — contact Leaning Technologies before any commercial launch.
² Local in-browser WebGPU inference is **early but proven**: one model
(Gemma-4-E2B) ships behind an opt-in download, WebGPU-only; broader model
support is staged. The runner lives in `offscreen/local-model.js`.

### Models and data fetched at runtime

These are **data, not script**, so they're fetched lazily on first use
and cached locally (IndexedDB / OPFS) rather than shipped in-package, but
they're open assets worth crediting:

- **CheerpX Debian image**: CheerpX's stock Debian `ext2` disk,
  streamed lazily over WebSocket from `disks.webvm.io` (the only relaxed
  `connect-src` origin). The disk *content* is unmodified Debian under
  Debian's own (free) licensing, a separate concern from the proprietary
  CheerpX runtime that streams it (note ¹ above).
- **Moonshine STT models**: [`UsefulSensors/moonshine`](https://huggingface.co/UsefulSensors/moonshine)
  ONNX weights (the `base` variant, ~250 MB), SRI-pinned to specific
  Hugging Face commits (`peerd-runtime/voice/model-store.js`).
- **Silero VAD model**: `silero_vad` ONNX weights, served same-origin
  from the vendored `vad-web` package.
- **Gemma on-device model**: [`onnx-community/gemma-4-E2B-it-ONNX`](https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX)
  weights (~1.3 GB), the model behind the early on-device WebGPU runner.
  It's Google's **Gemma** converted to ONNX by the onnx-community /
  **Xenova** ([Transformers.js](https://github.com/huggingface/transformers.js))
  ecosystem, downloaded opt-in and run in the offscreen doc
  (`offscreen/local-model.js`). The Gemma weights are under Google's
  [Gemma Terms of Use](https://ai.google.dev/gemma/terms), a custom
  license with use restrictions (**not** a standard OSI-approved one), so
  they're a credited runtime download, never bundled.

The brand mark on monochrome, the spinner cadence, and the rest of peerd's
own design are first-party. Everything above is third-party and credited to
its upstream.

## License

Apache 2.0. See [`LICENSE`](LICENSE).

## Warranty

peerd is provided **"as is", without warranty of any kind**, express or
implied — including, without limitation, the implied warranties of
merchantability, fitness for a particular purpose, title, and
non-infringement. The entire risk as to the quality and performance of
the software is with you.

In no event shall the authors or copyright holders be liable for any
claim, damages, or other liability — whether in contract, tort, or
otherwise — arising from, out of, or in connection with the software or
its use.

This is early, actively-developed software that drives your browser,
executes code, and handles your API keys and other secrets on your
behalf. **Use it at your own risk.** The controlling terms are the
Disclaimer of Warranty and Limitation of Liability in
[`LICENSE`](LICENSE) (Apache 2.0, sections 7 and 8).
