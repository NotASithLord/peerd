# CLAUDE.md — peerd

> Persistent project context for Claude Code. Read this first on every
> session. Equivalent to OpenCode's `AGENTS.md` pattern.

---

## What peerd is

A browser-native AI agent harness, shipped as a Chrome/Firefox extension.
The agent runs entirely in the user's browser. It talks to a model API
directly (BYOK — bring your own key), drives the browser's tabs and
DOM, and can run shell commands in a sandboxed Linux VM compiled to
WebAssembly. No backend, no telemetry, no account.

peerd is **0.x — experimental beta** (breaking changes likely; no "V1"
commitment — versions stay 0.x until the surface stabilizes). The
initial feature buildout is complete and integrated; current work is
store-readiness polish and field hardening. Stack:
Manifest V3, Chrome and Firefox (via `webextension-polyfill`), vanilla
JS, **no
build step**.

---

## The codebase is five modules

Each maps to one letter and color in the brand wordmark:

| Letter | Color | Module | Role |
|---|---|---|---|
| `p` | cyan    | `peerd-provider/`     | Model adapters (Anthropic, OpenRouter, OpenAI, Z.ai GLM, and keyless Ollama shipped; local WebGPU gated on the resident engine — `registry.js` is the live list) |
| `e` | red     | `peerd-egress/`       | Security: vault, allowlist (`safeFetch`), denylist, audit |
| `e` | amber   | `peerd-engine/`       | Execution instances — Sandboxes. Three kinds run in their own visible tab: WebVMs (CheerpX Linux), Notebooks (sealed JS worker + OPFS), Apps (opaque-origin iframe). A fourth, the **headless worker** (`script`), runs the Notebook's sealed worker offscreen with no tab — the agent's own quick compute. The sandbox is the isolate; a tab is one way to host it (taxonomy in the `peerd-engine/` code). |
| `r` | green   | `peerd-runtime/`      | Agent loop, tools + per-environment actors (`message_actor`), sessions, profiles, skills, memory, permissions (Plan/Act), review, goal mode (autonomous loop), composer, cost, transfer, voice, clock, web tool policy |
| `d` | magenta | `peerd-distributed/` | The dweb. An always-on P2P base network (offscreen mesh + DHT + gossip), did:key identity, signed content addressing, the dwapp bridge, and a peer-to-peer app store that **users AND the agent** build, share, and run dwapps on. Chrome preview only until Firefox has a mesh host. |

The extension *chassis* lives outside these modules: `background/`,
`offscreen/`, `sidepanel/`, `engine-tabs/`, `permissions/`, `eval/`,
`shared/`, `tests/`, `vendor/`, `icons/`. Each `peerd-engine` execution
kind owns a dedicated tab page under `engine-tabs/` (`engine-tabs/vm-tab/`,
`engine-tabs/notebook-tab/`, `engine-tabs/app-tab/`) — grouped so the
three engine host surfaces sit together; `permissions/` hosts user-gesture surfaces such as
the mic-permission grant page; `eval/` is the live end-to-end eval
harness. (There is no `content/` directory — DOM work happens via
injected functions, not a persistent content script.) Outside
`extension/`, the repo also carries `signaling-node/` (the dweb
rendezvous server shells sharing the pure signaling reducer). The peerd.ai
site lives in its own repo (`NotASithLord/peerd-site`), which also owns and
deploys the static `id.peerd.ai` WebAuthn ceremony page. This repo owns the
extension-side ceremony protocol and authenticator verification under
`peerd-distributed/`. The site repo vendors snapshots of the VM-demo runtime
and the `peerd-distributed` transport. Release packaging generates auto-update
feeds as release assets; the site repository downloads and deploys them.

The brand IS the architecture. If you find yourself adding a sixth
top-level peerd-* directory, stop and reconsider.

---

## What to read, in order

The code is the spec. There is no separate design-doc corpus; the
prose orientation is this file, and the rest is the source itself.

1. **`CLAUDE.md`** (this file) — orientation. Start here every session.
2. **The module code** — `extension/peerd-provider/`, `peerd-egress/`,
   `peerd-engine/`, `peerd-runtime/`, `peerd-distributed/`. Each
   module's `index.js` is its universal public surface; read it first, then the
   files it exports. An explicit environment entry point such as
   `background.js` may expose a cold-start-safe subset for that host.
