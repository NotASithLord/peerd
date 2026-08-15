# Changelog

All notable changes to peerd are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning
is **`0.MINOR.PATCH`** (minor = milestone, patch = fix). The
`store`/`preview`/`dev` channels are a separate axis.

peerd is **0.x, an experimental preview**: breaking changes are likely
and storage formats may move until the surface stabilizes.

## [Unreleased]

### Added

- On-device WebGPU inference now supports more than one model. The engine,
  residency tracking, chat picker, and Settings cards are driven by a model
  registry instead of a single hard-coded model, so a new on-device model is a
  registry entry rather than engine surgery. Weights already downloaded on an
  existing install continue to be recognised without re-downloading.
- Muse Glimmer 30B is registered as an on-device model. It is listed and
  explicitly locked: the vendored Transformers.js carries no `muse_glimmer`
  architecture, and Settings says so instead of offering a download that would
  fail after streaming gigabytes. The lock lifts on its own once a runtime
  build carrying the architecture is vendored.

### Changed

- A local model download is refused up front when the vendored runtime cannot
  load its architecture, when another model is already downloading, or when the
  model id is unknown - each with the reason, rather than a failure mid-transfer.
- One on-device model is held in GPU memory at a time; requesting a different
  one unloads the previous model first and loads from cache, never silently
  answering from whichever model happened to be resident.

## [0.7.0] - 2026-08-12

### Added

- Apps and Notebooks now have browser-native Git history, branches,
  checkpoints, restore, diff inspection, and consent-bound Smart HTTP remotes.
  Repository operations quiesce live editors before touching the working tree.
- Pods add an ephemeral, isolated WASI shell for agent-driven command and file
  workflows. Cancellation, timeout, workspace ownership, and teardown are
  explicit terminal states rather than best-effort background cleanup.
- The preview dweb gains the cryptographic and runtime foundation for
  same-person device enrollment and private state restoration: rootless device
  grants, device certificates, private rendezvous, authenticated snapshot
  transfer, live custody wiring, and bounded partial-result reporting. The
  rendered enrollment controller and canonical hosted ceremony remain explicit
  release gates, so this is not presented as an end-user enrollment feature yet.
- Provider onboarding now verifies key shape and readiness before activation,
  with a first-run flow that does not reappear on established installations.

### Changed

- The composer, confirmation card, Stop state, onboarding, and narrow-sidebar
  layouts share the refreshed monochrome interaction system, with restored
  focus, clearer recovery actions, and expanded screen-reader coverage.
- App history and remote operations use the same mutation lanes and recovery
  contracts as the underlying OPFS workspace, including immutable approval
  targets and cleanup of repository data when an App is deleted.
- Self-device state transfer uses strict versioned schemas, authenticated
  unavailable-surface rows, deterministic byte identities, bounded caches and
  retries, and fail-closed completeness accounting.
- Release automation, dependency observation, package integrity, Firefox
  validation, and update-feed monitoring use tighter provenance and lifecycle
  gates.

### Fixed

- Closed portable-identity substitution, root-custody, revocation rollback,
  extension-origin, roster propagation, stale-offer, false-success, and
  post-cancellation mutation gaps found during adversarial review.
- Git remote approval can no longer authorize one origin and operate on a
  concurrently replaced origin; recent Notebook edits are flushed before
  version operations.
- Edited Apps receive a new byte-derived transfer identity, so a later restore
  cannot mistake changed content for an already-installed retry.
- Browser and actor lifecycle recovery now fences cold-start egress, private
  navigation, sign-in transitions, host loss, and stale async completions more
  consistently across Chrome and Firefox.
- Provider readiness survives worker restarts, preview updates avoid disrupting
  active work, and established vaults no longer regress into first-run setup.

## [0.6.0] - 2026-08-08

### Added

- Firefox actors now run in dedicated Worker heaps hosted by the MV3 background
  page. An acknowledged heartbeat detects host loss, revokes ambiguous work,
  pauses actor tools, and exposes an explicit recovery flow instead of silently
  replaying a side effect.
- Preview users can include the local dweb identity in a password-protected
  backup and restore it on another preview install. Identity replacement is a
  separate explicit action and remains blocked while local shares depend on the
  current identity.
- App packages preserve binary assets across creation, storage, export,
  sharing, installation, and execution.

### Changed

- Code is now the primary contract for compound actor orchestration. A single
  capability manifest drives scoped clients, relay authorization, prompt
  kernels, traces, deadlines, and cancellation; `message_actor` remains the
  lightweight scalar path.
- Preview and dev web actors default to the sealed `page_code` surface and may
  persist origin-pinned API clients. Store builds retain the discrete tool
  surface, and every channel falls back safely when the full code grant is not
  available.
- Store and web builds now refuse direct remote JavaScript imports without
  requesting the module source. Preview keeps the audited literal static path.
