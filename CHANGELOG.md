# Changelog

All notable changes to peerd are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning
is **`0.MINOR.PATCH`** (minor = milestone, patch = fix). The
`store`/`preview`/`dev` channels are a separate axis.

peerd is **0.x, an experimental preview**: breaking changes are likely
and storage formats may move until the surface stabilizes.

## [Unreleased]

### Added
- **Agent-to-agent over the mesh (A2A): the dweb actor talks to other
  agents by writing code** (preview only). Following the same bet as the web
  actor — models write a short script more fluently than they fire one gated
  action per turn — the dweb actor drives peer conversations through a new
  `a2a_run` tool: it writes JS against a `mesh` client (`mesh.peers()`,
  `mesh.card(did)`, `mesh.ask(did, msg)`, `mesh.send(...)`,
  `mesh.publishCard(...)`, `mesh.inbox()`) and returns the outcome. `ask`
  sends a request-tagged direct message and awaits the peer's one reply; an
  Agent Card advertises what your agent can do and is discoverable by other
  peers. The data model rhymes with Google's A2A (Agent Card, message shape)
  so future interop is a thin adapter, but the transport is the mesh, the
  address is a did:key, and the reply stream is the fenced inbound wake — not
  A2A's HTTP+SSE. The code runs in the same sealed, keyless worker as
  `js_run` with one added capability, the mesh bridge, and nothing else: an
  a2a run gets no egress and cannot spawn subagents. First contact to a peer
  (and advertising your own card) needs your explicit ok, remembered per did
  and revocable by blocking the peer; peer replies and cards are always
  fenced as untrusted. It's a dweb-actor tool only — the orchestrator never
  holds it, and the store build prunes the whole surface. Hardened after an
  adversarial re-review: the Agent Card size/field caps are enforced on both
  the publish and fetch paths, first-contact "Allow once" is a genuine
  one-shot (only "Allow for session" persists, and blocking a peer revokes
  it), and the ask/reply round-trip is now covered by a live two-peer
  WebRTC test.

### Changed
- **The service worker is slimmer and the worker bridges are unified.** Two
  internal refactors, no behavior change. The four hand-rolled worker↔host
  bridges (OPFS, subagent, base-network reads, the a2a mesh) collapse into a
  single factory, so adding the next one is a one-liner. And the service
  worker sheds the clusters that were logic rather than wiring — the model
  picker's catalog, the tab-strip affordances, and a couple of pure actor
  kernels now live in their own small, tested modules, keeping the service
  worker to assembly and routing.

## [0.2.2] - 2026-07-04

### Added
- **The dweb actor: a dedicated, opt-in mesh operator** (preview only). When
  the network is on, a second toggle spins up a persistent, keyless agent in
  its own worker heap. It absorbs the dweb tools (discover / share / install /
  block / peers / discovery), keeps a peer-and-publisher reputation ledger,
  and monitors messages addressed to your agent, surfacing only what's
  notable. It's addressable in chat as `message_actor("dweb", …)`. It can
  never be made to act by an inbound message: inbound turns may only observe,
  use its own tools, and report. It installs or shares only with your
  confirmation. With it on, the mesh tools leave the orchestrator entirely.
  Mesh work is one delegation.