3. **The code.** For concrete behavior (vault crypto, denylist matcher,
   agent loop, tool dispatcher, prompt-injection defenses, the manifest,
   the MV3 keepalive trick), read the source in the relevant module. It
   is authoritative; prose drifts, code does not.

---

## Non-negotiable conventions

- **Vanilla JS, ES modules, no development build step.** `extension/` runs
  directly in the browser. The dev loop is *load unpacked -> refresh*; there
  is no source bundler, transpiler, or generated runtime tree. Store and
  preview packaging may compact authored static cold-path modules only in its
  disposable staging copy. It must preserve module boundaries and names, lazy
  imports, and vendor bytes. `packaging/preflight.ts` is the release authority.
- **Generated files — don't hand-edit.** `extension/manifest.json` and
  `extension/shared/channel-config.js` are generated by `bun run gen:dev`
  from `manifests/*.json` and `packaging/default-settings.mjs`. CI fails on
  drift. Versions live in `package.json` only.
- **Docs defer to code and CI for live state.** Do not hard-code dynamic
  facts in prose: test/tool counts, gate matrices, release artifact lists,
  generated-file contents, extension IDs, channel behavior, provider/model
  inventories — and equally the things that quietly drift: **tunable
  constants and thresholds** (timeouts, caps, depths, retry code lists),
  **exact dates/PR numbers** as anything more than a passing anchor, and
  **inventories of a directory's internal files** (they grow with the code).
  Name the pattern and point at the source file / script / CI command that
  holds the real value; don't transcribe it. Static architectural
  invariants are fine; operational state belongs in code, generated output,
  or the release itself. When in doubt, describe the SHAPE and cite the file.
- **The dweb boundary.** Nothing outside `peerd-distributed/`
  imports it — not even its `index.js` (stricter than the per-module
  rule below; the store package prunes the module entirely). Core code
  uses the types + stub in `shared/dweb-interface.js` and
  `loadDweb()` from `shared/dweb-loader.js`. Channel
  behavior flows only through `CHANNEL_DEFAULTS` / `DWEB_ENABLED`
  from `/shared/channel-config.js` — never a runtime channel probe, and
  never exposed to the agent or skills.