- Trusted spawned actors can orchestrate delegation from JavaScript when both
  `script` and `message_actor` are explicitly granted. Bound environment actors
  remain pinned and cannot cross-delegate.
- Release CI now exercises the installed extension on current Firefox and
  dispatches peerd.ai feed deployment after publishing. Repository copy hygiene
  is enforced as a release gate.

### Fixed

- Firefox bound actors remain keyless across the Worker boundary, actor-code
  relays re-check sender and owner provenance, and App sandboxes can no longer
  escape through page-initiated network paths.
- Reviewer file grants are revalidated against live read-only policy, saved-App
  search results are fenced as untrusted, and `fetch_url` inspects headers and
  request bodies for off-origin exfiltration attempts.
- Narrow Firefox sidebars keep authority controls visible and accessible, while
  stale model-catalog responses can no longer overwrite the current selection.

## [0.5.0] - 2026-08-06

### Added
- **Interrupted work can recover instead of disappearing.** peerd now
  records the lifecycle of operations and reconciles them after a
  service-worker restart, browser interruption, or execution-host loss.
  Recovery distinguishes safe retries from writes that need confirmation,
  restores durable resources where possible, and reports what resumed,
  stopped, or needs attention instead of silently repeating an action.
- **Credentials can be usable without being readable.** Origin credentials
  may now be bound to a non-extractable vault key and presented with DPoP
  proof-of-possession. RFC 9449 server nonces are handled across retries, and
  the implementation is exercised through Firefox as Firefox rather than
  relying only on Chrome-compatible behavior.
- **Office documents and ebooks are first-class inputs.** Attachments and
  `read_doc` accept Word, Excel, PowerPoint, OpenDocument, RTF, EPUB, and CSV,
  converting their structure to Markdown locally. Parsing is format-sniffed,
  bounded, hardened against archive and XML abuse, and keeps document bytes
  out of the model context when only extracted text is needed.
- **The JavaScript workspace grew into a durable agent workbench.** `script`
  can use a per-session workspace, pageable run results, Markdown extraction,
  audited remote imports with optional integrity pins, keyless sub-model
  calls, and reusable agent-authored toolbox modules. The same work improves
  module resolution, failure reporting, and Stop behavior without widening
  the authority of page, site, or peer lanes.
- **The web actor can initiate safe, user-driven sign-in.** A new Tier 0
  `login` tool recognizes passkey and known identity-provider affordances,
  verifies the live origin, and always asks the user before proceeding. It
  never fills a password or stores a token; ambiguous or unverified targets
  fall back to an assisted-manual handoff rather than an automated click.
- **The denylist has a browser-level backstop.** Session-scoped declarative
  network rules protect only the tabs peerd is actively driving, catching
  page-initiated navigation and App traffic that bypass the ordinary fetch
  gate. A higher-priority identity-provider corridor preserves legitimate
  sign-in redirects, and browsers without the API retain the previous
  policy-gate posture.

### Changed
- **Tool calls are cheaper to describe and easier to recover from.** Stable
  prompt content can now remain cacheable, authored failures reach the model,
  file edits diagnose already-applied and ambiguous changes, large reads page
  consistently, and repeated guidance is injected once per session. Tool
  error and wasted-turn metrics were added to the evaluation surface.
- **Settings are easier to scan.** Behavior controls use consistent setting
  rows and the denylist is grouped into meaningful sections with visible
  state, while preserving the monochrome brand system and both visual themes.
- **Release and dependency integrity are stricter.** CI pins third-party
  actions, verifies vendored bytes and reproducible packages, checks source
  hygiene and architectural invariants, emits separate artifact digests, and
  attests release provenance before the irreversible Firefox signing upload.

### Fixed
- Closed prompt-injection blast-radius gaps in the sealed worker, inbound
  actor delegation, API-origin credential pinning, redirected PDF fetches,
  private-network classification, persistent prompt inputs, and dweb inbound
  rate limiting.
- Closed follow-up findings in origin segmentation, credential routing, and
  lifecycle wiring, including cases where untrusted or stale state could
  cross an ownership boundary or survive an interrupted turn incorrectly.
- Visual regression reporting now computes a real merge-base "before" image
  for newly added states and waits for first-run Library seeding before it
  captures the full-page home.

## [0.4.0] - 2026-08-01

### Added
- **The toolbar button opens the side panel.** Clicking peerd used to
  take over a whole tab with the full-page home, so the first click of
  a session landed on a full-tab vault gate instead of next to the page
  you were already on. It now opens the side panel (the sidebar on
  Firefox) by default, and Settings, Behavior, Toolbar button switches
  it back to the full-page home. On Chrome the choice is mirrored into
  the browser's own action-click behavior, so the panel opens natively
  before the service worker even wakes and the default can never race a
  cold start. One consequence of that native path: for panel users the
  icon becomes a toggle, which is the platform convention. The keyboard
  shortcut still always toggles the panel, whichever default you pick.