### Fixed
- **The global instance reads are now fenced.** `js_read_file` and
  `app_read_file` stay on the orchestrator, so files can be inspected cheaply
  without an actor turn, but their content now comes back inside the
  `wrapUntrusted` fence. An instance file is not reliably agent-authored:
  notebook/app code fetches and persists web data. So an unfenced read was
  the last remaining way for untrusted bytes to reach the orchestrator's
  trusted context. `js_run` gets the same treatment: output from a
  pure-compute run stays raw (it is the agent's own code), but a run that
  called `peerd.egress.fetch` has its value, console, and error text fenced.

### Added
- **Actor replies now surface in the chat as their own messages.** When a
  delegated actor (web / WebVM / Notebook / App) replies, the reply appears
  at its place in the conversation as a quiet, attributed bubble ("notebook
  actor · Esoteric Math"). Before, it was buried inside the `message_actor`
  tool card of an earlier turn. Failures show the same way, marked failed.
- **Notebook heatmap charts.** `chart({ type: 'heatmap', data, x, y, v })`
  from `peerd:std` renders a density grid: rows of `{ x, y, v }` bins shaded
  by `v`. This was the missing chart kind that agents kept building with
  hand-rolled Vega specs.
- **Notebook errors point at your code.** A run error's stack now maps back
  to `notebook.js:<line>` (both in the output pane and in the agent's tool
  result) instead of showing internal blob-URL frames. Applies to the
  headless `js_run` path too (`job.js:<line>`).
- **Notebook iteration feel.** When a new run starts, the previous run's
  output stays visible but dims. Consecutive runs read like a loop while
  every realm stays fresh. The toolbar also gains a `peerd:std ?` cheat
  sheet: the import line, the chart spec, and the full helper list at a
  glance.

### Changed
- **The heap split.** Every non-orchestrator agent loop now runs in its own
  dedicated offscreen Worker heap. Bound actors (web / WebVM / Notebook /
  App) and subagents (both tool-less reasoning and tool-bearing) run keyless,
  in isolated memory. They reach the model and their tools only through
  service-worker routes that re-check every call. Untrusted page, instance,
  and response content stays in the actor's heap. It cannot reach the vault
  key or the orchestrator's memory. The "actor fence" went from a prompt
  boundary in one shared heap to a real memory boundary, the correct answer to
  prompt injection: the loop that reads hostile content never holds the
  authority to act on it. One substrate, one
  code path: a subagent is an ephemeral actor, so the former reasoning and
  actor stacks collapsed into one. Chrome-only (it needs the offscreen API);
  Firefox falls back to the keyless in-SW loop until it has one.

### Fixed
- A subagent could be granted the actor-only DOM/page tools (`read_page`,
  `page_exec`, `click`, `navigate`, `fetch_url`, …) and read or drive the
  user's foreground tab. That is authority the main agent itself lacks. A
  subagent's grantable toolset is now narrowed from the main-agent surface,
  so it holds a subset of what its parent holds and delegates web/DOM work
  to the web actor like the main agent does.
- The vault-gate code-stream backdrop left faint lighter-than-black bands on
  every row it had ever typed on (the alpha-wash fade only asymptotes toward
  the background). The animation now redraws from state each frame and
  trails decay to exactly zero. Idle rows are indistinguishable from
  untouched background.
- A Notebook run that returned a huge unrecognized object (e.g. a
  hand-rolled Vega-Lite spec) dumped the entire JSON, hundreds of KB, into
  the output pane, and the model's copy of the value was blind-truncated
  mid-JSON. The pane dump is now capped with a note, and the tool result's
  `[VALUE]` block is cut cleanly at the source, with an actionable
  instruction to return a compact value or a `chart()`/`table()` descriptor.
- `peerd.self.import('peerd:std')` failed ("cannot resolve"). The dynamic
  import shim routed builtins through the OPFS compose path, where a builtin
  has no file. Builtins now import their real URL directly, matching the
  static resolver.

---

## [0.2.1] - 2026-06-29

The code is the spec now: the standalone prose-doc corpus is removed. Deleted
DESIGN.md, ARCHITECTURE.md, ARCHITECTURE-CHANGES.md, MAP.md, FEATURES.md,
PACKAGING.md, STATUS.md, TODO.md, VERSIONING.md, CONTRIBUTING.md, the whole
`docs/` tree of specs and distributed-design notes, and the per-module
DESIGN/DEV-NOTES files. Orientation now lives in README.md, CLAUDE.md, the
per-module READMEs, and the code. SECURITY.md and the store-listing and
compliance docs (`docs/store/`) are kept. No runtime behavior change; the
extension's user-facing behavior is identical to 0.2.0.

### Removed
- The standalone prose design docs (see above). README.md and CLAUDE.md now
  point at the per-module READMEs and the code instead of the deleted files.

---

## [0.2.0] - 2026-06-29

This release restructures peerd's agent. It lands the staged backlog of
open PRs on one verified branch. Three things get better:

- **Less context on the main agent.** Each environment's operating
  details (VM shell quirks, notebook isolation rules, app iframe gotchas,
  whether to fetch or render a page) used to sit in the main prompt on
  every turn, mostly unused. Now they live with the sub-agent that uses
  them and load only when work is handed off. The main agent also drops
  the web tools it no longer needs: web_search, read_article, call_api,
  and submit_form all fold into the web actor.
- **Fewer tool calls.** actor_list replaces five separate list tools with
  one. The agent makes one call and carries one list instead of five.
  message_actor's oneShot skips a whole model turn when one round of work
  is enough.
- **Enforced isolation.** The tools that operate environments are no
  longer on the main agent at all, so even a confused or prompt-injected
  agent can't reach them. It has to send a permission-gated message. Page
  text, fetch bodies, and command output stay inside the sub-agent and
  come back as a quoted, untrusted reply, never as raw text the agent
  could be steered by.

### Added
- **The actor architecture** (DESIGN-17 / DESIGN-18). The main agent now
  acts as an orchestrator. It opens an environment (a WebVM, a notebook, a
  built app, or the open web) and hands the work to that environment's own
  sub-agent, called an actor, which holds only that environment's tools.
  There is one way to delegate, message_actor. The web actor is the single
  entry point for all web work and picks per task between a sessionless
  fetch (fetch_url) and driving a real tab. Delegations run in the
  background and in parallel. They show up as cards in the chat that you
  can watch and stop, and they report their own cost. They survive a
  service-worker restart because pending work is written to storage.
- **API integrations (origin actors).** Send a message to a bare origin
  like api.github.com and peerd forms a fetch-only, keyless,
  origin-locked actor for it. The actor remembers what it learns about
  that API across messages.
- **actor_list.** One tool that lists everything you can message: every
  WebVM, notebook, app, open tab, and API integration, each with its type
  and the handle to pass to message_actor. Replaces five separate list
  tools.
- **message_actor oneShot.** Set it when one round of work settles the
  request, like a specific command or a read. The actor does the action
  and hands back the raw result instead of spending an extra model turn to
  restate it.
- **PDF reading** (`read_pdf`). pdf.js text-layer extraction in the
  offscreen document for born-digital PDFs. Runner-only, with output
  wrapped as untrusted web content.
- **On-device OCR for scanned PDFs.** The render→recognize pipeline is
  wired (Tesseract). `auto` escalates when a PDF looks scanned and the
  opt-in engine is installed. Fail-closed: it falls back to the text
  layer until the driver is vendored and the asset SRIs are pinned. See
  `docs/PDF-READING.md`.
- **Browser-native VM networking.** Full HTTP, multi-host `git clone`,
  npm/pip/gem install via host-side resolution, and a response cache.
- **Session robustness.** Auto-resume after a service-worker restart, a
  per-message session store, and a provider failover chain.
- **Whole-extension type coverage.** `// @ts-check` across the
  extension (100% of eligible files), enforced by a coverage floor.
- **Verbose VM diagnostics.** The `devMode` setting wires shell tracing
  into the WebVM bridge.

### Changed
- The main agent's browser tools are now just actor_list, open_tab, and
  message_actor (plus capture). The low-level page tools and the tools
  that write to an environment moved to the actors.
- WebVM self-heal. When the browser freezes a backgrounded VM tab, peerd
  now checks it and reloads it before a command lands on a dead shell. The
  terminal output stripping was also fixed so output is not eaten when it
  splits across a chunk.
- The thinking and boot spinner is now the brand orb ring, one rainbow
  sweep masked to a hollow ring.
- The prose docs were removed. The code is the spec, and CLAUDE.md is the
  short orientation map.
- Service worker restructured into per-route modules with injected
  per-module state stores; handlers stay thin.
- README reordered to lead with install + project conventions; Tesseract
  / pdf.js / Gemma credited in the open-source list.

### Fixed
- Settings normalizer now persists the web-write confirm + robustness
  keys that were dropped during the route extraction.

---

## [0.1.5] - 2026-06-26

A broad security-hardening pass across the sandbox, egress, runner, agent
loop, dweb transport, and engine registries. This release also adds the
autonomous e2e verify loop and the groundwork for the peerd-lite and
personal-data directions. Every code change went through adversarial-swarm
review passes (security fixes held to a no-residual-bypass bar) and was
verified green before merge.

### Fixed
- **Notebook realm seal now covers the Cache API.** The sealed worker
  also runs headless in the offscreen `js_run` host. That host's CSP
  allows `https:`, so `connect-src 'none'` did not backstop there.
  `CacheStorage.{open,match,has,delete,keys}` are now sealed like the
  other network primitives, so no network verb is reachable (#72).
- **Web-write "approve for this session" is scoped to the consented
  host.** The non-GET egress confirm named a specific host but cached
  the grant by tool key alone, so one approval covered any host. The
  grant key now includes the host (#73).
- **Browser-runner prompt-injection hardening.** The disposable
  do/get/check runner's prompt now names the `<untrusted_web_content>`
  fence, calls out prompt injection as the attack vector, and adds an
  IGNORE → FLAG → EXCLUDE drill with anti-suppression language. 6
  contract tests cover each invariant (#81).
- **Stop is honored between tool-batch waves.** A Stop (or spend-limit
  halt) that lands mid-batch no longer lets queued write-tool waves
  dispatch and commit side effects after the abort. The loop rechecks
  before each wave and ends the turn as a deliberate stop (#97).
- **Agent-core input hardening.** Four edge cases from a security audit:
  the `@file` fence is defanged against break-out, the `load_skill`
  version attribute is escaped, the SSE parser caps its buffers to
  prevent OOM, and a non-string Anthropic `tool_use` name now surfaces
  an error instead of vanishing silently (#98).
- **dweb untrusted-inbound robustness** *(preview channel)*: guards on
  the transport that reads directly from anonymous peers. Drop
  unparseable data-channel frames and bound the pre-description ICE
  buffer (#88), cap the declared bundle size before buffering as an OOM
  guard (#89), make the DHT `node.handle` total over malformed RPC
  (#90), and close the `RTCPeerConnection` on an abandoned dial so it
  can't leak (#91).
- **Engine registry races.** Each registry's `load()` is now memoized so
  a cold-boot race can't drop a just-created record (#86), and Notebook
  default-resolution is serialized per session so concurrent
  first-commands don't double-create (#85).

### Added
- **Autonomous e2e verify loop.** `bun run e2e:verify` drives the real
  extension through every state on one Chrome (~6s). It writes a
  screenshot per state plus a structured `result.json`, and a diff image
  on a visual miss, so an agent can drive it unattended. Multi-turn,
  mode-toggle, and vault-lock states were added (#70, #77). The
  goal-state user-message assertion dropped in the consolidation was
  restored (#76). Per-run artifacts are gitignored (#74).
- **`peerd:std` record helpers.** `parseJsonl` / `toJsonl` / `dedupeBy`
  for line-delimited records in code-mode (#92).
- **peerd-lite groundwork.** A proof that the sealed Notebook substrate
  runs verbatim in a plain web page with only a host adapter, under
  `web-prototype/poc/` (#96). Also durable-OPFS round-trip coverage for
  the on-device personal-data index (#93).
- **Design specs.** The local-first personal-data agent (#92), the
  peerd-web / peerd-lite surface (#84), and the site-as-demo reuse plan
  (#87).

### Changed
- Reader-facing docs de-jargoned: tighter voice, AI-isms removed.

---

## [0.1.4] - 2026-06-24

Goal-mode hardening, side-panel state fixes, an end-to-end test tier, and
provider default-model selection. All changes were verified green and
reviewed by adversarial-swarm passes before merge.

### Added
- **Live-extension E2E tier.** A reusable raw-CDP harness with goal /
  stop / error scenarios. It runs the real chassis with the model faked
  at the wire, and it is wired into CI (#57). It also adds a local,
  npm-free visual-regression layer: self-contained PNG decode and pixel
  diff against committed baselines, deliberately kept out of blocking
  CI (#64).
- **Provider-aware default models** and WebVM terminal fixes (#62).

### Fixed
- **Goal-mode autonomous loop.** Durable Stop now reaches a
  vault-lock-paused run. Resume sequencing and cap-boundary correctness
  are fixed (#55). The Goal bar and Stop rehydrate when a surface
  connects or reconnects mid-run (#59). Goal-resume is ordered before
  auto-resume on interactive unlock, and durable-Stop is now awaited on
  steer, new-chat, and archive (#63).
- **Spend-limit halt banner** now persists across unrelated state pushes
  (Plan/Act toggle, `/system`, `/tools`, settings) instead of vanishing
  mid-halt (#54).

### Changed
- README embeds the demo video after the intro (#65).

---

## [0.1.0] - 2026

Initial **experimental preview**. The core buildout, integrated:

### Added
- **Providers.** Anthropic (streaming, adaptive extended thinking,
  prompt caching, retry), OpenRouter, keyless Ollama. Opt-in local
  WebGPU inference with one proven model, Gemma-4-E2B.
- **Security (egress).** Passphrase + WebAuthn-PRF vault, idle
  auto-lock, `safeFetch` allowlist, denylist, audit log.
- **Sandboxes.** Four execution kinds: WebVM (CheerpX), Notebook
  (sealed worker + OPFS), App (opaque-origin iframe), and the headless
  worker (`js_run`).
- **Agent runtime.** The agent loop and tool inventory (inspect,
  DOM/page via do/get/check, tabs, VM/Notebook/App, edit, subagents,
  memory, review, clock, web, skills), Plan/Act permissions, sessions,
  cost telemetry, voice (Moonshine + Web Speech), lineage-based context
  compaction, contacts.
- **The dweb** (`peerd-distributed`, preview channel only). Always-on
  P2P base network (mesh + DHT + gossip), did:key identity, signed
  content addressing, the dwapp bridge, and a peer-to-peer app store.
- **Distribution.** Dual store/preview channels, generated manifests,
  CI gates (bun tests, strict typecheck, lint, dweb boundary, drift,
  in-browser CDP job, artifact matrix).

[Unreleased]: https://github.com/NotASithLord/peerd/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/NotASithLord/peerd/releases/tag/v0.1.0
