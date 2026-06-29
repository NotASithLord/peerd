# CLAUDE.md — peerd

> Persistent project context for Claude Code. Read this first on every
> session. This is the only orientation doc; the code is the spec.

---

## Code is the spec

peerd carries no design, architecture, or dev-notes docs. They were
removed because prose that describes code drifts from it. The rationale
lives where it can't go stale: inline `// why:` comments next to the code
they explain. So:

- To learn how something works, read the code and its comments. Start
  from the module's `index.js` (the public API) and follow the imports.
- When you change behavior, update the adjacent `// why:` comment in the
  same edit. A comment is part of the code, held to the same bar.
- Comments explain *why*, not *what*. Every architectural choice earns a
  `// why:` line. Code without rationale rots fast.
- `DESIGN-NN` / `DECISIONS #N` tags in comments are historical labels for
  a past decision. The reasoning is in the surrounding code, not a
  separate file. Treat the tag as a name for the decision, not a pointer.

This file holds the things that aren't local to one piece of code: the
shape of the system, the invariants that span modules, and the house
style. Keep it short. If a fact is dynamic (test counts, tool counts,
the model inventory, channel behavior, release artifacts), do not pin it
here; point at the code, generated file, or CI command that computes it.

---

## What peerd is

A browser-native AI agent harness, shipped as a Chrome/Firefox extension.
The agent runs entirely in the user's browser. It talks to a model API
directly (BYOK — bring your own key), drives the browser's tabs and DOM,
and can run shell commands in a sandboxed Linux VM compiled to
WebAssembly. No backend, no telemetry, no account.

peerd is **0.x — experimental beta** (breaking changes likely; versions
stay 0.x until the surface stabilizes). Stack: Manifest V3, Chrome and
Firefox (via `webextension-polyfill`), vanilla JS, **no build step**.

---

## The five modules

The brand **is** the architecture: five colored letters in the wordmark,
five modules, one dependency direction (higher depends on lower). If you
find yourself adding a sixth top-level `peerd-*` directory, stop and
reconsider.

```
p  cyan     peerd-provider/      model adapters (Anthropic · OpenRouter · Ollama; OpenAI later)
e  red      peerd-egress/        security: vault · safeFetch allowlist · denylist · audit
e  amber    peerd-engine/        execution sandboxes (WebVM · Notebook · App · headless worker)
r  green    peerd-runtime/       the orchestrator: agent loop · tools · sessions · the rest
d  magenta  peerd-distributed/   the dweb (P2P mesh · DHT · dwapps) — preview channel only
                                   └ nothing outside this dir imports it; the store build prunes it
```

The chassis lives outside the modules: `background/` (service worker —
message routing + DI + lifecycle), `offscreen/` (long-lived work with no
tab: voice, headless `js_run`, the dweb mesh), `sidepanel/` (the Mithril
chat UI), `home/` + `options/`, the per-execution-kind tab pages
(`vm-tab/` · `notebook-tab/` · `app-tab/`), `permissions/` (user-gesture
grant pages), `eval/` (the live end-to-end eval harness), `shared/`
(cross-cutting glue: the dweb stub, the generated `channel-config.js`),
`vendor/` (third-party code, each with a `SOURCE.txt`; no npm runtime),
and `tests/` (in-browser tests). There is no `content/` directory: DOM
work happens via injected functions, not a persistent content script.

Outside `extension/`: `signaling-node/` (the dweb rendezvous server,
sharing the pure signaling reducer), `manifests/` + `packaging/` (the
dual-distribution build, store vs preview; `bun run gen:dev` generates
`manifest.json` + `shared/channel-config.js`), `tests/` (Bun, pure
logic), `scripts/`, and `update-feeds/` (the auto-update feeds, copied to
the site repo `NotASithLord/peerd-site` to deploy).

### The tree, annotated