- **You can see which tab peerd is driving, and what it is doing in
  it.** The driven page joins a collapsible peerd tab group for as long
  as peerd owns it, so a glance at the tab strip says which tab is not
  yours to touch right now. Inside that page, a small corner pill names
  the current action, shows the origin, and carries a Stop button,
  softening to "Thinking..." between calls so a slow step never reads
  as a hang. The pill is invisible to peerd itself, by three
  independent measures, and its wording comes from a fixed vocabulary:
  never the text being typed, never page-authored labels or selectors,
  and only the host of a navigation rather than the full URL.
- **The orchestrator can wait for a delegation when it needs the
  answer to speak.** `message_actor` takes an opt-in `await`, which
  resolves the actor's fenced reply into the tool result so peerd
  answers in the same turn instead of ending on "I'll report back".
  Delegation stays async by default, which is still the only shape that
  fans out. The wait is bounded: past a wall-clock cap it degrades back
  to the ordinary later-turn reply without cancelling the actor, so a
  slow delegation is never a lost one. Stop still ends delegated work,
  and steering mid-wait now keeps the actor running and lands its reply
  on the turn you steered into, rather than discarding the work.

### Changed
- **The visual gallery is Markdown and rides every pull request.**
  GitHub serves a committed `.html` file as source text, so the gallery
  was unreadable in the one place people actually browse the repo. It
  is now `scripts/cdp/GALLERY.md`, which renders natively, and the
  visual job posts a single sticky comment on every PR linking it with
  a drift verdict, rather than speaking up only when the render broke.
  Contributor-facing only; nothing in the extension changes.

### Fixed
- The in-page activity pill is taken down at the end of an actor turn
  on Firefox too, where turns run in the service worker rather than an
  offscreen worker. It previously outlived the turn there, parked on
  "Thinking..." indefinitely.
- peerd's system prompt described delegation as always asynchronous,
  which contradicted the new opt-in wait on the same decision and left
  the model with two conflicting statements of the delegation contract.

## [0.3.0] - 2026-07-31

### Added
- **The security boundary arc.** Web helpers are now origin-segmented:
  each one is either roaming, browsing freely while holding no
  authority, or bound to exactly one origin. The landing rule judges
  where the tab actually ended up, so a redirect cannot smuggle a
  roaming helper onto a credentialed origin. Sensitive origins are
  learned rather than only listed: a curated seed, any origin with a
  stored key, plus two signals from ordinary use, a walked password
  field and an approved write. Page text is disarmed before it reaches
  the model, with zero-width runs, bidi overrides, and Unicode tag
  characters stripped, leaving Persian, Urdu, and Indic text
  unaffected. Acting as you on a page strangers wrote asks first, even
  with confirmations off, and an exfiltration tripwire watches both the
  navigation and the actor's own fetch, including in the zero-tab
  state. Accepted residuals are written down in the security docs as
  R14 through R17.
- **The Claude redesign.** The side panel gets a design-token system, a
  mono-stroke SVG icon set, the operator-cyan user bubble, a segmented
  monochrome Plan/Act row, restyled tool, reasoning, todo, and goal
  cards, and a sealed-surface lock mark on the vault gate. The brand
  rule holds: the five color carriers plus failure red are still the
  only color on the surface.
- **The reviewer can read the files around a diff.** The clean-context
  review actor may now call `js_read_file`, `app_read_file`, and
  `app_list_files` through a positively scoped exemption admitted for
  exactly those three names and no wider, on the Chrome offscreen path
  as well as the in-service-worker fallback. The grant is a positive
  allowlist intersected with the read-tagged set, so it fails closed
  for every future tool, and the reviewer's summary comes back fenced
  as untrusted.
- **A web build target.** `bun run package:web` cuts the library form of
  the packaging core, with `bun run check:web` gating its boundary in
  preflight and CI. No demo shell, and no `peerd-distributed`, a
  posture that is pinned by test.

### Changed
- **Apps can be 50M chars, up from 2M.** The write-layer backstop was
  the real ceiling on every App path, `sandbox_create`, `.peerd`
  import, and `dweb_install` alike, even though the dweb loader already
  accepted 50M across 256 files. A real dwapp ships a WASM runtime plus
  a 3D engine, and binary assets ride as base64 today, so 2M made the
  big ones un-importable by any route.

### Fixed
- **Watch mode no longer steals focus when nobody is watching.** An
  adversarial audit found four ways the follow could pull your window
  over. A parked home tab satisfied "a peerd surface is open" forever,
  so only a side-panel port counts now. The browser could be hauled in
  front of another application, so a Chrome-focus gate was added. The
  "already in front" no-op check was dead after any service-worker
  respawn and never matched in the two-window layout watch mode
  encourages, so it is now resolved from live tab state per call. And
  every settings write re-fired the follow, so picking a model hours
  later teleported you onto a long-dead agent tab. The follow now fires
  only when the agent tab actually changes.