- **All JS runs under strict mode.** ES modules are strict by default,
  so no `'use strict'` directive in module files (it would just be
  noise). Classic-script contexts get an explicit `'use strict'` at
  the top — currently `extension/tests/bootstrap.js`,
  `extension/permissions/mic.js`, and any function body injected via
  `chrome.scripting.executeScript` (the source is serialized and
  re-evaluated in the target page's classic-script world). If you add
  a new non-module entry point, the directive is mandatory.
- **No npm runtime inside the extension.** Third-party code lives in
  `vendor/` with a `SOURCE.txt` documenting where it came from and what
  version. Audit before vendoring.
- **Functional core, imperative shell.** Reducers are pure. Policy
  steps are pure functions. IO is *injected* as a parameter, never
  imported directly inside a module. This is the testability lever.
- **Mithril.js for UI.** Already vendored. Don't swap frameworks.
- **Three test surfaces, different jobs.**
    - **In-browser** at `extension/tests/runner.html` (tiny custom
      framework). Tests that need a browser: DOM, chrome.*,
      real IDB lifecycle, side panel components, SW behavior, the
      voice transcribers. These catch real integration breakage. KEEP
      these as the extension grows -- don't migrate to Bun. They also
      run HEADLESS via the CDP harness
      (`scripts/cdp/run-inbrowser-tests.mjs`) — and CI runs that
      harness as its own job, alongside bun tests, ESLint, the
      strict typecheck of the bun suite, the dweb-boundary check,
      generated-file drift, and the 2×2 channel/browser artifact
      matrix.
    - **Bun** at `tests/**/*.test.ts` (run with `bun test ./tests`).
      Tests for pure logic that can be exercised without a browser:
      registries (storage abstractions), the module resolver
      (source-transformation), other pure helpers. Fast (<1s),
      runnable from the terminal, good for solo-dev TDD. The suite is
      typechecked STRICT (`bun run typecheck`, a CI + preflight gate) —
      Bun itself strips types without checking, so the gate is what
      makes the annotations real. `allowJs` pulls the extension's
      JSDoc typedefs into the check: tests double as drift detectors
      for the JSDoc contracts. The SAME `tsc` run now also checks the
      extension itself, file-by-file via an opt-in ratchet: `checkJs`
      stays OFF at the config level, so an extension `.js` file is
      type-checked only once it carries a `// @ts-check` directive
      (unannotated files are still parsed for their JSDoc but their
      bodies aren't checked — no flag-day on a 72k-line no-build
      codebase). `chrome` is typed by `@types/chrome`; `browser` (the
      vendored webextension-polyfill) by the sidecar
      `extension/vendor/browser-polyfill.d.ts` — both dev-only,
      type-only, no runtime/build cost. `bun run check:tscheck`
      enforces a coverage FLOOR (count of `// @ts-check` files) so the
      checked set only grows; the deliberately-ES5 injected bodies are
      never annotated and don't count. To add coverage: add the
      directive, make the file pass `bun run typecheck`, bump the floor.
    Rule of thumb: if a test would mock half the world to run, it
    wants the browser. If it operates on values in and values out,
    it wants Bun.
    - **Every lane publishes its own count** as a committed Shields
      endpoint under `badges/` (Bun suite, red-team catalog, in-browser
      under Chrome, in-browser under Gecko, side-panel E2E).
      Generators are `packaging/gen-*-badge.ts` on a pure core
      (`packaging/test-badges.ts`); the CI job that RAN a lane
      regenerates its badge and diffs it, so a published number is
      always a run that happened. Never hand-edit one, and never quote
      the counts in prose: the badge JSON is the live value.
      `bun run check:badges` proves the endpoints are well-formed
      without launching a browser. Note the two in-browser lanes do NOT
      report the same total, and that is not drift: a few tests
      register only where a live service worker answers
      (`chrome.runtime.sendMessage`), so Chrome registers a slightly
      larger graph than Gecko. Each lane asserts it executed every test
      it registered, which is the property that matters.
    - **Supply-chain badges ride `gen:dev`, not a test lane** (runtime
      npm deps, vendored files pinned, Actions SHA-pinned). Pure reads
      of `package.json`, `vendor.lock.json` and `.github/workflows`
      (`packaging/supply-chain.ts` + `gen-supply-chain-badges.ts`), so
      they drift-check with the manifest rather than needing a browser.
      Each one has a gate behind it: `check:vendor`, `check:actions`
      (new: every third-party action at a full commit SHA), and the
      no-npm-runtime invariant itself.
    - **Live E2E + the verify loop** at `scripts/cdp/run-e2e-verify.mjs`
      (`bun run e2e:verify`). Loads the REAL unpacked extension in
      Chrome for Testing and drives the live side panel through every
      "state" in `scripts/cdp/states.mjs` (smoke, goal mode, stop,
      error + visual snapshots) against ONE Chrome — the seam the other
      two surfaces can't reach (SW + port + vault + agent loop end to
      end; only the model wire bytes are faked, over CDP Fetch). It
      writes `scripts/cdp/artifacts/` (gitignored): a **screenshot per
      state** to LOOK at, a structured **`result.json`** (per-check
      pass/fail + the why), and a **diff-highlight PNG** on a visual
      miss. This is built for an AGENT to self-drive a change→verify→fix
      loop: edit, `bun run e2e:verify`, read `result.json` + the
      screenshots, fix, repeat until `ok:true`. (`--functional` skips the
      visual states; CI runs that via `test:e2e:all`.)
    - **The visual lane STORES NOTHING. The reference is the merge base.**
      No screenshot is committed anywhere in this repo (CI enforces that).
      On a PR the `visual` job renders every state twice on the pinned
      runner + pinned Chrome (`scripts/cdp/chrome-version.txt`) - once
      against the merge-base extension build, once against the branch -
      diffs the pairs, and posts the before/after inline on the PR
      (`scripts/cdp/visual-vs-base.mjs`). peerd has no development build output, so
      "check out the base and render it" is a worktree plus a harness
      run. The trade, stated: a computed reference cannot tell an intended
      redesign from a regression, so the lane REPORTS and never gates -
      the checkpoint is a human reading the before/after, not a committed
      baseline. What lands in `scripts/cdp/baselines/<platform>/` is a
      gitignored LOCAL self-reference for your own loop only. Details +
      the measured numbers: `scripts/cdp/visual-vs-base.mjs`.
