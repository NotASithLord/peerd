# DESIGN-17 P0 — dev notes (as-built)

Implementation record for DESIGN-17 P0 "actor tab agents"
(`DESIGN-17-actor-agents.md` is the design; this is what landed and why).
The actor model is **UNCONDITIONAL** — the original `ACTOR_TAB_AGENTS` +
`WEB_ACTOR` source flags were removed (owner call: "the branch is the flag;
this is introduced wholesale or not at all"). The gate/descriptor/prompt/
orchestrator changes are the live reality for every build (store/preview alike),
so the release decision when this merges is the whole feature, not a flag flip.

## What landed (the P0 deliverables)

- **`kind:'actor'`** — third `SessionKind`. An actor self-describes via two
  REVERSE-pointer fields on its session record (`instanceId`, `actorType`);
  the FORWARD pointer (`actorSessionId`) lives on the engine registry record.
- **The capability tier** (`tools/exposure.js` + `tools/gates.js`):
  - `ACTOR_MUTATING_TOOLS` — the tiered set, refused for any non-actor ctx.
  - `actorAllowedTools(kind)` — the actor's POSITIVE allow-list (refuses any
    non-kind tool from an actor — keyless/narrow runner model).
  - The per-instance pin (default-inject the bound id in the turn-driver wrapper;
    gate-reject a mismatching explicit id).
  - `actorTierGate` is a pure, flag-INJECTED function so the boundary proof
    holds with `flagOn:true` regardless of the source const.
- **The closure strip** (`subagent/spawn.js` `CAPABILITY_CONSUMERS`) — the engine
  clients/registries added (flag-gated) so a non-actor child loses any it
  wasn't granted; the actor ctx is built keyless via `restrictCtxCapabilities`.
- **The binding** (`registry-factory.js` `setActorSession`/`getActorSession`).
- **`message_actor`** (`subagent/actor-messaging.js` + the tool) — the
  async-subagents mailbox specialized: `runWhenIdle` serialization, P0 sender gate,
  per-sender runaway guard, SW-captured correlation, wrapUntrusted reply re-entered
  into the SENDER via `runWhenIdle(senderSessionId)`.
- **The kind-aware turn branch** (`loop/turn-driver.js`) + the actor system-
  prompt block (`loop/system-prompt.js`).
- **Ephemeral confirm**, **/chats hiding**, **delete-archive**, all in the SW.

## Key decisions / deviations from a literal reading of the spec

1. **Only MUTATION is tiered; reads stay global.** The spec says the tier is
   "vm_*, app_*, js_* except js_run", but its own invariant is "reads stay global;
   only mutation is tiered." So `ACTOR_MUTATING_TOOLS` is the MUTATING set only
   — `vm_boot`, `vm_write_file`, `vm_import`, `vm_delete`, `js_notebook`,
   `js_write_file`, `js_delete`, `app_update`, `app_write_file`, `app_delete_file`,
   `app_delete`, **`edit_file`**. The read tools (`js_read_file`, `app_read_file`,
   `app_list_files`) and the create/catalog/open tools (`vm_create`, `vm_list`,
   `js_create`, `js_list`, `app_create`, `app_list`, `app_open`, `app_search`) +
   `js_run` stay on the main agent (no chicken-and-egg: main bootstraps an
   instance, then delegates via `message_actor`). An actor's own allow-list
   includes its kind's reads too (so it can read what it edits).