- **A single oversized gossip envelope can no longer amplify across the
  mesh.** The token bucket counts frames, so it was blind to one huge
  envelope, which every member re-broadcasts untouched and the sync
  layer then retains and re-serves to every peer on every new link. A
  32 KiB per-envelope cap is now enforced at every door an envelope can
  arrive through, our own publish included, and the size check runs
  before signature verification. Preview channel only.
- **A Library avatar keeps its color.** The hue hashed the per-install
  instance id, so an identity changed color on reinstall. It now
  hashes a durable identity instead.

## [0.2.8] - 2026-07-19

### Added
- **Watch mode.** A top-bar toggle that brings the agent's current tab
  to the foreground and follows it as the agent moves between tabs, so
  you can watch the real page live with the chat docked beside it. The
  agent normally drives its tab in the background and never steals
  focus; this is the opt-in inverse for when you want to see it work.
  Off by default, both channels.
- **Routines: background scheduling.** A standing task can now run in
  the background on a cadence, on an interval ("every 6h") or at a
  daily local time, even with the side panel closed. New
  `schedule_create` / `schedule_list` / `schedule_cancel` tools; each
  firing runs in its own fresh session as an autonomous goal loop (or a
  single turn). A routine that came due while peerd was locked or the
  browser was off fires once as soon as peerd is back on, never as a
  burst, and nothing fires while the vault is locked.
- **Prewalk (experimental, off by default).** A goal run can open on
  the frontier chat model, which writes a todo plan and lands the first
  action, then hand the live context to a cheaper executor model that
  grinds out the rest. Comes with a session-persisted todo checklist
  the goal prompt re-surfaces on every continuation (rendered as a live
  card that ticks as the run works), a sticky Goal toggle that stays
  lit for the whole run (clicking it stops the run), and Lab A/B arms
  that measure spend, pass rate, and speed baseline-vs-prewalk. VM,
  Notebook, and App actors get the same swap under their own toggle:
  the first turn plans on the frontier model against real instance
  state, later turns run on the cheap executor.
- **Site clients.** The web actor can derive, persist, and replay a
  per-origin API client (a prose dossier plus a JS module) so future
  work against a site calls its API directly instead of re-driving the
  DOM. A client is treated as an unreliable cache: verified on use,
  self-healed on failure, and saving one always crosses a user confirm.
  It executes in the sealed keyless worker with exactly one outward
  edge, a fetch pinned to the client's own origin. Capture-assisted
  derivation works on every channel, with credentials redacted to
  posture markers at the boundary.
- **Query-relevant excerpts for oversized pages.** `fetch_url` and
  `read_page` take an optional `query`; when a long page overflows the
  window, the model now sees the passages that best match what it was
  looking for (BM25-ranked, reassembled in document order) instead of a
  blind head-and-tail slice. The full text stays stored and pageable
  via `read_web_cache`, and without a query behavior is unchanged.

### Changed
- **The web actor finishes the action and reports the substance.** Two
  prompt additions targeting the two most common failure shapes in the
  benchmark taxonomy: stopping one step short of the required action,
  and finding the answer but replying with a pointer instead of stating
  it. Measured +6.7 points on Online-Mind2Web against a matched control
  on both models tested.

### Fixed
- **Agent typing no longer steals OS focus.** Key dispatch raised the
  driven tab's window to the foreground on every call, continuously
  yanking focus from whatever you were doing. The tab now gets CDP
  focus emulation instead: the page believes it is focused, so
  shortcut handlers still work, but the window is never raised.
- **A hung tool call can no longer wedge a turn forever.** Every tool
  dispatch now races the turn's Stop signal and a hard deadline, the
  CDP evaluate leaf gets its own timeout, and a watchdog force-releases
  the turn slot after a grace period, so Stop works mid-dispatch
  instead of only between tool waves.
- **Stop now terminates an in-flight `a2a_run`.** The mesh-code worker
  used to keep running to its wall clock after the turn aborted,
  holding one of the shared headless job slots for up to two minutes.
- **The OpenAI adapter no longer makes a futile network call every
  turn.** It fetched `/v1/models` each turn to read a context-window
  field that endpoint does not have, so the call could only ever return
  nothing; the static window table (which always supplied the real
  value anyway) is now used directly.

## [0.2.7] - 2026-07-10

### Added
- **Z.ai GLM as a BYOK provider.** Use GLM-5.2 (and the rest of the GLM
  lineup) directly from z.ai, not routed through OpenRouter. Z.ai's API is
  OpenAI-compatible, so the adapter is a thin sibling of the OpenRouter one:
  same wire format, different base URL and key shape. Shows up in
  Settings under Providers.
