<p align="center">
  <img src="docs/store/assets/peerd-wordmark.svg" alt="peerd" width="240" height="48">
</p>

[![CI](https://github.com/NotASithLord/peerd/actions/workflows/package-and-release.yml/badge.svg)](https://github.com/NotASithLord/peerd/actions/workflows/package-and-release.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Status: 0.x experimental](https://img.shields.io/badge/status-0.x%20experimental-orange.svg)](#install)
[![Manifest V3](https://img.shields.io/badge/Manifest%20V3-Chrome%20%26%20Firefox-informational.svg)](#install)
[![No build step](https://img.shields.io/badge/build-none%20(vanilla%20JS)-success.svg)](#getting-started)
<!-- types badge: STATIC while the repo is private (shields can't fetch raw.githubusercontent on a private repo → "resource not found"). At public launch, swap the line below for the auto-updating endpoint badge — the JSON is already generated + drift-gated:
[![types: ts-check coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/NotASithLord/peerd/main/badges/tscheck.json)](packaging/check-tscheck.ts) -->
[![types: 100% ts-check](https://img.shields.io/badge/types-100%25%20%2F%2F%20%40ts--check-brightgreen.svg)](packaging/check-tscheck.ts)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CLAUDE.md)
[![Security policy](https://img.shields.io/badge/security-policy-blue.svg)](SECURITY.md)

**peerd is the first AI agent harness native to the browser.** It's a
Chrome/Firefox extension that runs a full agent loop *inside* the
browser you already use, with your existing tabs and sessions.
It reads and drives your pages, spins up sandboxed compute (JS
Notebooks, full Linux VMs compiled to WebAssembly, personal client-side
apps), and (on the preview channel) shares what it builds over a
peer-to-peer WebRTC network built for agent-to-agent communication. BYOK
to the model provider of your choice. **No backend, no telemetry, no
cloud component in the data path.**

<p align="center">




https://github.com/user-attachments/assets/d2e4c285-6952-4c95-bf5a-d06087de084d




</p>

peerd uses *the browser* as its runtime and its security model. It builds
on decades of hardened browser platform work (V8 isolates for sandboxing,
WebCrypto for the vault, WebAuthn passkeys to unlock it, opaque-origin
iframes, Subresource Integrity) and writes none of its own cryptographic
or process-isolation code. The agent that holds your keys never operates
an environment itself: each browser tab, VM, notebook, and app is driven
by its own keyless actor sub-agent that exclusively holds that
environment's tools. The main agent acts as an orchestrator. It delegates
a goal to an actor and gets back a summary fenced as untrusted, so raw
page text and command output never reach the context that holds your
keys, and a confused or prompt-injected main agent has no tool to touch
an environment with in the first place. Every action an actor drives is
verified against the live page before it counts as done. (More at
[peerd.ai](https://peerd.ai).)

**Status: 0.x, experimental beta.** The initial feature buildout is
complete and integrated, but the surface is still moving: **breaking
changes are likely**, storage formats may shift, and it drives your
browser and holds your API keys, so use it with care. There is no "V1"
commitment; versions stay in the 0.x range until the surface stabilizes.

## Install

**Developer preview:**
Load the source tree unpacked using the steps below. This is the current
source-of-truth install path for contributors and early testers.

**Store packages:**
Chrome Web Store / Firefox Add-ons listings will be linked here once they
are approved. Store packages omit preview-only dweb pieces and the
preview/dev advanced automation path.

**Dweb preview (research package):**
GitHub Releases may include signed preview artifacts. If there is no
release attached yet, use the source install path below.

The preview package includes the decentralized web (dweb) layer:
peer-to-peer dwapps between peerd instances. It's intended for
contributors and early testers, since the dweb protocol is research-grade
and subject to change. Most users want one of the two store packages
above. The preview installs alongside the store package as a separate
extension ("peerd preview") with its own isolated storage; move state
between them explicitly via **Settings → Export & import**.

Preview package install paths (Firefox is the smoother of the two):

- **Firefox:** click `peerd-preview-firefox.xpi` on the release page.
  It's AMO-signed, installs like any extension, and auto-updates.
- **Chrome on macOS / Windows (recommended): load the zip unpacked.**
  Chrome hard-disables off-store CRX installs on these platforms
  ("may have been added without your knowledge", enable toggle locked),
  and field testing showed even an `ExtensionInstallAllowlist`
  policy visible in `chrome://policy` does NOT unlock it on an
  unmanaged machine (Chrome wants MDM-grade management). So don't
  fight it: download `peerd-preview-chrome.zip`, unzip it, enable
  Developer mode at `chrome://extensions`, **Load unpacked**, and pick
  the unzipped folder. Caveats: no auto-update (download the new zip
  per release) and the extension ID is machine-specific, not the
  table's CRX ID. This is a Chrome platform restriction on all
  self-hosted extensions, not a peerd choice.
- **Chrome on Linux (or any policy-managed Chrome):** download
  `peerd-preview-chrome.crx`, enable Developer mode at
  `chrome://extensions`, and drag the file onto the page. Auto-update
  then follows the feed at `peerd.ai/updates/`.

**Extension IDs** (verify which package you're running):

| package | id |
|---|---|
| peerd (Chrome store) | verify from the store listing or `chrome://extensions` after install |
| peerd (Firefox store) | `peerd@peerd.ai` |
| peerd preview (Chrome) | `lpdkhfeldihoejbbfonnbekpjclkknoc` *(CRX installs only — an unpacked load gets a machine-specific ID)* |
| peerd preview (Firefox) | `peerd-preview@peerd.ai` |

## Getting started

peerd has **no build step**: you load the `extension/` folder straight
into Chrome as it is on disk. You need a Chromium-based browser (Chrome,
Edge, Brave, Arc, …) and a model to talk to: a key from
[Anthropic](https://console.anthropic.com/) and/or
[OpenRouter](https://openrouter.ai/keys), or a local
[Ollama](https://ollama.com/) (keyless, no bill, nothing leaves your
machine). BYOK: any key lives encrypted in a local vault and is only
ever sent to that provider.

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
or a recovery passphrase. Keys, chat history, and the audit log are all
encrypted on this device; nothing leaves your machine except the calls
to your model provider.

**4. Add your API key(s)**

Open **Settings** (gear icon) → **API keys**. Paste a key for
**Anthropic** (`sk-ant-…`) and/or **OpenRouter** (`sk-or-…`). You can set
both at once, each stored independently. Choose a default under
*Default model for new chats*, and switch the model per chat from the
picker above the message box.

**5. Chat**

Back in the chat, type a message. peerd can read and drive your open
tabs, run shell commands in a sandboxed in-browser Linux VM, build small
apps, search the web, and more. Turn on **Confirm before actions** in
Settings if you want to approve each tab/automation step first (off by
default).

**Updating after a code change.** Hit the **reload icon** on the peerd
card in `chrome://extensions`. The side panel, offscreen document, and
any open VM/JS/App tabs reload with it.

**Firefox (temporary).** `about:debugging#/runtime/this-firefox` →
**Load Temporary Add-on** → pick `extension/manifest.json`. Re-load on
each edit. Firefox parity is still being polished; Chrome is the
primary target for now.

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
and the trust boundaries (BYOK vault, egress allowlist,
untrusted-content handling, no telemetry) in [`SECURITY.md`](SECURITY.md).

## Project conventions (the short version)

- Plain vanilla JS, ES2024+. No TypeScript, no JSX, no bundler, no `npm`
  inside `extension/`.
- ES modules only. Strict mode by default.
- Pure functions and reducers over classes. Classes only where lifecycle is
  real (vault, VM, ports).
- `safeFetch` / `webFetch` for all outbound HTTP; bare `fetch` is forbidden.
- Comments explain *why*, not *what*. The codebase is security-sensitive
  and is meant to be read carefully.

The full version of these conventions lives in `CLAUDE.md`. The
architectural rationale lives in the code itself: every choice carries a
`// why:` comment next to what it explains, so it can't drift from the
thing it describes. The code is the spec.

## The five modules

The five-letter wordmark *is* the architecture: each colored letter is
one top-level module. Each module's `index.js` is its public API; read it
for how the module works.

| | Module | Role |
|---|---|---|
| **`p`** · cyan | [`peerd-provider`](extension/peerd-provider/) | Model adapters — Anthropic, OpenRouter, Ollama (streaming, caching, cost, retries) |
| **`e`** · red | [`peerd-egress`](extension/peerd-egress/) | Security — the vault, the egress chokepoint, the denylist, the audit log |
| **`e`** · amber | [`peerd-engine`](extension/peerd-engine/) | Sandboxes — WebVMs, Notebooks, Apps, and the headless worker |
| **`r`** · green | [`peerd-runtime`](extension/peerd-runtime/) | The orchestrator — agent loop, tools, the `message_actor` delegation channel, actors, sessions, memory, skills, review, goal mode, voice |
| **`d`** · magenta | [`peerd-distributed`](extension/peerd-distributed/) | The dweb — the peer-to-peer network (preview channel only) |

The brand IS the architecture: cross-module imports go through each
module's `index.js`, never deep paths; nothing outside
`peerd-distributed/` imports it at all. The dependency runs one way: a
higher letter depends on a lower one, never sideways.

## Trust boundaries

peerd's safety is *who is allowed to do what*: small boundaries
enforced by the browser platform, not by peerd's own crypto. Two
principles run through all of it: **the agent that holds your keys never
touches a raw page or runs untrusted code** — the environment-operating
tools are not even attached to it, they belong to per-environment actor
sub-agents — and **the agent never gets the final word on correctness;
every action is verified against the live page before it counts as done.**

The orchestrator delegates; an actor does the work. Each tab, VM,
notebook, and app is owned by one actor that holds only that
environment's tools, runs without keys, and hands back a fenced summary.
So isolation between environments is structural, not a convention: even a
fully prompt-injected main agent cannot reach an environment it was not
asked to, because it never held the tool.

| Actor | Trusted with | Never |
|---|---|---|
| **The vault** (`peerd-egress/vault`) | your API keys + secrets, decrypted only after Touch ID / passkey / passphrase unlock; idle auto-lock | leaving the device — keys go only to the provider you chose |
| **The orchestrator** (`peerd-runtime/loop`) | the conversation, planning, delegating a goal to an actor via `message_actor` | holding any environment's tools, reading raw page bytes, or running untrusted code directly |
| **An actor** (`peerd-runtime/subagent`) | driving ONE tab / VM / notebook / app — it exclusively holds that environment's tools, keyless | touching another environment, holding keys, or returning anything to the orchestrator except a `wrapUntrusted`-fenced summary |
| **The disposable runner** (`peerd-runtime/runner`) | driving + reading a page keyless via do/get/check — the lineage a web actor and subagents use | holding keys or its own network; its output returns `wrapUntrusted`-fenced |
| **The egress chokepoint** (`safeFetch` / `webFetch`) | every outbound byte — provider allowlist + denylist + SSRF guard | being bypassed; a bare `fetch` is lint-forbidden |
| **The sandboxes** (WebVM · Notebook · App) | running code — V8 isolates + opaque-origin iframes | extension access; their HTTP routes back through egress |
| **Web content** | nothing by default | being trusted — all of it is fenced as untrusted input |

The AI proposes and drives; the browser platform (WebCrypto vault,
WebAuthn unlock, V8 isolates, SRI) and the live DOM decide what actually
happens. Full detail in [`SECURITY.md`](SECURITY.md).

## Documentation

Read `CLAUDE.md` for orientation. Beyond that, the code is the spec:
peerd carries no separate design or architecture docs because prose that
describes code drifts from it. The rationale lives in `// why:` comments
next to the code they explain. Start from a module's `index.js` and
follow the imports. (The Chrome Web Store submission docs live under
`docs/store/`.)

## Repo layout

The five-letter wordmark *is* the architecture. Each colored letter maps
to a top-level module:

```
peerd/
├── extension/                # the extension itself — load this dir unpacked
│   ├── manifest.json
│   ├── peerd-provider/       # p · cyan    — model adapters (Anthropic, OpenRouter, Ollama; OpenAI later)
│   ├── peerd-egress/         # e · red     — vault, allowlist, denylist, confirm, audit
│   ├── peerd-engine/         # e · amber   — execution-instance registries (WebVM, Notebook, App). Tab runtimes in <kind>-tab/; the headless js_run worker in offscreen/.
│   ├── peerd-runtime/        # r · green   — agent loop, tools + do/get/check runner, sessions, permissions, composer, skills, memory, review, goal mode, cost, transfer, subagent, voice, clock, dom, edit
│   ├── peerd-distributed/   # d · magenta — the dweb layer between peerd instances (ships ONLY in preview packages)
│   ├── background/           # chassis: service worker + per-kind tab trackers + clients
│   ├── offscreen/            # chassis: SW keepalive + voice host
│   ├── sidepanel/            # chassis: chat UI (Mithril)
│   ├── vm-tab/               # chassis: WebVM tab page (CheerpX + bash + xterm)
│   ├── notebook-tab/         # chassis: Notebook tab page (Web Worker + OPFS)
│   ├── app-tab/              # chassis: App tab page (stored HTML in sandboxed iframe)
│   ├── eval/                 # live end-to-end eval harness (runner.html)
│   ├── shared/               # base types and utilities (importable everywhere)
│   ├── tests/                # in-browser test runner — open runner.html
│   ├── vendor/               # third-party deps, committed as-is (CheerpX, xterm, mithril, Moonshine)
│   └── permissions/          # permission-grant pages (mic, etc.)
├── manifests/                # base manifest + per-channel patch documents
├── packaging/                # Bun packaging scripts: manifest gen, channel artifacts, signing, feeds
├── tests/                    # Bun test suite (bun test ./tests)
├── update-feeds/             # generated auto-update feeds served at peerd.ai/updates/ (copied to peerd-site to deploy)
├── docs/store/               # Chrome Web Store submission docs
├── signaling-node/           # dweb rendezvous server shells (share the pure signaling reducer)
└── scripts/                  # dev helpers (cdp/ headless harness, dev-server.sh, vendor-*)
```

peerd ships from this one tree in **two channels**: `peerd` (Chrome Web
Store / Firefox Add-ons, no dweb code in the artifact) and
`peerd preview` (GitHub Releases, dweb enabled, signed,
auto-updating). Same source, same version, same release; the channel
only decides whether the dweb module ships. The `packaging/` scripts have
the whole story.

Cross-module imports go through each module's `index.js`, never deep
paths. ESLint enforces. Within a module, deep imports are fine.

## Execution instances

`peerd-engine` hosts Sandboxes: four execution kinds. Three are discrete,
persistent browser tabs the user can
see, focus, and close, grouped under "peerd" in the tab strip and
surviving browser restarts: the WebVM, the Notebook, and the App. The
fourth, the headless worker (`js_run`), runs the Notebook's sealed worker
offscreen with no tab: ephemeral, for the agent's own quick compute. The
orchestrator picks the lightest kind that fits the task, bootstraps the
instance, and then delegates the work to that instance's actor; the
tool lists below are the surface an actor drives, not the main agent. One
main-agent tool spans all of them: **`actor_list`** enumerates every
addressable actor — WebVMs, Notebooks, Apps, open tabs, and API
integrations — each tagged with its `type` and the handle to pass to
`message_actor`, so discovery is one call instead of five.

**WebVM**: CheerpX-emulated Debian (sandboxed Linux). Own disk (IDB
overlay), own bash, own POSIX. ~10s first boot. Use it when you need
real binaries, a shell, or multi-language stacks.

```
vm_create   vm_boot   vm_import   vm_write_file   vm_delete
```

HTTP egress from the VM (curl / wget / git clone) is intercepted by
bash function wrappers that route every request through `peerd-egress`
before it leaves the browser.

**Notebook**: a sealed Web Worker with its own JS realm and an OPFS file
tree, in a visible tab. ~hundreds of ms boot. `peerd.egress.fetch` is the
worker's only network, routed through `peerd-egress` so it's honest. Each
`js_notebook` run spawns a fresh worker, so in-memory state (`globalThis`,
`let`/`const`) does NOT carry between runs; persist via
`peerd.self.writeFile`/`readFile` to the OPFS file tree.

```
js_create   js_notebook   js_run   js_write_file   js_read_file   js_delete
```

**Headless worker** is the same sealed worker as a Notebook, but headless:
`js_run` runs it in the offscreen document with no tab, ephemeral scratch
discarded after. It's the agent's own quick compute and peerd's code mode
(one script instead of a chain of tool/MCP calls), not a workspace you
watch. A distinct kind from the Notebook, same substrate.

**App**: a stored HTML document the agent built for the user, rendered
in a sandboxed iframe (own opaque origin, no extension access).
Metadata in `chrome.storage.local`; body in IndexedDB; substring
search across name, tags, and body. `app_update` auto-reloads the open
tab so iterations show live.

```
app_create   app_update   app_open   app_search   app_delete
```

## Tests

Two surfaces, different jobs (see `CLAUDE.md`):

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
| [CheerpX](https://leaningtech.com/cheerpx/) ([docs](https://cheerpx.io/docs)) | 1.2.8 | Proprietary — license your responsibility¹ | x86 Linux in WebAssembly — the WebVM sandbox runtime (`peerd-engine`, `vm-tab/`) |
| [xterm.js](https://xtermjs.org/) (`@xterm/xterm` + `@xterm/addon-fit`) | 5.5.0 / 0.10.0 | MIT | In-browser terminal emulator rendering the WebVM's PTY (`vm-tab/`) |
| [Mithril.js](https://mithril.js.org/) | 2.3.8 | MIT | UI framework for the side panel and Apps |
| [CodeMirror 6](https://codemirror.net/) (`@codemirror/*`) | 6.x | MIT | Code editor in the App tab (`peerd-engine/editor.js`) |
| [Moonshine](https://github.com/moonshine-ai/moonshine) (`@moonshine-ai/moonshine-js`) | 0.1.29 | MIT | Local, in-browser speech-to-text for voice input (`peerd-runtime/voice/`) |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (`onnxruntime-web`) | 1.22.0 | MIT | WASM/WebGPU inference backend Moonshine runs on (`vendor/onnxruntime-web/`) |
| [Silero VAD](https://github.com/snakers4/silero-vad) (`@ricky0123/vad-web`) | 0.0.24 | MIT | Voice-activity detection / speech endpointing for Moonshine (`vendor/vad-web/`) |
| [hash-wasm](https://github.com/Daninet/hash-wasm) (Argon2 bundle) | 4.12.0 | MIT | Argon2id KDF deriving the vault's key-encryption key (`peerd-egress/vault/`) |
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
support is staged.

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