```
extension/peerd-provider/   [p]  adapters/ (Anthropic · OpenRouter · Ollama) · format/ (schema + streaming)
extension/peerd-egress/     [e]  vault/ (passphrase + WebAuthn-PRF; idle auto-lock) · fetch/ (safeFetch, the
                                 egress chokepoint: provider allowlist + SSRF guard) · denylist/ · confirm/
                                 (async policy-driven) · audit/ (append-only, capped) · storage/ (IDB/chrome.storage)
extension/peerd-engine/     [e]  registries for the isolates (a tab hosts one): vm · notebook · app ·
                                 module-resolver · opfs. The isolate is the sandbox; a tab is one way to host it.
extension/peerd-runtime/    [r]  loop/ (turns, streaming, dispatch; goal-runner.js runs unattended) ·
                                 tools/ (defs/ one file each · dispatcher.js lineage+hooks+audit · exposure.js
                                 registration-vs-exposure split · manifests.js capability presets · hooks/ ·
                                 web/) · runner/ + dom/ (do/get/check, the disposable browser-runner) ·
                                 sessions/ · subagent/ (depth-bounded recursion, tool narrowing) ·
                                 permissions/ (Plan/Act — decideAction) · memory/ · edit/ (SEARCH/REPLACE +
                                 checkpoints) · skills/ · review/ · composer/ · cost/ · clock/ · voice/ ·
                                 transfer/ · profiles/ (partly backlog)
extension/peerd-distributed/[d]  identity/ (Ed25519 did:key) · codec/ + content/ (signed content addressing +
                                 chunked transfer) · transport/ (WebRTC mesh) · dht/ + gossip/ · messaging/
                                 (signed direct channels) · apps/ (dwapps + the p2p app store). Preview only.
```

### When does it act on its own?

Almost everything is synchronous with an attended browser: a turn runs
because the user sent a message. The shipped exception is **Goal mode**
(`peerd-runtime/loop/goal-runner.js`): started attended via the Goal
toggle, then autonomous turns toward a goal, re-driven each service-worker
cold start, until the agent calls `complete_goal` (or Stop, or a cap).
The **actors** also drive their own turns: the orchestrator delegates a
goal to a per-tab/instance actor via `message_actor` and gets woken
with a fenced summary; the actor never blocks the orchestrator. The
rule for anything unattended: it can never widen its own permissions,
every byte it reads from the web is `wrapUntrusted`-fenced, and it routes
through the same egress policy as an attended turn.

---

## Non-negotiable conventions

- **Vanilla JS, ES modules, no build step.** No bundler, no transpiler.
  Code runs as the browser loaded it. The dev loop is *load unpacked →
  refresh*. (The store + preview ARTIFACTS are produced by `packaging/*.ts`
  via staging/pruning/zipping, not bundling.)
- **Generated files — don't hand-edit.** `extension/manifest.json` and
  `extension/shared/channel-config.js` are generated by `bun run gen:dev`
  from `manifests/*.json` and `packaging/default-settings.mjs`. CI fails on
  drift. Versions live in `package.json` only.
- **The dweb boundary.** Nothing outside `peerd-distributed/` imports it,
  not even its `index.js` (the store package prunes the module entirely).
  Core code uses the types + stub in `shared/dweb-interface.js` and
  `loadDweb()` from `shared/dweb-loader.js`. Channel behavior flows only
  through `CHANNEL_DEFAULTS` / `DWEB_ENABLED` from
  `/shared/channel-config.js`, never a runtime channel probe, and never
  exposed to the agent or skills. `bun run check:boundary` enforces it.