- **`fetch_url` returns clean markdown by default.** HTML is converted with
  vendored Readability and Turndown, running in the offscreen document,
  instead of handing back raw page source. Non-article pages, Firefox
  (no extraction client there), or an extraction error all fall back to
  today's raw behavior. An oversized body no longer silently loses its
  tail: it spills to a local cache and the model sees a head and tail
  window with a note on how to page through the rest with the new
  `read_web_cache` tool.
- **`read_page` gains `mode:'content'`.** It grabs the rendered DOM after
  JavaScript has run and routes it through the same extraction and paging
  pipeline `fetch_url` uses, so a tab-driven task gets the same clean
  markdown a fetched page does. The default snapshot mode (interactable
  elements for clicking and typing) is unchanged.
- **An experimental code surface for the web actor** (default off, opt-in
  under Settings → Behavior). Instead of one tool call per action, the
  actor can write Playwright-style JS against a sealed `page.goto` /
  `click` / `fill` / `snapshot` bridge, with the same gated dispatch,
  denylist, and audit as the normal tool-call path underneath. Measured
  against the tool-call path on the Online-Mind2Web benchmark it did not
  win (26.7% vs 20.7%, more steps, more step-cap failures), so tool calls
  stay the default; the code surface ships anyway because a real
  benchmark harness for a browser-extension agent came out of building it.

### Fixed
- **A "New chat" mid-task could leave an abandoned actor still running.**
  Resetting a session now stops its live turn and cascades the stop to
  every actor it had spawned, the same way the Stop button already does.
- **A spent Z.ai account retried instead of failing over.** Z.ai reports
  out-of-credit as an HTTP 429 with its own error code, which the retry
  classifier didn't recognize, so a drained account burned three retries
  before giving up instead of switching providers.
- **GLM-4.6 was priced about three times too high**, which could trip a
  spend limit early or inflate the cost display for no reason. Corrected
  to its published rate.
- **An OpenAI streaming error could be blamed on OpenRouter** in the
  error text, since the shared stream parser wasn't told which provider
  it was reading for.
- **A few research-preset tool manifests were missing `read_web_cache`**
  even though they allowed the tools that produce a spillable body, so a
  paged-out fetch or page read left the model unable to read its own
  overflow, burning turns on a call the manifest then refused.
- **`read_page`'s content mode could truncate silently.** A render past
  its size cap now says so explicitly instead of reporting `truncated:
  false` on a body that was actually cut.
- **The cache-eviction message for a paged-out read pointed at the wrong
  fix.** It told the model to re-fetch the URL, which for a rendered
  page throws away the post-JavaScript DOM it already had; the hint is
  now specific to how the content was originally captured.

## [0.2.6] - 2026-07-06

### Fixed
- **A web actor could be wrongly refused a read of its own tab.** The
  dispatcher gate that pins a web actor to the one tab it owns compared an
  explicit `tabId` argument against `actorInstanceId`. That field is the
  fixed literal `'web'`, the actor's stable `message_actor` address, not a
  tab id (only an API actor's instanceId is still a real identifier, its
  origin). So the comparison could never match, and any DOM tool call that
  named its own tab explicitly (`read_page`, `click`, and so on) was refused
  with a confusing "pinned to tab web" error, even though it was the actor's
  own tab. The gate now compares against the actor's actually-owned tab
  instead. This was a false-positive refusal, not a security gap: the
  independent execute-time resolver already only ever targeted the owned
  tab or failed closed.
- **The search shortcut in the web actor's own prompt pointed at a URL that
  always redirects.** The prompt told the actor to search with
  `fetch_url https://duckduckgo.com/html/?q=...`, but that path 302s to
  `html.duckduckgo.com`, and `fetch_url` does not follow redirects (by
  design: see `docs/security/THREAT-MODEL.md` INV-7). Every search burned a
  turn on a guaranteed redirect error before the actor retried correctly.
  The prompt now names the right host (`html.duckduckgo.com/html/?q=...`)
  and says why the bare host fails, so search works on the first try.
- **A oneShot delegation whose CODE crashed now gets its recovery turn.**
  The oneShot contract always said "an errored round falls through to the
  normal loop", but the clean-round test only saw tool-LEVEL errors, and a
  notebook eval whose code threw (a CompileError, a bad import) returns
  ok:true with the `[ERROR]` text as its content. So the crash
  short-circuited straight back to the orchestrator as the raw reply and
  the actor never debugged its own sandbox (field transcript: a notebook
  actor bounced the same CompileError back twice). `js_notebook` now marks
  such results `evalError` and the one-shot latch disarms on it, exactly
  like a tool failure: the actor recovers and iterates, as promised. A
  headless CI test also now pins `peerd:wasi` + `demoModule()` as
  importable and runnable from a `script` job (a field session reported
  the import unreachable; current source proves green, so a stale install
  is the likely culprit, reload the extension).