- **UI work runs through the verify loop — never call a rendered change
  done on assertions alone.** When you touch a side-panel / home /
  component surface, iterate edit → `bun run e2e:verify` → read
  `scripts/cdp/artifacts/result.json` AND **`Read` the screenshots** →
  fix, until `ok:true`. Looking at the PNGs is mandatory, not optional:
  for *new* UI there's no baseline, so your eyes are the test; on a
  regression read the `*-diff.png` to see what moved. Tighten the loop
  with `--only=<state>` or `--visual`. If you change a flow no state
  covers, ADD one to `scripts/cdp/states.mjs` — nothing to seed or
  commit, since CI computes its "before" from the merge base — an
  uncovered UI change is an unfinished one. why: the unit tiers can
  assert structure but can't SEE the render; this loop is how an agent
  closes that gap on its own before pushing.
- **Public entry points are the API per module.** `index.js` is the universal
  surface; a named environment surface such as `background.js` may expose a
  strict cold-start subset. ESLint `no-restricted-imports` forbids every other
  deep path from outside the module. Inside the module, deep imports are fine.
- **The credential ladder — prefer the credential peerd cannot read.**
  When the agent must act as the user, climb DOWN this ladder and stop at
  the first rung that works; never drop a rung for convenience:
    1. **The browser holds it.** Drive the authenticated tab and let the
       browser attach the session. peerd requests no `cookies` permission,
       so it *structurally cannot* read what it is using — a platform
       guarantee, not a discipline one (`site_client_*`, the web actor).
    2. **A key peerd cannot export.** A proof-of-possession keypair
       generated `extractable: false`: peerd holds a HANDLE, mints a
       per-request DPoP proof at the egress boundary, and no in-origin
       code — ours or an attacker's — can export the key material. Needs
       provider support, RFC 9449 (`peerd-egress/dpop/`).
    3. **A bearer secret in the vault.** The fallback the ecosystem forces:
       bytes that must be sent verbatim, so *someone* holds them.
       Encrypted at rest, decrypted only in the SW, injected at the egress
       boundary, never on the agent's ctx, bound to exactly one https
       origin (`fetch/origin-credentials.js`).
    4. **The user's own hands.** If none of the above is safe, verify the
       origin, take consent, and hand the gesture back to the user (the
       `login` tool, INV-14).
  why an explicit ladder: "can the AGENT see it" and "does PEERD hold it"
  are different questions, and only the second decides whether a
  compromise yields a portable, replayable secret. A rung-1 or rung-2
  credential cannot be walked away with; a rung-3 one can. A new
  integration must justify every step down.
- **Comments explain *why*, not *what*.** Every architectural choice
  gets a `// why:` comment. Code without rationale rots fast.
- **Modern, functional JS — lint-enforced.** `eslint.config.js`'s
  "stylistic modernization" block makes the house style a gate (autofix
  with `eslint extension --fix`): `const`/`let` never `var`, arrow
  callbacks, template literals, object shorthand, spread, `Object.hasOwn`,
  array methods / `for…of` over C-style `for(;;)` (a counting loop is fine
  for byte/codec work, reverse iteration, retry loops, or early-exit).
  Name things in full so identifiers read like the docs. **Exception: the
  injected-into-page classic-script bodies** (`dom/walk-injected.js`,
  `dom/framework-state.js`, `dom/pull-in-hint-injected.js`,
  `background/debugger-pool.js`, `tools/defs/watch-changes.js`) are
  deliberately ES5 — `var`, `function`
  bound to a caller `this` — and are exempted in the config. Don't
  "modernize" them. The same one-paragraph reminder rides the `js_create`
  / `app_create` tool results (`tools/defs/code-style-note.js`) so the
  agent writes Notebook/App code to this bar too.

---

## How the system is layered

This was the original build order; it's kept because it IS the
dependency graph (Layer 1 → Layer 2 → Layer 3) — everything below
exists today:

1. **Chassis skeleton.** Manifest, SW entry, offscreen doc, sidepanel
   shell. Get "load unpacked" working with an empty UI.
2. **`peerd-egress`** — vault, storage wrappers, `safeFetch`, denylist.
   Everything depends on this; build it first.
3. **`peerd-provider`** — Anthropic + OpenRouter adapters. Schema
   conversions, streaming, error handling.
