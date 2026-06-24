# DESIGN-17 — resident tab agents: a per-tab session that owns its instance

> Status: DESIGN. Nothing here is implemented. Feature number 17.
> Branch `experimental/resident-tab-agents`. Read first: `docs/SUBAGENTS.md`
> (a resident is "a session with parentage"; this narrows its global-registry
> decision), `docs/specs/DESIGN-11-async-subagents.md` (the wake/mailbox +
> runaway-guard reused for `message_resident`), `DESIGN.md` §8.5 (which instances
> are in scope).

## The problem

Two problems, one shape:

- **Context.** The main agent carries every execution environment's tooling and
  instructions at once — the ~23 `vm_*`/`js_*`/`app_*` tools plus their
  per-environment prompt guidance ride every turn. As one session spins up a VM,
  then an App, then a Notebook, that surface only grows, and most of it is
  irrelevant to whatever the agent is reasoning about right now. This is a
  context-optimization problem, and progressive disclosure
  (`INSTANCE_GATED_TOOLS`) only softens it — once a chat has one of each kind, the
  context is back.
- **Structure.** Tab-hosted instances (WebVM, Notebook, App) are global mutable
  objects: any session reaches into any instance by id and mutates it. Nothing
  *owns* an instance — there's shared state and a convention not to clobber it.

## Goals

**Set up a clearer actor structure.** Each tab-hosted instance is owned by one
agent — a **resident** — that holds that environment's tools and is the only thing
that drives it. You don't mutate an instance; you **message its resident**
(`message_resident`). That one move solves both problems: the per-environment
tooling leaves the main agent (context optimized, and *non-eroding* because it
never comes back), and "who may touch this instance" becomes structural instead
of conventional.

Two forward benefits the actor boundary buys, and which justify the structure
beyond the immediate win:

- **Security.** A per-instance agent that holds only its environment's tools and
  no provider key is the do/get/check browser-runner trust model generalized to
  every tab. The boundary is the natural seam to later harden against untrusted
  *code* (dweb-delivered dwapps) — see Phase 2.
- **Purpose-tuned agents.** Each resident is specialized to its environment: an
  expanded, tuned system prompt, and a narrow toolset that can grow aggressively
  without taxing anyone else's context. The VM resident can be a shell expert; the
  App resident a UI builder; and (later) each can run a fit-for-purpose model
  tier — none of it bloating the orchestrator.

The rest of this doc is the design that delivers the above on Model A (loop on the
SW heap), and the one seam that lets it later harden into Model B (loop in a
per-tab worker) without a re-architecture.

## What a resident IS

A **resident** is a persistent session — `kind:'resident'`, a third `SessionKind`
member — **one per tab-hosted instance**. Its loop runs **on the SW heap**,
through the existing `turn-driver.js` → `runUserTurn` path. The instance lives in
its tab, driven by the existing `vm-client`/`notebook-client`/`app-client` RPC.
Three things make it a resident:

1. it is **bound to its instance** by a persisted `residentSessionId` on the
   registry record (a *routing* pointer — Move 1);
2. it is **the only kind of session that may hold instance-mutating tools**, and
   then only for *its own* instance (Move 2);
3. you **reach it only by message** (Move 3).

`js_run` (headless, ephemeral, no instance) stays a parent tool. Scope is the
three tab-hosted kinds (§8.5).

## Move 1 — the binding: an instance→resident routing pointer

The resident is bound to its **instance**, not its **tab** — the tab is just the
current host (reconstitutable via `ensureTab`), and the binding must survive the
tab closing (a VM persists when its tab closes).

- **The binding is a persisted `residentSessionId` field on the registry record**
  (`registry-factory.js`), set when the resident is minted. `message_resident`
  resolves `instanceId → residentSessionId` from there; the `tab-tracker` is used
  only to ensure the tab is live when the resident needs to act.
- **This is a routing pointer, not a per-call owner gate.** A session→instance
  owner check on every mutation would carry transfer-on-settle and
  brick-the-instance failure modes; `residentSessionId` is one-directional
  addressing — mutation is gated by the capability tier (Move 2), not by this
  field — so if the resident session is gone, mint a fresh one and the instance is
  never bricked.
- **Minting:** lazy — on the first operation that needs a resident for an
  instance. Archived when the **instance** is deleted, not when the tab closes
  (tab close → dormant; record + pointer persist; re-adopted on SW boot after
  `registry.load()`).

## Move 2 — the capability tier: who may hold instance-mutating tools

The actor structure's real mechanism, **enforced at the dispatch gate** (not by
descriptor hygiene — the exposure axis is binary `main`/not-`main` and cannot keep
instance tools off a *subagent*, so a deny-set alone is bypassable by a one-line
`spawn_subagent({tools:['app_delete']})`).

- **A new authority marker — `resident` — gates the instance-mutating set**
  (`vm_*`, `app_*`, `js_*` except `js_run`). `exposureGate` (`tools/gates.js`) is
  extended so these tools are **refused for every ctx whose marker is not
  `resident`** — `main`, `subagent`, runner, review, direct dispatch all **fail
  closed**. The marker is set only by the resident turn path; `buildToolContext`
  and `spawnSubagent` must **never** set it for a child.
