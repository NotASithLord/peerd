# Changelog

All notable changes to peerd are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
**`0.MINOR.PATCH`** — minor = milestone, patch = fix, with
`store`/`preview`/`dev` channels as an orthogonal axis.

peerd is **0.x — experimental preview**: breaking changes are likely and
storage formats may move until the surface stabilizes.

## [Unreleased]

_Nothing yet._

---

## [0.2.0] — 2026-06-29

The big change is how peerd's agent is structured, landing with the
staged backlog of open PRs on one verified branch. Three things get
better:

- **Less context on the main agent.** Each environment's operating
  details (VM shell quirks, notebook isolation rules, app iframe gotchas,
  whether to fetch or render a page) used to sit in the main prompt on
  every turn, mostly unused. Now they live with the sub-agent that uses
  them and load only when work is handed off. The main agent also drops
  the web tools it no longer needs: web_search, read_article, call_api,
  and submit_form all fold into the web actor.
- **Fewer tool calls.** actor_list replaces five separate list tools with
  one, so the agent makes one call and carries one list instead of five.
  message_actor's oneShot skips a whole model turn when one round of work
  is enough.
- **Real isolation, not just convention.** The tools that operate
  environments are no longer on the main agent at all, so even a confused
  or prompt-injected agent can't reach them; it has to send a
  permission-gated message. Page text, fetch bodies, and command output
  stay inside the sub-agent and come back as a quoted, untrusted reply,
  never as raw text the agent could be steered by.

### Added
- **The actor architecture** (DESIGN-17 / DESIGN-18). The main agent now
  acts as an orchestrator. It opens an environment (a WebVM, a notebook, a
  built app, or the open web) and hands the work to that environment's own
  sub-agent, called an actor, which holds only that environment's tools.
  There is one way to delegate, message_actor. The web actor is the single
  entry point for all web work and picks per task between a sessionless
  fetch (fetch_url) and driving a real tab. Delegations run in the
  background and in parallel, show up as cards in the chat you can watch
  and stop, report their own cost, and survive a service-worker restart
  because pending work is written to storage.
- **API integrations (origin actors).** Send a message to a bare origin
  like api.github.com and peerd forms a fetch-only, keyless,
  origin-locked actor for it that remembers what it learns about that API
  across messages.
- **actor_list.** One tool that lists everything you can message: every
  WebVM, notebook, app, open tab, and API integration, each with its type
  and the handle to pass to message_actor. Replaces five separate list
  tools.
- **message_actor oneShot.** Set it when one round of work settles the
  request, like a specific command or a read. The actor does the action
  and hands back the raw result instead of spending an extra model turn to
  restate it.
- **PDF reading** (`read_pdf`) — pdf.js text-layer extraction in the
  offscreen document for born-digital PDFs; runner-only, output wrapped
  as untrusted web content.
- **On-device OCR for scanned PDFs** — render→recognize pipeline wired
  (Tesseract), `auto` escalates when a PDF looks scanned and the opt-in
  engine is installed. Fail-closed: falls back to the text layer until
  the driver is vendored and the asset SRIs are pinned.
- **Browser-native VM networking** — full HTTP, multi-host `git clone`,
  npm/pip/gem install via host-side resolution, response cache.
- **Session robustness** — auto-resume after a service-worker restart,
  per-message session store, provider failover chain.
- **Whole-extension type coverage** — `// @ts-check` across the
  extension (100% of eligible files), enforced by a coverage floor.
- **Verbose VM diagnostics** — `devMode` setting wires shell tracing
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

## [0.1.5] — 2026-06-26

A broad security-hardening pass across the sandbox, egress, runner, agent
loop, dweb transport, and engine registries, plus the autonomous e2e
verify-loop and the groundwork for the peerd-lite / personal-data
directions. Every code change was reviewed by adversarial-swarm passes
(security fixes held to a no-residual-bypass bar) and verified green
before merge.