### Added
- **`peerd:wasi` ships a self-test module.** `demoModule()` (exported next
  to `runWasi`) returns a tiny (187-byte) known-good wasm32-wasi hello
  module, embedded in the extension, so the agent can smoke-test
  `runWasi(demoModule())` inside the sealed worker with no network and no
  toolchain, instead of hunting the web for a working binary (a live
  session burned itself on exactly that hunt). The blob is hand-assembled,
  regenerable from `tests/notebook-tab/wasi-test-module.ts`, and the bun
  suite pins the embedded bytes against that builder so blob and source
  cannot drift. Taught in the `script` / `js_create` lore and the code-mode
  prompt.

### Fixed
- **`resp.bytes()` works in sandboxed code now.** The sealed-realm fetch
  bridge (Notebook / script / a2a runs) listed `bytes` on its response but
  as a raw data property, so `resp.bytes()` (the platform `Response.bytes()`
  shape every model reaches for) threw "not a function". It's a method
  returning `Promise<Uint8Array>` now, matching the platform. Found in the
  field: an agent burned several turns rediscovering `arrayBuffer()` while
  smoke-testing `runWasi`.
- **The web actor no longer talks itself out of rendering.** Field
  transcript: asked for live sports schedules, the web actor tried fetches,
  declared itself "fetch-only", claimed it lacked an open-tab tool, and
  bounced the task back to the user, while the render path was fully wired
  (`navigate` lazily opens + adopts its tab in the 0-tab state). The
  machinery was right; the words were wrong. Three model-facing fixes:
  `navigate`'s description now states it OPENS the tab when the actor owns
  none (it read "navigate the target tab", implying one must exist); the web
  actor's lore states it can ALWAYS render and must never report itself
  fetch-only; the shared actor rules forbid addressing the user ("would you
  like me to…" has no one to answer it, do the work or report what
  blocked). And the orchestrator's `message_actor` teaching now says: never
  narrate unobserved actor progress, and re-send with the capability
  restated when an actor wrongly claims its kind can't do something.

### Changed
- **"Subagent" is now "actor" everywhere.** The heap-split already made a
  subagent an ephemeral actor on the same substrate as the bound (sandbox /
  web / dweb) actors; the vocabulary now matches. Model-facing: the
  `spawn_subagent` tool is **`actor_create`**, `subagent_cancel` is
  **`actor_cancel`**, `subagent_tasks` is **`actor_tasks`** (pairs with
  `sandbox_create`: a sandbox always has a dedicated bound actor;
  `actor_create` alone makes an ephemeral one). Internally the
  `peerd-runtime/subagent/` module is `peerd-runtime/actor/`, and the
  spawned-child concept keeps a distinct name where it must not collide
  with bound actors: session kind `'subagent'` is now **`'spawned'`**, and
  the child transcript stream is `turn/spawned-*`. Breaking for stored
  sessions from earlier builds (0.x posture: no migration shims): old
  `kind:'subagent'` records and skills/evals naming `spawn_subagent`
  need the new names.

## [0.2.5] - 2026-07-05

### Security
- **Three residual risks from the threat model narrowed before wider
  exposure** (R4/R5/R6, each documented honestly in
  docs/security/THREAT-MODEL.md):
  - **The audit log is tamper-evident now.** Every entry extends a SHA-256
    hash chain, and a head record pins the newest link. Rewritten, deleted,
    inserted, or truncated entries fail verification. The debug bundle runs
    the verification and stamps the result into its provenance. This is
    evidence, not proof: in-origin code execution can still recompute the
    chain. That boundary is stated, not hidden.
  - **Session confirm grants are origin-bound.** "Yes for this session" now
    means this tool ON this origin. Approving `click` on one site no longer
    silently covers every site the chat visits. This generalizes the host
    scoping web writes already had.
  - **Transfer import is gated.** Imported provider endpoints must be https
    (or local loopback) and are named in the summary the user approves.
    Imported hooks land DISABLED and untrusted until re-enabled per hook in
    Settings. A memory import states its prompt-injection consequence in the
    apply notices.