- **Both spawn surfaces are gated** — the `spawn_subagent` tool *and* the
  `subagent/spawn` SW route (`routes/sessions.js`, which forwards caller `tools`
  verbatim, reachable from a first-party `peerd.runtime.runAgent` shim).
- **Closures stripped by construction.** The instance clients/registries
  (`appClient`/`vmClient`/`jsClient` + registries) are injected into every ctx
  and absent from `CAPABILITY_CONSUMERS` (`spawn.js`); add them so a non-resident
  ctx has **no closure** to call even if a tool name leaked.
- **Per-instance pin (cross-resident isolation).** Instance tools are id-addressed
  against *singleton* registries (`app_delete(args.appId)` deletes *any* app), so
  the binding alone does not scope a resident to its own instance. The resident's
  tool ctx **defaults the target to its bound instance id and rejects a
  mismatching explicit id.**
- **Test the boundary.** A dispatcher test (mirroring `dispatcher.test.js:266`)
  asserts a subagent spawned with `tools:['app_delete']` and no manifest is
  refused. This is a P0 deliverable — the proof the structure holds.

So a non-resident cannot mutate (the tool fails closed at the gate) and a resident
cannot mutate a sibling (its ctx is pinned). Reads stay global and id-addressable
(`docs/SUBAGENTS.md`); only *mutation* is tiered.

## Move 3 — the message channel: `message_resident`