4. **`peerd-engine`** — Sandboxes: four execution kinds (taxonomy in
   the module code). Three are hosted in their own visible tab — WebVM
   (CheerpX), Notebook (sealed JS worker + OPFS), App (opaque-origin
   iframe) — each with a registry in `peerd-engine`, a runtime in its tab
   page under `engine-tabs/` (`engine-tabs/vm-tab/`, `engine-tabs/notebook-tab/`,
   `engine-tabs/app-tab/`), and a tab tracker + RPC
   client in `background/`. The fourth, the **headless worker** (`script`),
   runs the Notebook's sealed worker in the offscreen document with no tab
   (`offscreen/job-runner.js`) — the agent's own quick compute, same
   substrate as a Notebook, different host.
5. **`peerd-runtime`** — agent loop, tool dispatcher, and the tool
   inventory. Registered tools are assembled from `BUILTIN_TOOLS`, clock,
   web tools, and service-worker wiring; do not pin the live counts in
   prose. Exposure is decided in `tools/exposure.js`: the low-level
   DOM/page tools are actor-only, never on the main agent — the
   orchestrator delegates plain-language goals to per-environment
   actors (web / webvm / notebook / app) via `message_actor`
   (`actor/actor-messaging.js`; `actor_list` enumerates every
   addressable handle), and replies re-enter it fenced on a later
   turn — it never blocks. The web actor (`actor/web-actor.js`) is
   the single entry point for web work: it picks between a sessionless,
   denylist-gated `fetch_url` and opening + driving a tab. Dweb tools
   are invisible where `DWEB_ENABLED` is false. Plus sessions, clock
   (temporal grounding), actor orchestrator, voice (Moonshine WASM
   + Web Speech fallback).
6. **Wire it together** in `background/vault-kernel.js`; keep the kernel thin.

---

## What's shipped vs what's still ahead