2. **`edit_file` is in the tier.** It's a real cross-kind App/Notebook write path
   (`kind` + `targetId`); leaving it off would be a complete mutation bypass. Its
   pin args are `targetId` (the instance) and `kind` (forced to the actor's).

3. **Lazy mint at `message_actor` time** (faithful to Move 1's "lazy — on the
   first operation that needs an actor") — avoids touching every create /
   client-auto-create site. The mint binds BOTH directions and sets the actor
   session as the instance's session-default so id-less tools resolve the bound
   instance.

4. **Actor permission posture:** the actor inherits the spawning chat's
   RESOLVED Plan/Act mode + confirm, stored EXPLICITLY (no silent widening to the
   global default — the subagent guardrail-3 precedent), layered with ephemeral
   confirm (never a standing `yes_session`).

5. **Keyless actor tool ctx:** built via `restrictCtxCapabilities` so the
   actor's TOOLS have no path to getSecret/safeFetch/spawn/memory. The loop
   still gets the provider key off-ctx via the turn driver (same as a subagent).
   Residual P0 surface: a WebVM actor keeps `webFetch` via `vm_import` (the
   spec's named exfil surface) — kept for VM functionality; documented, to be
   revisited with the untrusted-input posture (P1+).

6. **`synthetic` is now threaded onto the tool ctx** (buildToolContext →
   `ctx.synthetic`). Without it the `!synthetic` half of the P0 sender gate was
   inert (a goal-mode synthetic continuation in the active chat would have passed).

7. **Async-only at P0.** `sync?` is deferred (the detailed spec mechanism is the
   async re-entry); the tool is async — its reply arrives as a later fenced wake.

8. **`onTabClosed` generalization is doc-only for js/app** — only the VM client
   owns a per-instance command queue to interrupt; Notebook/App are
   request/response with a per-call timeout, so there's nothing to generalize
   beyond the tracker-mapping drop already done.

9. **The prompts are scoped to the actor structure (flag ON).** The code already
   moved the mutating tier off the main agent's descriptor list
   (`filterActorSurface`); the PROSE now matches. The main template in
   `peerd-provider/system-prompt.txt` IS the orchestrator prompt directly (an
   earlier `applyActorOrchestration` transform generated it region-by-region;
   once the model went unconditional the output was baked into the template and
   the transform scaffolding deleted): (a) the top instruction is "create the
   shell, delegate the build"; (b) the webvm/notebook/app/edit tool groups are a
   create/open/read listing + a `actor` group introducing `message_actor`;
   (c) the "Sandboxes" section is orchestrator framing (pick a kind, bootstrap,
   delegate a GOAL); (d) the deep "webvm specifics" section is gone. That's
   ~6k chars (~30%) off the ALWAYS-ON main prompt. The deep per-kind lore isn't
   lost — it's relocated into `actorBlock(kind)` (`ACTOR_TYPE_LORE`: the VM
   shell wrappers/quirks/flows, the App Mithril/iterative/chunking rules, the
   Notebook worker/OPFS specifics), so it loads LAZILY, only on an actor turn
   for that kind — the spec's "purpose-tuned agents" win. The actor block also
   carries a tool-scope disclaimer ("your ONLY tools are this environment's;
   ignore the orchestrator-only sections above") since an actor still renders
   the shared base, but sees only its kind's tools (`actorDescriptors`).
   Anchor-drift guard: `tests/peerd-runtime/actor-prompt.test.ts` runs the
   transform on the LIVE template and asserts it fires + shrinks (a near-miss
   anchor would silently no-op and leak the lore back onto the main prompt).

## Second-order audit (what the flag flip surfaced)

Flipping the flag on exposed a class of miss the adversarial review didn't catch:
the security WALL was verified in isolation, but its INTERACTIONS with the
features that *use* `message_actor` weren't traced. The findings:

- **Capability tier is COMPLETE — verified, no bypass.** All 12 instance mutators
  (`vm_boot`, `vm_write_file`, `vm_import`, `vm_delete`, `js_notebook`,
  `js_write_file`, `js_delete`, `app_update`, `app_write_file`, `app_delete_file`,
  `app_delete`, `edit_file`) are in `ACTOR_MUTATING_TOOLS`. The `write`-flagged
  tools that AREN'T tiered (`vm_create`/`app_create`/`app_open`/`js_create`) are
  all bootstrap/open — correctly on the orchestrator. No mutator slips the tier.

- **#1 (FIXED) — the subagents prompt told the orchestrator to do the impossible.**
  `system-prompt.txt`'s subagents section still said "pass a child the ids it
  should act on." With the flag on a subagent can do NEITHER: it holds no mutating
  tools (actor-only) AND `message_actor` is refused from it (the sender gate
  keys on `senderSessionId === getActiveSessionId()`, and a child runs under its
  own session id). `applyActorOrchestration` now rewrites that paragraph
  (`ORCH_SUBAGENTS`): subagents are for non-instance decomposition; instance
  PARALLELISM is N `message_actor` calls in one turn (actors run concurrently).

- **#2 / #3 (FIXED — owner chose to enable autonomy; the `inbound`-clamp seed).**
  Both stemmed from the P0 gate `!synthetic && senderSessionId === active`: a goal
  continuation (`goal-runner.js` `synthetic: !first`) and an actor reply-wake
  both re-enter `synthetic`, so neither could delegate. The fix replaces the coarse
  `synthetic` block with an untrusted-ORIGIN signal, keeping `=== active`:
  - The turn driver threads a `trusted` flag; `buildToolContext` folds it to
    **`ctx.inbound = synthetic && !trusted`**. The gate refuses
    `inbound || !sender || sender !== active`.
  - **Fail-CLOSED**: `trusted` defaults false, so any synthetic turn is `inbound`
    (refused) unless an explicit first-party continuation sets it. Only TWO do:
    the **goal continuation** (a goal is user-initiated) and the **actor
    reply-wake** (`deliver()` — the sender's own actor replied). Two re-entry
    sources are bounded by the **`=== active` wall**, not the inbound axis, so they
    need no `trusted`: an **async-subagent wake** re-enters a child session (never
    `=== active`), so it's refused regardless; an **auto-resume** of the FOREGROUND
    chat (`maybeAutoResume` → `runAgentTurn({resume:true})`, non-synthetic ⇒
    `inbound:false`) is a first-party attended continuation of a real user turn —
    it passes with the same standing as that turn, bounded by `=== active` + the
    runaway caps. Any FUTURE re-entry source (peer messages / scheduled tasks) is
    `inbound` by default and must never set `trusted`; `=== active` is the second wall.
  - **What it enables**: an autonomous goal in the FOREGROUND chat can drive a
    VM/Notebook/App, and the orchestrator can react to an actor reply with a
    follow-up — both bounded by the per-sender runaway guard (rate + outstanding
    caps). A BACKGROUNDED goal (chat not foreground) stays blocked by `=== active`.
  - `trusted` is about a turn's ORIGIN (peerd's own loop), NOT its content — an
    actor reply body is still `wrapUntrusted`-fenced.
  - Tests: `actor-messaging.test.ts` (a non-inbound first-party turn in the
    active chat is ALLOWED; an `inbound:true` turn is refused even when active);
    `goal-runner.test.ts` (turns carry `trusted:true`).

- **Minor polish (DONE).** Two cosmetic mismatches the actor model introduced:
  - *Tool descriptions* — instance tools (e.g. `vm_boot` "auto-creates one if
    none", `app_update` "targets the chat's current app") are orchestrator-voiced
    but now read only by a (pinned) actor. Rather than rewrite every blurb, the
    actor PROMPT's rule (1) tells it to IGNORE any "current/default/auto-create/
    target another" wording — it covers every tool + schema param at once.
  - *Code-style note* — `CODE_STYLE_NOTE` (and, for Notebooks, `JS_PITFALLS_NOTE`)
    rode `app_create`/`js_create` results, i.e. the ORCHESTRATOR that no longer
    writes the code. Now those notes ride the App/Notebook `actorBlock` (the
    writer), reused from the one source of truth (`tools/defs/code-style-note.js`);
    `app_create`/`js_create` no longer append them. `js_run` keeps
    `JS_PITFALLS_NOTE` (it's the orchestrator's own compute).

## Tests

- `tests/peerd-runtime/exposure.test.ts` — the tool sets + the gate
  (`actorTierGate`) + the per-instance pin + reads-stay-global. The real-gate
  (`eg`) wiring proofs assert the mutating tier is refused on main and
  `message_actor` (the non-mutating delegation channel) is allowed.
- `tests/peerd-runtime/actor-prompt.test.ts` — the baked orchestrator prompt
  (framing present, direct-drive lore relocated off the always-on template), the
  per-kind actor lore + disclaimer, and the lore-stays-lean guard.
- `tests/peerd-runtime/actor-messaging.test.ts` — sender gate, happy-path
  correlation, error-still-wakes, both runaway caps.
- `extension/tests/unit/peerd-runtime/dispatcher.test.js` — the full-chain
  boundary test (a subagent can't escalate into the mutating tier).
- The manifest gate tests (`tool-manifests.test.ts`) use a NON-tiered tool
  (`call_api`/`js_run`) so they exercise the manifest refusal itself — the
  actor tier now precedes the manifest check for a mutating tool.

## P1 — landed (the actor matures into a visible, durable, interruptible thing)

Built on top of P0, part of the actor model:

- **Durable message mailbox** (`actor-messaging.js` `deps.mailbox` + `redrain()`;
  SW backs it with `chrome.storage.session`, serialized writes). An in-flight
  message→reply correlation persists on accept and clears on settle; on boot the SW
  redrains every pending message ONCE the vault is unlocked (once-guarded against
  double-delivery). A stale entry whose instance is gone wakes the sender with a
  failure note. Mirrors `goalRunner.resume`. EVERY kind persists — web included,
  since the async collapse (below) put web on the same path. **Closes the P0
  lost-reply-wake residual.**
- **The glass pane (display stream).** An actor turn triggered by a live
  `message_actor` (its `ctx.toolUseId` threaded through as `parentToolUseId`)
  re-emits its stream as a `turn/actor-*` family keyed to that card; the
  chat-reducer `actors` slice + `renderActorCard` (reusing the recursive
  `renderTranscript`) render the actor's work inline — the subagent live-view,
  for an actor. `fromIndex` slices each card to ITS exchange (a long-lived actor
  messaged N times shows N distinct cards, not its whole history). Display stream =
  full fidelity, per-step snapshots (low-noise); model-memory stream (the fenced
  reply that re-enters the orchestrator) unchanged.
- **Per-card cost visibility** (`turn/actor-cost`). Delegated spend is no longer
  invisible; caps stay per-session (the cross-session rollup is the spec's open
  question).
- **Stop cascade.** `agent/stop` aborts the orchestrator AND `actorsFor(chat)` —
  each actor's own turn slot — so Stop actually halts delegated work. The aborted
  turn settles through the normal path (partial reply + mailbox cleared).

## The web actor goes live + the uniform actor model (owner direction)

The owner's call: "everything is an actor; the orchestrator never blocks." So the
web actor's sync-await special case was wrong. Three changes made the model
uniform:

- **Async-everything** (`actor-messaging.js`). The `kind==='web'` sync branch +
  `runWebSerialized` + `webChains` are gone; web rides the engine path (mailbox-
  persist → `runWhenIdle` wake → `deliver()`). The orchestrator never blocks; per-
  tab serialization comes free from the actor slot. Bonus: the old sync path
  returned the web reply RAW as a tool result — the async `deliver()` wrapUntrusted-
  fences it, so a page-derived reply is now fenced like any untrusted content.
- **The do/get/check cutover** (`exposure.js` / `gates.js` / `manifests.js`). Every
  open tab is an actor; the orchestrator reaches a page by messaging its tab's
  actor (`open_tab` + `list_tabs` + `message_actor`), and the do/get/check
  page runner LEAVES the main agent (`filterActorSurface` strips it from the main
  descriptor list; `actorTierGate` refuses it on a main-exposure ctx).
  SUBAGENTS keep do/get/check (their only page path — they can't message actors);
  the runner + tool defs + `RUNNER_PROMPT` all STAY registered for them.
- **The prompt fine-comb** (`system-prompt.js`). The base template now IS the
  orchestrator prompt: "every tab is an actor" folds do/get/check into
  `message_actor` (the reuse-vs-new-tab judgment, async-OUTCOMES delegation, the
  untrusted boundary). The web actor lore carries the full page mechanics + the
  IGNORE/FLAG/EXCLUDE injection drill (mirrored from `RUNNER_PROMPT`, which keeps its
  own copy for subagents) + its stateful framing.

**The irreducible caveat:** the web actor is now the orchestrator's ONLY browser
surface, and its page path (DOM tools driving a real tab) is **unverifiable outside
a live Chrome** — the CDP harness is blocked in this environment. The unit/bun tiers
+ the review swarm cover the wiring/gating/prompts; the live page path MUST be run
through the CDP harness before store ship.

## Still ahead (P1/P2+, not in this change)

The **conversational surface** (talk to an actor directly — a switcher/affordance,
not just the inline card), the **unattended path** (once the inbound clamp lands),
**mid-turn steer-as-message-fold** (the spec-isolated net-new capability — fold a
refinement INTO a running actor turn via an agent-loop control channel; a new
user message already steers coarsely via the orchestrator relay today), per-kind
tuned model tiers, the Phase-2 worker relocation, and full durable resume across a
browser restart — all per the spec's Phasing.

**The web actor** (tabs as a fourth actor kind) has a full forward design in
the spec — see `DESIGN-17-actor-agents.md` §"The web actor — tabs as the
fourth actor kind". It folds the browser runner into the actor model (every tab
owned, `do`/`get`/`check` collapsed into `message_actor`), and records the
central decision (accumulate IN the actor; reuse the loop's rolling-summary at every
boundary, keyed to provenance; the actor fences its own summary) + its honest
trade (a HARD non-accumulation invariant swapped for a SOFT, tested trim-cap +
self-fence). The display-only `<untrusted_*>` strip it depends on already shipped
(`stripUntrustedFences`, `shared/util.js`).

As-built, all LIVE (the async-everything + cutover above made it the orchestrator's
only browser surface):
- `subagent/web-actor.js` — tab→session bindings, the action-log summary prompt,
  the self-fence (`fenceWebActorSummary`). Pure, Bun-tested.
- `tools/exposure.js` — `actorType:'web'` toolset (`WEB_ACTOR_DOM_TOOLS`,
  drift-guarded against the runner's `DO_TOOLSET`) + the tab pin (`actorWebTabTarget`).
- `subagent/actor-messaging.js` — the uniform async path (web rides the engine
  mailbox-persist → wake → `deliver()` like every kind; no sync special case).
- `background/service-worker.js` — `resolveWebActorForTab` / `mintWebActorForTab`, the web
  actor inherits the owner chat's tool MANIFEST, its model-facing identity is its
  trusted tabId (never the page-controlled title), tab→session bindings mirrored to
  session storage + pruned on `tabs.onRemoved`, and **fail-closed `activeTab`**: a web
  actor resolves its OWNED tab only and `resolveTargetTab` REFUSES the foreground
  fallback for any actor ctx.
- `loop/trim.js` + `agent-loop.js` — `planTrim`'s `wrapSummary` hook folds the web
  actor's own rolling summary back in `wrapUntrusted`-fenced.

Still ahead for the web actor: steerable in-flight tab work (abort/steer as an
addressed message), and the "talk to an actor" conversational surface.

## Known residuals (documented, not yet closed)

These are bounded and named, not silent.

- **Reply-wake lost on SW death — CLOSED in P1** by the durable mailbox (above). The
  residual narrows to a death DURING the redrain's own actor turn before its
  mailbox entry clears; the next boot redrains it again (the entry is only removed on
  settle), so it self-heals rather than silently dropping.
- **Orphaned actor session on interrupted mint.** `mintActor` writes the
  session, then the session-default, then the forward pointer; an SW death between
  the create and the pointer leaves a `kind:'actor'` session no instance points
  at. Now far rarer — `mintOnce` dedupes concurrent first-mints — but not GC'd.
  *(P1: boot-time GC of un-pointed actor sessions.)*
- **An actor confirm auto-denies after ~120s.** A confirm raised inside a hidden
  actor session sits unrendered (the side panel views the orchestrator) until the
  120s auto-deny. P0 actors run under the chat's resolved non-confirm posture, so
  this is reached only if an actor hits a confirm-gated op; P1 routes the confirm
  to the foreground orchestrator.