`message_resident({ to, message, sync? })`; `to` is the instance id → resolve
`residentSessionId` (Move 1) → `turnSlots.runWhenIdle(residentSessionId, fn)` (the
serializing mailbox: runs when the resident is idle, **never interrupting an
in-flight turn**, DECISIONS #20). The resident's turn is
`runAgentTurn({ sessionId: residentSessionId, … })`. The reply re-enters the
**sender** as a `synthetic:true` wake, `wrapUntrusted`-fenced (mandatory for App
residents — they render attacker content). Correlation is pinned **SW-side**
(`{correlationId → senderSessionId}`, the async-subagents per-sender shape).

- **P0 fail-closed sender gate.** The unattended/`ctx.inbound` clamp this would
  ride is **SPEC-only today**, and *synthetic parent turns already exist*
  (`goal-runner.js`, `async-subagents.js` re-enter with `wrapUntrusted`'d page
  bytes) — a synthetic parent is a non-attended sender that exists **now**. So P0
  gates on **`!synthetic && senderSessionId === getActiveSessionId()`**
  (attended, first-party). The unattended path (peer messages, scheduled tasks) is
  **blocked at P0** until the shared clamp lands.
- **Runaway guard.** Reuse the async-subagents `RATE_CAP`/`OUTSTANDING_CAP` per
  sender (a parent↔resident ping-pong must be bounded — see cost).

## The seam: how this same design later hardens (Phase 2)

peerd's turn machinery is already split where it needs to be. **Verified:** the
`turn-driver` wrapper owns spend/clamp/scheduler/key/egress and calls
`runUserTurn` (the inner loop), which reaches none of them by closure (it emits
`usage` *events* the wrapper consumes).

```
turn-driver.js  (the WRAPPER — stays SW-side, ALWAYS)
   ├─ makeTurnCostTracker / maybeHalt / spendLimitUsd   ← spend cap
   ├─ ctx.inbound clamp (when it lands)                 ← unattended gate
   ├─ turnSlots (runWhenIdle / claim / release)         ← scheduler / anti-focus-theft
   ├─ vault.getSecret + safeFetch + webFetch + audit    ← key & egress
   └─ runUserTurn(...)   ← the INNER LOOP
```

- **Now (the loop on the SW heap):** the resident runs the whole stack in the SW.
  Not "zero new runtime" — `runAgentTurn` today hardcodes `exposure:'main'` (which
  would shed the tools a resident needs) and frames the turn around the *user's*
  foreground tab, so the resident path needs a kind-aware branch (the `resident`
  marker, a resident descriptor build, the tuned prompt, honoring the resident's
  `activeTabId`). The **wrapper** is reused verbatim; the inner per-turn *setup* is
  bounded new work.
- **Later (the security forward-benefit):** relocate **only `runUserTurn`** into a
  per-tab worker behind a streaming proxy; the wrapper stays SW-side. That closes
  the one isolation gap the SW-heap loop leaves — a JS-level exploit of the loop
  reaching the in-memory key — which matters once instances run untrusted *code*
  (dweb dwapps). Because enforcement never leaves the SW, the relocation cannot
  reintroduce the regressions an early draft of it had (uncapped spend, an
  unclamped inbound path, an invisible second scheduler).

Against the *content* threat the keyless tool context (`restrictCtxCapabilities`
already strips `getSecret`/`safeFetch`) is the proportionate posture; the worker
relocation is for the *code* threat. **Design the seam once now; cross it when the
threat arrives.**

## Cost

A resident is a separate session; `makeTurnCostTracker` checks `limitUsd`
**per session**, so **N residents = N independent caps** (the user's chat hitting
its limit does not stop its residents; a ping-pong burns two caps). P0 carries the
`message_resident` runaway guard (Move 3) and **documents** the
cap-×-live-residents reality. A cross-session rollup into one owning-user budget
does not exist today (open question).

## Lifecycle

Bound to the instance (Move 1); **lazy execution** (the loop runs only on a
message). Persists in IDB; instance persists via registries/OPFS/disks; SW boot
re-adopts via `registry.load()` + `tabTracker.bootstrap()`; a message to a tabless
instance re-spawns the tab via `ensureTab`. Generalize
`onTabClosed → queue.interrupt` (VM-only at `:2031`) to all kinds.

## Security / invariants

- **Mutation is resident-tiered + per-instance-pinned** (Move 2), enforced at
  `exposureGate` + the closure strip. The dispatcher test is the proof.
- **Keyless tool context** against the content threat; the shared SW heap is the
  named soft spot, closed for untrusted *code* by the Phase-2 relocation.
- **`confirm`/`audit` SW-authoritative**; residents never self-approve (per-turn
  grants, not standing `yes_session`).
- **`webFetch` (allowlist-free) is the real exfil surface** — deny open-web tools
  to untrusted-input residents, as the runner does.
- **The isolate is the untrusted-code boundary**; reply `wrapUntrusted`;
  depth/trust/audit unchanged.

## Specifically NOT to do

- Implement the mutation shed as descriptor-hygiene only — it must be a
  `resident`-keyed **dispatch-gate refusal** + a per-instance pin.
- Grant the `resident` marker on either spawn surface.
- Use a per-call *session→instance owner check* (`residentSessionId` is routing,
  not a gate).
- Build the streaming worker proxy before the *code* threat is live.
- Move cost/clamp/scheduler off the SW — ever.
- Treat `js_run` as an instance; run the loop in the isolate.

## Open questions

- **Which kinds get residents** (WebVM strongest; per-kind).
- **Cross-session spend rollup** vs per-session-cap-×-tab-count.
- **The inbound clamp** (shared dependency) unlocks the unattended message path;
  P0 ships attended-only.
- **The user talking to a resident** — does `kind:'resident'` appear in a switcher
  or only via the tab?
- **Phase-2 trigger** — what concretely flips on the worker relocation.

## Phasing

1. **P0 — the actor structure.** `kind:'resident'`; the `resident` capability tier
   (dispatch-gate refusal + closure strip + per-instance pin + the dispatcher
   test); the `residentSessionId` binding; `message_resident` (mailbox + SW
   correlation + runaway guard + the `!synthetic && active` gate); the kind-aware
   resident turn branch; ephemeral confirm; resident-spawn across the three
   trackers. Behind a flag. *Battle-test + release.*
2. **P1 — persistence + the conversational surface** (durable residents; the
   side-panel "talk to this instance" affordance; the unattended path once the
   clamp lands; per-kind tuned prompts/model tiers).
3. **P2 — the worker relocation, for JS-safety against untrusted code.** Move
   `runUserTurn` into a per-tab worker behind the proxy; wrapper stays SW-side.
4. **P3 — durable resume** across vault unlock / browser restart (DESIGN-08).

## Future steps — the substrate, and the mature model

This design is the foundation for a longer arc (forward-looking, not committed
here):

- **Per-tab security isolation** (Phase 2) — the actor boundary makes JS-heap
  isolation against untrusted *code* a single loop relocation; the substrate for
  executing untrusted dweb-delivered dwapps.
- **Purpose-tuned models per actor** — each resident on a fit-for-purpose tier:
  the shell/VM resident fast and cheap, the App resident a strong coding model,
  the orchestrator on the frontier model doing only routing + synthesis.
  Specialization up, cost down — the orchestrator stops carrying every
  environment's reasoning.
- **An in-browser actor mesh** — `message_resident` is session→session, so local
  residents address *each other* as peers (the VM resident asks the App resident
  to render its output); the orchestrator thins toward a router over a graph of
  specialists.
- **A2A across peers** — the same message primitive extends to *remote* agents
  over the dweb (`docs/distributed/ROADMAP.md`). Local↔remote is a deliberate
  line: a peer's agent is a different trust + latency regime than a local
  resident, even though both are addressed as peers.
- **Autonomous residents** — once the inbound clamp lands, residents react to
  schedules/events and tend their environments unattended.

**The mature model:** actor-based orchestration of specialized agents in the
browser — the orchestrator routes, the work lives in a graph of purpose-tuned
residents acting as peers — with a deliberate line between **local** peers
(in-browser, trusted, cheap to reach) and **remote** ones over **A2A**
(agent-to-agent across the dweb).

## Alternatives considered

- **Loop in the tab (worker) from day one** — rejected as the *default*: against
  the content threat it buys nothing over the SW-heap loop (a text-steered loop
  calls the same gated tools wherever it runs), and the relocation is real work.
  Kept as Phase 2 for the *code* threat, on this same seam.
- **A per-call ownership gate** (`session === record.owner` on every mutation) —
  rejected: imperative bookkeeping with transfer-on-settle / brick failure modes.
  Replaced by the capability tier + the routing pointer.