### Added
- **Standing peer conversations on the mesh** (preview only). The dweb
  actor's agent-to-agent surface was single-shot: one ask, one reply, the
  thread forgotten. An inbound peer message only ever reported to YOU,
  never back to the peer. Now a conversation is a THREAD. `mesh.converse(did,
  message)` opens one and returns a `convId`. A later peer message on that
  thread wakes the dweb actor WITH the prior turns as context, and the actor's
  answer goes BACK to the peer. The reply-to-a-peer edge is the owner-chosen
  gate: per-conversation reply consent (approve once per thread, revoke by
  blocking the peer). `mesh.say(convId, message)` continues a thread from code.
  The convId threads through the wire envelope. A convId is a bearer token, so
  only its owning did may extend it. The thread store is capped and TTL-evicted
  (a peer can't grow SW memory). `dweb_block` closes every thread with that
  peer. Proven over real WebRTC by the two-peer harness (converse → the peer's
  reply threads the convId back → say continues it).

### Added
- **OpenAI provider adapter.** Direct BYOK access to OpenAI's own API
  (`api.openai.com`), distinct from reaching OpenAI models through the
  OpenRouter gateway. A user with an OpenAI key and no OpenRouter account
  now gets first-class access, billed to their OpenAI account. The wire
  format is the reference OpenAI `/chat/completions`, so it reuses the same
  request/response formatters as the OpenRouter adapter (retry set, hard-limit
  fast-fail, streaming). The key attaches at fetch-header time and never
  enters the request body. It shows up in Settings → Providers with the current
  GPT-5.x flagships seeded in the picker. The manifest already covered the
  host via `<all_urls>` + the `https:` CSP, so nothing new is requested.
- **The debug surface: serious observability without a vendor.** peerd's
  chain of events was already recorded (audit log, lineage, delegation
  traces) but trapped across surfaces. Now it comes OUT, locally, on the
  user's say-so. Three pieces:
  - **Debug bundle export**: a chip-sized `debug` button in the chat mode
    row saves one JSON file per session. It includes the full transcript
    INCLUDING every descendant actor/subagent session (the delegation tree,
    walked by parent links), the audit slice for that set, cost, a settings
    snapshot (keys can't appear, they live only in the vault and attach at
    fetch-header time), live context snapshots, a classified failure index,
    and a provenance block that says plainly what may be missing (pruned
    audit, evicted snapshots). The same data exports as an **OpenTelemetry
    trace** (OTLP/JSON, delegation = span parentage, gen_ai semconv
    attributes) for any OTel viewer the user already runs. It is converted in
    the panel from the same payload, with no second route, no wire, and no
    vendor.
  - **Failure-class chips**: every failed tool card and failed turn now
    carries its classified failure neighborhood (policy / auth / limits /
    provider / timeout / aborted / environment / agent / internal) as a
    small chip next to the raw error, so triage starts at "whose fault,
    roughly" instead of string-parsing. The same classifier annotates the
    bundle and stamps OTel span status.
  - **The context inspector** (dev mode): "what did the model actually
    see?". The service worker keeps a small in-memory ring of shaped
    request snapshots per session (system prompt clipped, messages capped,
    binary payloads stripped with a visible sentinel), captured at the two
    seams that together cover every model call: the orchestrator's turn
    driver and the actor/subagent relay route. A modal lists each call
    (who, model, sizes, content) and is honest about the ring's lifetime:
    it empties with the service worker, and says so.
- **The orchestrator delegates from code: `script` grows an `actors` client.**
  The same bet that gave the web actor and the mesh their code surfaces now
  reaches the orchestrator itself. Inside the `script` tool (the renamed
  `js_run`, the generalized name models actually reach for), code can
  `await actors.ask(to, goal)` to delegate and get the reply back as a value,
  `actors.send(to, goal)` to hand off without waiting, and `actors.list()`
  for the roster. Fan-out and plumbing move into one script: ask several
  actors at once, feed one's output into the next as a variable. Intermediate
  bytes never transit the orchestrator's context at all, which is both a token
  win and a deepening of the isolation thesis.
  Nothing new is trusted: every delegation runs the full message_actor gate
  chain per call (sender gate, rate caps, duplicate-intent, the oneShot
  sandbox rule, audit), the worker can never spoof whose behalf it acts on
  (owner identity rides trusted job params), and a script that delegated has
  its output fenced (actor replies are untrusted bytes).
  **Observability is the contract, not an afterthought**: every run returns a
  [DELEGATIONS] trace (op, target, outcome, timing, with failed-op detail
  fenced) that survives script errors, timeouts, and Stop. The side panel
  streams a live per-delegation feed on the script card while it runs. Each
  op lands in the audit log tagged via:script. Stop actually unwinds the
  whole fan (pending asks abort, their actor turns die, the worker is
  terminated). Proven end to end by a live e2e state: one script, a real
  web-actor round trip, the reply resolving into the running code.

## [0.2.4] - 2026-07-05

### Changed
- **`oneShot` delegation is sandbox-only now.** `message_actor`'s oneShot mode
  (skip the actor's summary turn, hand the raw result straight back) is
  honored only for the agent's own engine sandboxes (webvm/notebook/app) and
  refused loudly for every other target. The summary turn is what
  incidentally compresses untrusted content, so a web/API/dweb reply always
  comes back summarized. The orchestrator prompt now actually teaches the
  shortcut ("run `pytest`" → oneShot:true) instead of leaving it buried in
  schema fine print, where models (small local ones especially) never
  found it.

## [0.2.3] - 2026-07-05

### Added
- **Agent-to-agent over the mesh (A2A): the dweb actor talks to other
  agents by writing code** (preview only). The same bet as the web actor
  applies: models write a short script more fluently than they fire one
  gated action per turn. The dweb actor drives peer conversations through a new
  `a2a_run` tool: it writes JS against a `mesh` client (`mesh.peers()`,
  `mesh.card(did)`, `mesh.ask(did, msg)`, `mesh.send(...)`,
  `mesh.publishCard(...)`, `mesh.inbox()`) and returns the outcome. `ask`
  sends a request-tagged direct message and awaits the peer's one reply; an
  Agent Card advertises what your agent can do and is discoverable by other
  peers. The data model rhymes with Google's A2A (Agent Card, message shape)
  so future interop is a thin adapter, but the transport is the mesh, the
  address is a did:key, and the reply stream is the fenced inbound wake, not
  A2A's HTTP+SSE. The code runs in the same sealed, keyless worker as
  `js_run` with one added capability, the mesh bridge, and nothing else: an
  a2a run gets no egress and cannot spawn subagents. First contact to a peer
  (and advertising your own card) needs your explicit ok, remembered per did
  and revocable by blocking the peer; peer replies and cards are always
  fenced as untrusted. It's a dweb-actor tool only: the orchestrator never
  holds it, and the store build prunes the whole surface. Hardened after an
  adversarial re-review: the Agent Card size/field caps are enforced on both
  the publish and fetch paths, first-contact "Allow once" is a genuine
  one-shot (only "Allow for session" persists, and blocking a peer revokes
  it), and the ask/reply round-trip is now covered by a live two-peer
  WebRTC test.

### Changed
- **The orchestrator's tool surface got a hard slim: 27 → 18 always-on.**
  Three moves, one rule: the main agent bootstraps and delegates, and every
  instance byte stays behind an actor heap.
  - **The engine file READS are actor-only now.** `js_read_file`,
    `app_read_file`, and `app_list_files` had stayed on the orchestrator as
    fenced "cheap reads". But an instance file is not reliably
    agent-authored (notebook/app code fetches and persists web data), so even
    a fenced read handed untrusted bytes to the orchestrator's context. The
    convenience broke the isolation premise. Reads now ride the instance's
    actor like every other op.
  - **One `sandbox_create({ kind })` replaces `vm_create` / `js_create` /
    `app_create`.** Same bootstrap, one tool: the webvm/notebook/app taxonomy
    is laid out side-by-side in a single description where the model actually
    picks, instead of repeated across three. The per-kind create behavior is
    unchanged (background tab, go-there card, chat's current, id returned),
    and the durable-handle harvest still records which kind an id is (the
    result stamps `kind`; the compaction/trim extractors read it).
  - **The instance-gating ("progressive disclosure") machinery is deleted.**
    Every op it deferred is actor-only now, so it had nothing left to gate.
    Its "create one first" refusal for a premature call was the wrong
    message anyway; the honest answer is "that's the actor's tool".
- **The five `inspect_*` introspection tools became one `inspect`.**
  `inspect_provider_config`, `inspect_storage`, `inspect_session_access`,
  `inspect_denylist`, and `inspect_audit_log` were five near-identical
  read-only tools; they collapse into a single `inspect({ kind })` (kinds:
  `provider_config` / `storage` / `session_access` / `denylist` /
  `audit_log`), exactly the way `actor_list` folded the per-kind list tools
  into one. Behavior per facet is unchanged (same outputs, same audit-log
  subagent-error redaction), but the main agent's tool surface shrinks by
  four, sharpening tool selection. Existing `/tools` presets that named the
  old tools now name `inspect`.
- **The service worker is slimmer and the worker bridges are unified.** Two
  internal refactors, no behavior change. The four hand-rolled worker↔host
  bridges (OPFS, subagent, base-network reads, the a2a mesh) collapse into a
  single factory, so adding the next one is a one-liner. And the service
  worker sheds the clusters that were logic rather than wiring: the model
  picker's catalog, the tab-strip affordances, and a couple of pure actor
  kernels now live in their own small, tested modules, keeping the service
  worker to assembly and routing.

### Fixed
- **WebVM now degrades gracefully on Firefox instead of showing a
  misleading error.** The in-browser Linux VM (CheerpX) needs
  `SharedArrayBuffer`, which the browser grants only to a cross-origin-
  isolated page, and a Firefox extension page can't isolate itself
  (a Firefox platform limitation, not a peerd bug). The VM boot screen used
  to fail with a "manifest must declare cross_origin_embedder_policy" error
  that read like a config bug; on Firefox it now shows a plain-English notice
  explaining the limitation, noting WebVM works in the Chrome build, and
  linking the two open upstream threads (Bugzilla 1673477 and the W3C
  WebExtensions issues) to push on.

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

[Unreleased]: https://github.com/NotASithLord/peerd/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/NotASithLord/peerd/compare/v0.6.0...v0.7.0
[0.1.0]: https://github.com/NotASithLord/peerd/releases/tag/v0.1.0