- **All JS runs under strict mode.** ES modules are strict by default, so
  no `'use strict'` in module files. Classic-script contexts get an
  explicit directive: currently `extension/tests/bootstrap.js`,
  `extension/permissions/mic.js`, and any function body injected via
  `chrome.scripting.executeScript` (serialized and re-evaluated in the
  target page's classic-script world). A new non-module entry point needs
  the directive.
- **No npm runtime inside the extension.** Third-party code lives in
  `vendor/` with a `SOURCE.txt`. Audit before vendoring.
- **Functional core, imperative shell.** Reducers are pure. Policy steps
  are pure functions. IO is *injected* as a parameter, never imported
  directly inside a module. This is the testability lever.
- **Mithril.js for UI.** Already vendored. Don't swap frameworks.
- **`index.js` is the public API per module.** ESLint
  `no-restricted-imports` forbids deep paths from outside the module.
  Inside the module, deep imports are fine.
- **Modern, functional JS — lint-enforced.** `eslint.config.js`'s
  "stylistic modernization" block is a gate (autofix with
  `eslint extension --fix`): `const`/`let` never `var`, arrow callbacks,
  template literals, object shorthand, spread, `Object.hasOwn`, array
  methods / `for…of` over C-style loops (a counting loop is fine for
  byte/codec work, reverse iteration, retry loops, early-exit). Name things
  in full. **Exception: the injected-into-page classic-script bodies**
  (`dom/walk-injected.js`, `dom/framework-state.js`,
  `background/debugger-pool.js`, `tools/defs/watch-changes.js`) are
  deliberately ES5 and exempted in the config; don't "modernize" them.

---

## Three test surfaces, different jobs

- **In-browser** at `extension/tests/runner.html` (tiny custom framework).
  Tests that need a browser: DOM, chrome.*, real IDB lifecycle, side panel
  components, SW behavior, the voice transcribers. They also run HEADLESS
  via the CDP harness (`scripts/cdp/run-inbrowser-tests.mjs`), which CI runs
  as its own job. Keep these as the extension grows; don't migrate to Bun.
- **Bun** at `tests/**/*.test.ts` (run with `bun test ./tests`). Pure logic
  exercisable without a browser: registries, the module resolver, other
  pure helpers. Fast, terminal-runnable. Typechecked STRICT
  (`bun run typecheck`, a CI + preflight gate) — Bun strips types without
  checking, so the gate makes the annotations real. `allowJs` pulls the
  extension's JSDoc typedefs into the check. The same `tsc` run checks the
  extension file-by-file via an opt-in ratchet: an extension `.js` file is
  type-checked once it carries `// @ts-check`. `bun run check:tscheck`
  enforces a coverage FLOOR so the checked set only grows.
  Rule of thumb: if a test would mock half the world, it wants the browser.
  If it operates on values in and values out, it wants Bun.
- **Live E2E + the verify loop** at `scripts/cdp/run-e2e-verify.mjs`
  (`bun run e2e:verify`). Loads the REAL unpacked extension in Chrome for
  Testing and drives the live side panel through every state in
  `scripts/cdp/states.mjs` (smoke, goal mode, stop, error + visual
  snapshots) against ONE Chrome — the seam the other two surfaces can't
  reach (SW + port + vault + agent loop end to end; only the model wire
  bytes are faked). It writes `scripts/cdp/artifacts/` (gitignored): a
  screenshot per state, a structured `result.json`, and a diff PNG on a
  visual miss. Built for an agent to self-drive a change→verify→fix loop.

**UI work runs through the verify loop — never call a rendered change done
on assertions alone.** When you touch a side-panel / home / component
surface, iterate edit → `bun run e2e:verify` → read
`scripts/cdp/artifacts/result.json` AND **`Read` the screenshots** → fix,
until `ok:true`. Looking at the PNGs is mandatory: for *new* UI there's no
baseline, so your eyes are the test; on a regression read the `*-diff.png`.
If you change a flow no state covers, ADD one to `scripts/cdp/states.mjs`.
The unit tiers assert structure but can't SEE the render; this loop closes
that gap.

---

## How the system is layered

This was the original build order; it IS the dependency graph
(Layer 1 → 2 → 3):

1. **Chassis skeleton.** Manifest, SW entry, offscreen doc, sidepanel
   shell. Get "load unpacked" working with an empty UI.
2. **`peerd-egress`** — vault, storage wrappers, `safeFetch`, denylist.
   Everything depends on this; build it first.
3. **`peerd-provider`** — model adapters. Schema conversions, streaming.
4. **`peerd-engine`** — the four execution kinds. Three hosted in their own
   tab (WebVM · Notebook · App), the fourth a headless worker (`js_run`)
   run offscreen with no tab.
5. **`peerd-runtime`** — agent loop, tool dispatcher, tool inventory.
   Exposure is decided in `tools/exposure.js`: low-level DOM/page tools are
   runner-only, the main agent reaches a page through `message_actor` (a
   tab's actor), and dweb tools are invisible where `DWEB_ENABLED` is
   false. Plus sessions, clock, subagent orchestrator, voice.
6. **Wire it together** in `background/service-worker.js` — message
   routing, DI, lifecycle. The SW is wiring plus thin per-route handlers;
   the logic lives in modules. If a handler needs more than a few lines of
   glue, push the logic INTO a module.

---

## Stylistic shorthand

- **One rainbow accent on monochrome (owner direction).** Surfaces are
  grayscale; the ONLY color carriers are the five-color brand marks — the
  spinning orb and the wordmark letters (p cyan, e red, e amber, r green,
  d magenta). Don't introduce other accent colors; failure/error red is the
  one semantic exception. One sanctioned accent moment: the composer's send
  disc draws ONE random brand color per draft (`SEND_ACCENTS` in
  `sidepanel/components/input-bar.js`), never more than one at a time.
- Filenames: lowercase, hyphenated (`safe-fetch.js`, not `safeFetch.js`).
- Exports: camelCase for functions/instances; PascalCase for classes and
  union members; SCREAMING_SNAKE for constants.
- Errors: named subclasses (`VaultLockedError`, `EgressDeniedError`), not
  generic `Error` with a message.
- Tests: `<file>.test.js`, colocated with or under the file under test.
- When in doubt, push functionality *down* the dependency graph, not
  across it. A module reaching sideways usually doesn't belong where it is.