**Already shipped** (don't re-implement; extend instead). The code is
the canonical catalog: read the relevant module before assuming
something isn't built. The bullets here are the postures and
gotchas to know going in:

- Anthropic provider with streaming, adaptive extended thinking on newer
  models, prompt-cache breakpoints, retry on transient/overload statuses,
  and the `anthropic-dangerous-direct-browser-access` ack — plus an
  OpenRouter adapter (OpenAI-compatible gateway), a direct OpenAI adapter,
  a Z.ai GLM adapter (OpenAI-compatible direct endpoint), and a keyless
  Ollama adapter (local inference; live `/api/tags` model inventory; GPU-fit
  model recommendation in Settings) (`peerd-provider/`). The shipped set is
  whatever `registry.js` registers — don't take this list as authoritative.
- Vault with passphrase unlock AND WebAuthn PRF (Touch ID / Windows
  Hello) — same DK from either path (`peerd-egress/vault/`). Idle
  auto-lock ON by default (user-settable); manual Lock button
  in the top bar.
- `chrome.debugger` usage (CDP) — a CHANNEL-GATED required permission,
  NOT the default. Chrome forbids `debugger` under `optional_permissions`
  (it's silently omitted), so where CDP ships it's required at install.
  It ships in the **preview/dev** channels — where CDP is the default
  automation path — and is STRIPPED from the initial **store** Chrome
  package and from every Firefox package (`packaging/gen-manifest.ts`
  `STORE_STRIPPED_PERMISSIONS`; re-added to a store update post-approval —
  a one-line flip; `docs/store/OPEN-DECISIONS.md` §1). The DEFAULT
  path for the web actor's DOM tools on store-Chrome AND Firefox is
  `chrome.scripting`: a DOM-walk pseudo-a11y snapshot
  (`peerd-runtime/dom/walk-injected.js`) feeding the SAME serializer as
  CDP, with selector/`walkId` click/type and a `world:'MAIN'` `read_state`
  fallback (`peerd-runtime/dom/framework-state.js`). Gating: the CDP pool
  is wired into a tool context only when `advancedAutomationOn()` =
  `debuggerApiAvailable()` (namespace present) AND the
  `advancedAutomationEnabled` SETTING (default ON preview/dev, OFF store;
  Settings → Advanced). The pool supplies exact-tab screenshots,
  accessibility snapshots, framework-state inspection, node actions, and
  site-client network capture where CDP ships. Pool lives in
  `background/debugger-pool.js`.
- Spawned actors — depth-bounded recursion, tool
  narrowing, output cap. Real implementation at
  `peerd-runtime/actor/spawn.js` — not a stub. Since the async-actor
  unification (PR #134): a child runs under its own turn slot with an
  abort signal and a wall-clock timeout (Stop and `actor_cancel`
  actually end its work, transitively down the subtree), and a
  trusted-lineage actor may `message_actor` — the sender gate walks
  server-stamped `spawnedTrusted` hops (`actor/delegation-lineage.js`;
  an inbound spawn taints its whole subtree), delegation budgets are
  keyed by the lineage root, and an actor's actor reply resolves into
  its tool result (an ephemeral child has no later turn to wake).
- The heap split — EVERY non-orchestrator agent loop runs in its OWN
  dedicated Worker heap (`peerd-runtime/actor/actor-worker-core.js`
  drives it; `offscreen/actor-worker.js` + `actor-runner.js` +
  `background/offscreen-actor-client.js` host + relay it). Chrome starts the
  runner from its offscreen document. Firefox starts the same runner directly
  from its extension background page. One substrate,
  two shapes: a BOUND actor (web/webvm/notebook/app, instance-pinned) and an
  EPHEMERAL actor (spawned — tool-less = pure reasoning, tool-bearing =
  a narrowed-general toolset). The worker holds NO key, NO `chrome.*`, NO
  engine clients; its only outward edges are two SW-gated relays — the model
  call (the SW adds `getSecret`+`safeFetch`; the key never enters the worker)
  and every tool call (the SW rebuilds the caller's instance-pinned or
  `grantedTools`-restricted ctx and re-checks it, NEVER trusting the worker's
  args). Chrome pins both relays to the offscreen document and a per-run grant.
  Firefox keeps the runner and relay calls inside the background page behind a
  private object-identity sender. The grant adds run identity and liveness on
  both hosts, so a replayed relay from a settled run is refused. A run-scoped,
  acknowledged Firefox `storage.session` heartbeat keeps the MV3 event page
  alive only while actor work is active, then stops after the last turn settles.
  A lost heartbeat pauses actor work until a manual probe succeeds. So the
  actor fence is a MEMORY boundary, not a prompt boundary: untrusted
  page/instance/response content stays behind the heap, one process-eviction from
  the vault DK no longer reachable. A versioned readiness and realm probe must
  pass before a model call or tool relay can begin. A missing or failed host
  refuses the actor turn before any target action. why it matters: prompt
  injection has no filter — the fix is to never hand untrusted reasoning the
  authority in the first place.
- Voice — local transcription via Moonshine (WASM, SRI-pinned model
  download, OPFS-cached) with a Web Speech API fallback. Hosted in the
  offscreen doc (`peerd-runtime/voice/`).
- Sandboxes — four execution kinds (taxonomy in the `peerd-engine/` code).
  Three run in their
  own browser tab — WebVM (CheerpX), Notebook (sealed JS worker + OPFS),
  App (opaque-origin iframe) — each with its own registry + tab tracker +
  RPC client. The fourth, the headless worker (`script`), is the same
  sealed worker run offscreen with no tab, for the agent's own quick
  compute (code mode).
- Policy-gated dispatcher with full lineage attached to every tool
  result. The live stack is defined in `gates.js` plus the default
  pre/post tool-use hooks; keep prose at the invariant level so it does
  not drift. Current posture in code: Plan/Act enforcement, main-vs-actor
  exposure enforcement (the exposure + actor-capability-tier gates:
  actor-only tools refused for the main turn, each actor positively
  pinned to its own kind's toolset and instance), sensitive-origin
  blocking, async confirmation, egress
  enforcement in the allowlist hook and fetch wrappers, and append-only
  audit. The legacy permission-mode axis was REMOVED
  2026-06-12 — Plan/Act + the denylist carry the safety weight; Plan
  permits pure URL loads only, never clicks (enforced in `gates.js`).
- The feature buildout — memory, edit + checkpoints, Plan/Act,
  composer (slash commands + @-refs), goal mode (autonomous loop), cost
  telemetry, skills, review actor, and hooks — all integrated.
  (do/get/check was CULLED: the web actor drives pages directly, so one
  delegation reaches the page instead of two.) Per-feature
  detail lives in the code under `peerd-runtime/`.
- Dual distribution: store (no dweb) + preview channels, generated
  `manifest.json` / `channel-config.js` (`bun run gen:dev`). `package.json`,
  `packaging/preflight.ts`, and CI are the source of truth for release
  checks.
- `peerd-distributed/` — REAL code, well past the Phase 0 primitives
  (Ed25519 did:key identity, codec, content addressing + chunked
  signed-bundle transfer, the pure signaling reducer shared with
  `signaling-node/`). Now live: an **always-on base network** in the
  offscreen doc (a WebRTC mesh introduced by a bootstrap node, gossip,
  presence, and a Kademlia DHT — the content directory); **dwapps** as
  namespaced sub-protocols on that shared mesh (commons rides it, no
  per-app rendezvous); a **peer-to-peer app store** (Share → Discover →
  Install over the mesh, no server); and the **agent reaches all of it**
  through the `dweb_share`/`dweb_discover`/`dweb_install` tools + the
  dwapp bridge (it builds p2p dwapps that users and agents both use).
  Chrome-preview only until Firefox has a mesh host. Other artifacts prune the
  module and CI verifies the package boundary. See the `peerd-distributed/` code.
- **Portable identity, same-user device enrollment + P2P state sync**
  (`peerd-distributed/identity/` + `self/`). The permanent
  person did:key stays the root; nothing is derived from a passkey, biometric,
  or device. Under it: a per-install **device key** (never exported, under the
  export-excluded `distributed/device-key/` prefix) certified by the root; a
  **passkey binding** making a WebAuthn credential at the canonical RP
  (`id.peerd.ai`, hosted page owned by `NotASithLord/peerd-site`) an
  enrollment/recovery authority;
  and a **discovery secret**, distinct from every signing seed and vault key
  that derives **rotating HMAC rendezvous topics** so a person's devices find
  each other without advertising their did. Certificates + rosters are signed
  SNAPSHOTS with monotone `seq` (add/revoke/rotate never change the did).
  A discovered peer is a CANDIDATE only: `self-device` requires a same-root
  certificate AND challenge-response proof of its device key, both directions,
  domain- and nonce-bound. State then moves over **versioned logical surfaces**
  (`self/sync.js`), hash-verified per surface, idempotent on retry, and
  refused to any non-self peer. The durability registry gained a
  `personPortable` axis (broader than file `portable`: chats/Apps/workspace
  CONTENTS sync to a proven self device); permission grants, audit history,
  device keys, and live engine handles are excluded on both. Routine mesh
  signing still uses the root: the wire verifier must accept
  certificate-backed identity everywhere first (03-device-subkeys.md).
- The **dweb actor** — a fifth bound-actor kind (`actorType:'dweb'`) and the
  first DAEMON actor: an opt-in (`dwebAgentEnabled`, Chrome-preview-only, default
  off), persistent, GLOBAL singleton addressable as `message_actor("dweb",…)`.
  It ABSORBS the dweb tools (they leave the orchestrator unconditionally —
  `mainAgentDescriptors` drops them by name + the tier gate refuses them for
  any non-actor ctx), runs keyless in the same offscreen heap as every actor,
  and MONITORS inbound mesh traffic: peers reach it on the reserved
  `peerd-agent` room, whose `direct` events wake it as fenced, INBOUND
  (untrusted) turns — the sender gate means an inbound message can never make
  it delegate. Rate-capped (per-did + global caps, `background/dweb-inbound-rate-cap.js`)
  before any model call; notable findings trickle up to the active chat as an attributed
  actor-reply bubble (runWhenIdle — never steals a live turn). The envoy for
  agent-to-agent over the mesh: "a peer's agent" is just an actor whose heap
  is on another machine.
- **Agent-to-agent (A2A) over the mesh** — the dweb actor talks to other
  agents by WRITING CODE, the #119 bet applied to p2p: `a2a_run` runs JS
  against a `mesh` client (peers/card/ask/send/publishCard/inbox) in the SAME
  sealed keyless worker as `script`, plus ONE capability — the mesh bridge —
  and nothing else (the host denies egress + actor-spawn for an a2a run;
  see `offscreen/job-runner.js`). The pure translation core is
  `actor/a2a-api.js` (the page-api.js twin: `meshCallToOp`/
  `shapeMeshResult`, a `MESH_METHODS` table); the ask/reply CORRELATION —
  tag a request DM, await the matching reply bound to the target did, time
  out — is `actor/a2a-dispatch.js`. We RHYME with A2A's data
  model (`peerd-distributed/agent-card.js` — Agent Card, message shape) for
  future interop, but REJECT its HTTP+SSE transport: the mesh is the
  transport, did:key the address, the fenced inbound wake the stream. Signing
  ops (ask/send/publishCard) need per-target user consent, remembered and
  revocable via `dweb_block`; peer bytes are `wrapUntrusted`-fenced by
  construction. Dweb-actor-only and Chrome-preview-only.

**Still ahead** (backlog — not version-pinned. Don't front-run; let each
land with deliberate design work):

- Profiles — per-profile vault namespacing, denylist, skills, memory,
  sessions; the default profile uses the same shape.
- Per-*profile* tool manifests — the per-SESSION layer already shipped
  (the `/tools` presets + `session.toolManifest`; `tools/manifests.js`,
  `tools/manifest-command.js`, enforced in `gates.js`), on top of the
  registration/exposure split. What's still ahead is binding a manifest to
  a *profile* (rides the Profiles item above). Note: the per-environment
  actors are already trimmed to tight per-kind allow-lists by
  construction (`tools/exposure.js` `actorAllowedTools`, enforced at
  dispatch in `gates.js`) — an actor never sees the full surface.
- New provider adapters — the shipped set (Anthropic, OpenRouter, OpenAI,
  Z.ai GLM, Ollama) lives in `peerd-provider/adapters/`; adding one is a
  registry entry, not chassis wiring. The manifest still does NOT pre-declare
  hosts for adapters a given package doesn't ship (store policy: never request
  what the shipped version doesn't use); `<all_urls>` already covers HTTPS API
  hosts, and a loopback provider like Ollama needs its own CSP connect-src
  entry (`manifests/base.json`).
- The dweb's next reach — A2A's first hop shipped (the `a2a_run` code
  surface above); still ahead is what rides it: standing multi-turn peer
  conversations beyond a single run, richer dwapps, and global discovery
  (find an agent by capability across the whole mesh, not just the present
  roster). The base network + signed direct channels + the Agent Card are in
  place; this is fleshing out what rides them.
- Portable identity's remainder: the certificate machinery ships, but the
  ROUTINE-SIGNING switchover does not: envelopes, Agent Cards, manifests, DHT
  items, and A2A still sign with the person root, and the wire verifier must
  accept certificate-backed identity across all of them before that moves.
  Also ahead: the rendered "Use my existing Peerd" fork on the vault gate
  (the flow + copy are implemented and tested; the render needs the visual
  verify loop), a deployed `id.peerd.ai`, roster/binding propagation over
  gossip + DHT with offline revocation (#362), and ongoing multi-device sync
  (this arc is initial migration by snapshot: no CRDTs, no multi-master).

---

## Stylistic shorthand

- **The brand color rule (owner direction, 2026-06-12): one rainbow
  accent on monochrome.** Surfaces are grayscale; the ONLY color
  carriers are the five-color brand marks — the spinning orb
  (spinners) and the wordmark letters (p cyan, e red, e amber,
  r green, d magenta — on letterforms in terminal surfaces, on blocks
  in the side panel). They mirror each other. Don't introduce other
  accent colors; failure/error red is the one semantic exception.
  Spinner cadence is brand-wide: 0.85s (was 1s) and proportional
  elsewhere. One sanctioned accent moment: the composer's send disc
  draws ONE random brand color per draft (mic→send morph,
  `SEND_ACCENTS` in sidepanel/components/input-bar.js — owner
  experiment 2026-06-12; still never more than one color at a time).
- Filenames: lowercase, hyphenated (`safe-fetch.js`, not `safeFetch.js`).
- Exports: camelCase for functions and instances; PascalCase for
  classes and union members; SCREAMING_SNAKE for constants.
- Errors: named subclasses (`VaultLockedError`, `EgressDeniedError`),
  not generic `Error` with a message.
- Tests: `<file>.test.js`, colocated with or under the file under test.
- When in doubt, push functionality *down* the dependency graph, not
  across it. A module reaching sideways is usually a sign it doesn't
  belong where it is.