### Fixed
- **Notebook realm seal now covers the Cache API** — the sealed worker
  also runs headless in the offscreen `js_run` host, whose CSP allows
  `https:`, so `connect-src 'none'` did not backstop there;
  `CacheStorage.{open,match,has,delete,keys}` are now sealed like the
  other network primitives, leaving no reachable network verb (#72).
- **Web-write "approve for this session" is scoped to the consented
  host** — the non-GET egress confirm named a specific host but cached
  the grant by tool key alone, so one approval became a blanket pass to
  any host; the grant key now folds in the host (#73).
- **Browser-runner prompt-injection hardening** — the disposable
  do/get/check runner's prompt now names the `<untrusted_web_content>`
  fence, calls out prompt injection as the attack vector, and adds an
  IGNORE → FLAG → EXCLUDE drill with anti-suppression language; 6
  contract tests lock in each invariant (#81).
- **Stop is honored between tool-batch waves** — a Stop (or spend-limit
  halt) landing mid-batch no longer lets queued write-tool waves dispatch
  and commit side effects after the abort; the loop rechecks before each
  wave and ends the turn as a deliberate stop (#97).
- **Agent-core input hardening** — four edge cases from a security audit:
  the `@file` fence is defanged against break-out, the `load_skill`
  version attribute is escaped, the SSE parser caps its buffers (no OOM),
  and a non-string Anthropic `tool_use` name surfaces an error instead of
  vanishing silently (#98).
- **dweb untrusted-inbound robustness** *(preview channel)* — guards on
  the transport that reads directly from anonymous peers: drop
  unparseable data-channel frames + bound the pre-description ICE buffer
  (#88), cap declared bundle size before buffering as an OOM guard (#89),
  make the DHT `node.handle` total over malformed RPC (#90), and close
  the `RTCPeerConnection` on an abandoned dial so it can't leak (#91).
- **Engine registry races** — memoize each registry's `load()` so a
  cold-boot race can't drop a just-created record (#86), and serialize
  Notebook default-resolution per session so concurrent first-commands
  don't double-create (#85).

### Added
- **Autonomous e2e verify loop** — `bun run e2e:verify` drives the real
  extension through every state on one Chrome (~6s), writing a screenshot
  per state + structured `result.json` (+ a diff image on a visual miss)
  an agent can self-drive; multi-turn / mode-toggle / vault-lock states
  added (#70, #77); the goal-state user-message assertion dropped in the
  consolidation was restored (#76). Per-run artifacts gitignored (#74).
- **`peerd:std` record helpers** — `parseJsonl` / `toJsonl` / `dedupeBy`
  for line-delimited records in code-mode (#92).
- **peerd-lite groundwork** — a proof that the sealed Notebook substrate
  runs verbatim in a plain web page (host adapter only), under
  `web-prototype/poc/` (#96); plus durable-OPFS round-trip coverage for
  the on-device personal-data index (#93).
- **Design specs** — the local-first personal-data agent (#92), the
  peerd-web / peerd-lite surface (#84), and the site-as-demo reuse plan
  (#87).

### Changed
- Reader-facing docs de-jargoned — tighter voice, AI-isms removed.

---

## [0.1.4] — 2026-06-24

Goal-mode hardening, side-panel state fixes, an end-to-end test tier, and
provider default-model selection. All changes verified green and reviewed
by adversarial-swarm passes before merge.

### Added
- **Live-extension E2E tier** — a reusable raw-CDP harness with goal /
  stop / error scenarios (real chassis, model faked at the wire), wired
  into CI (#57); plus a local, npm-free visual-regression layer
  (self-contained PNG decode + pixel diff against committed baselines;
  deliberately out of blocking CI) (#64).
- **Provider-aware default models** + WebVM terminal fixes (#62).

### Fixed
- **Goal-mode autonomous loop** — durable Stop that reaches a
  vault-lock-paused run, resume sequencing, and cap-boundary correctness
  (#55); Goal bar / Stop rehydrate when a surface (re)connects mid-run
  (#59); goal-resume ordered before auto-resume on interactive unlock,
  with durable-Stop now awaited on steer / new-chat / archive (#63).
- **Spend-limit halt banner** persists across unrelated state pushes
  (Plan/Act toggle, `/system`, `/tools`, settings) instead of vanishing
  mid-halt (#54).

### Changed
- README embeds the demo video after the intro (#65).

---

## [0.1.0] — 2026

Initial **experimental preview** — the core buildout, integrated:

### Added
- **Providers** — Anthropic (streaming, adaptive extended thinking,
  prompt caching, retry), OpenRouter, keyless Ollama; opt-in local
  WebGPU inference (one proven model, Gemma-4-E2B).
- **Security (egress)** — passphrase + WebAuthn-PRF vault, idle
  auto-lock, `safeFetch` allowlist, denylist, audit log.
- **Sandboxes** — four execution kinds: WebVM (CheerpX), Notebook
  (sealed worker + OPFS), App (opaque-origin iframe), and the headless
  worker (`js_run`).
- **Agent runtime** — the agent loop and tool inventory (inspect,
  DOM/page via do/get/check, tabs, VM/Notebook/App, edit, subagents,
  memory, review, clock, web, skills), Plan/Act permissions, sessions,
  cost telemetry, voice (Moonshine + Web Speech), lineage-based context
  compaction, contacts.
- **The dweb** (`peerd-distributed`, preview channel only) — always-on
  P2P base network (mesh + DHT + gossip), did:key identity, signed
  content addressing, the dwapp bridge, and a peer-to-peer app store.
- **Distribution** — dual store/preview channels, generated manifests,
  CI gates (bun tests, strict typecheck, lint, dweb boundary, drift,
  in-browser CDP job, artifact matrix).

[Unreleased]: https://github.com/NotASithLord/peerd/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/NotASithLord/peerd/releases/tag/v0.1.0
