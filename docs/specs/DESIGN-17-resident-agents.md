# DESIGN-17 — resident tab agents: a per-tab session that owns its instance

> Status: DESIGN. Nothing here is implemented. Feature number 17.
> On branch `experimental/resident-tab-agents`.
>
> Design history (kept — the rejected paths are load-bearing context):
> (1) Explored a *tab-hosted loop* (loop in the tab page, SW as key/egress proxy
> — "the split" / Model B). An adversarial swarm showed its headline
> justification (renderer isolation vs *prompt-injection*) does not hold — a
> text-steered loop calls the same gated tools wherever it runs — and that it
> introduced four SW-side regressions. (2) Pivoted to **Model A** (loop on the SW
> heap, bound to the tab). (3) A second swarm reviewed the Model-A spec and
> **killed its first mutation-purity mechanism** ("purity by exposure" — the
> exposure axis is binary main/not-main and cannot express "resident-only", so a
> one-line `spawn_subagent({tools:['app_delete']})` mutated any instance). This
> revision fixes that with a **resident-keyed capability tier + per-instance
> pin**, and corrects two related over-claims (the instance↔resident *binding*
> needs a routing pointer; the resident turn is not "zero new runtime"). The
> kept-strong parts — the "A buys B" seam and the keyless content-threat scoping
> — are unchanged.
>
> Read first: `docs/SUBAGENTS.md` (a resident is "a session with parentage" — the
> shape reused; and the global-registry / "no owner check" decision this narrows),
> `docs/specs/DESIGN-11-async-subagents.md` (the wake/mailbox + runaway-guard
> reused for `message_resident`), `DESIGN.md` §8.5 (which instances are in scope).

## Motivation

Three goals, from the owner:

1. **Functional purity of instance access** — *"tabs as global objects any
   session can mutate bothers my functional sensibilities."*
2. **A lean parent context that doesn't re-bloat** as instances accumulate.
3. **Isolation** — a per-tab, secret-less agent (the do/get/check browser-runner
   trust model generalized to every stateful tab); eventually hardened against
   untrusted **code** (git repos, API responses, dweb-delivered dwapps).

A delivers #2 in full, #3 against the live threat (untrusted *content*), and #1
**by a resident-keyed capability tier** (below — *not* the binary exposure shed
the first draft proposed). The remaining slice of #3 — JS-level heap isolation
against untrusted *code* — is Phase 2 (the split), built on A's seam.

## What a resident IS (Model A)

A **resident** is a persistent session — `kind:'resident'`, the third
`SessionKind` member — **one per tab-hosted instance** (WebVM, Notebook, App).
Its loop runs **on the SW heap**, through the existing `turn-driver.js` →
`runUserTurn` path. The instance still lives in its tab, driven by the existing
`vm-client`/`notebook-client`/`app-client` RPC. Three things make it a resident:

1. it is **bound to its instance** by a persisted `residentSessionId` on the
   registry record (a *routing* pointer — below);
2. it is **the only kind of session that may hold instance-mutating tools**, and
   then only for *its own* instance;
3. you **reach it only by message** (`message_resident`).

`js_run` (headless, ephemeral, no instance) stays a parent tool. Scope is the
three tab-hosted kinds (§8.5).

## Move 1 — the binding: an instance→resident routing pointer

The resident is bound to its **instance**, not its **tab**. The tab is just the
current host (reconstitutable via `ensureTab`); the binding must survive the tab
closing (a VM persists when its tab closes). So:

- **The binding is a persisted `residentSessionId` field on the registry record**
  (`registry-factory.js`), set when the resident is minted. `message_resident`
  resolves `instanceId → residentSessionId` from there; the `tab-tracker` is used
  only to ensure the tab is live when the resident needs to act (`ensureTab`).
- **This is not the ownership *gate* the earlier draft rejected.** That gate was a
  *session→instance owner check on every mutation* (with transfer-on-settle and
  brick-the-instance failure modes). `residentSessionId` is a *one-directional
  routing pointer* (find the resident to deliver a `tell`); mutation is **not**
  gated on it (it's gated by the capability tier, Move 2), so it has none of
  those failure modes — if the resident session is gone, mint a fresh one; the
  instance is never bricked. The honest correction to v1: there *is* a pointer;
  it is addressing, not a per-call owner check.
- **Minting:** lazy — on the first operation that needs a resident for an
  instance (the create/first-`tell` path), the resident session is created and
  its id written to the record. Archived when the **instance** is deleted
  (`vm_delete`/`app_delete`), not when the tab closes (tab close → dormant;
  record + `residentSessionId` persist; re-adopted on SW boot after
  `registry.load()`).

## Move 2 — the capability tier: who may hold instance-mutating tools

This is goal #1's real mechanism, and it is **enforced at the dispatch gate**,
not by descriptor hygiene alone (the v1 "purity by exposure" claim was false: the
exposure axis only knows `main` vs not-`main`, so it cannot keep instance tools
off a *subagent*).

- **A new authority marker — `resident` — gates the instance-mutating set**
  (`vm_*`, `app_*`, `js_*` except `js_run`). `exposureGate` (`tools/gates.js`)
  is extended so these tools are **refused for every ctx whose marker is not
  `resident`** — `main`, `subagent`, runner, review, and direct dispatch all
  **fail closed**. The marker is set only by the resident turn path;
  `buildToolContext` and `spawnSubagent` must **never** set it for a child.
- **Both spawn surfaces are gated.** The `spawn_subagent` tool *and* the
  `subagent/spawn` SW route (`routes/sessions.js`, which forwards caller-supplied
  `tools` verbatim — reachable from a first-party `peerd.runtime.runAgent` shim)
  must not grant the `resident` marker. A subagent requesting `tools:['app_delete']`
  is refused at dispatch.
- **Closures stripped by construction.** The instance clients/registries
  (`appClient`/`appRegistry`/`vmClient`/`vmRegistry`/`jsClient`/`jsRegistry`) are
  injected into every ctx today and are absent from `CAPABILITY_CONSUMERS`
  (`spawn.js`). Add them so a non-resident ctx has **no closure** to call even if
  a tool name leaked — defense in depth behind the name gate.
- **Per-instance pin (cross-resident isolation).** Instance-mutating tools are
  id-addressed against *singleton* registries (`app_delete(args.appId)` deletes
  *any* app), so the 1:1 tab binding alone does **not** scope a resident to its
  own instance. The resident's tool ctx **defaults the target to its bound
  instance id and rejects a mismatching explicit id.** Without this, a resident
  could mutate a *sibling* instance.
- **Test the boundary.** A dispatcher test (mirroring `dispatcher.test.js:266`)
  asserts a subagent spawned with `tools:['app_delete']` and no manifest is
  refused. This is a P0 deliverable, not a nicety — it is the proof goal #1 holds.

So the parent (and any non-resident session) cannot mutate an instance because the
tool **fails closed at the gate** for them, and a resident cannot mutate a
*sibling* because its ctx is **pinned**. Call it **purity by capability topology**
— a resident-keyed tier + a per-instance pin, both enforced at dispatch. (Reads
stay global and id-addressable, as `docs/SUBAGENTS.md` has them — only *mutation*
is tiered; goal #1 is the mutation half, honestly scoped.)

## Move 3 — the message channel: `message_resident`

`message_resident({ to, message, sync? })`; `to` is the instance id → resolve
`residentSessionId` (Move 1) → `turnSlots.runWhenIdle(residentSessionId, fn)`
(the serializing mailbox: runs when the resident is idle, **never interrupting an
in-flight turn**, DECISIONS #20). The resident's turn is
`runAgentTurn({ sessionId: residentSessionId, … })`. The reply re-enters the
**sender** as a `synthetic:true` wake, `wrapUntrusted`-fenced (mandatory for App
residents — they render attacker content). Correlation is pinned **SW-side**
(`{correlationId → senderSessionId}`, the async-subagents per-sender shape).

- **P0 fail-closed sender gate.** The `ctx.inbound`/unattended clamp the
  unattended path needs is **SPEC-only today (zero code)**, and *synthetic parent
  turns already exist* (`goal-runner.js`, `async-subagents.js` re-enter with
  `wrapUntrusted`'d page bytes) — a synthetic parent is a non-attended sender that
  exists **now**. So P0 gates the tool edge on
  **`!synthetic && senderSessionId === getActiveSessionId()`** (attended,
  first-party). The unattended path (peer messages, scheduled tasks) is **blocked
  at P0** and unlocks only when the shared clamp lands (P1+).
- **Runaway guard.** `message_resident` reuses the async-subagents `RATE_CAP` /
  `OUTSTANDING_CAP` per sender (a resident↔resident or parent↔resident ping-pong
  must be bounded — see cost, below).

## The resident-runtime boundary — why A is B's foundation

peerd's turn machinery is already split where the A↔B seam needs it. **Verified:**
the `turn-driver` wrapper genuinely owns spend/clamp/scheduler/key/egress and
calls `runUserTurn` (the inner loop) which reaches none of them by closure (it
emits `usage` *events* the wrapper consumes).

```
turn-driver.js  (the WRAPPER — stays SW-side in BOTH A and B)
   ├─ makeTurnCostTracker / maybeHalt / spendLimitUsd   ← spend cap
   ├─ ctx.inbound clamp (when it lands)                 ← unattended gate
   ├─ turnSlots (runWhenIdle / claim / release)         ← scheduler / anti-focus-theft
   ├─ vault.getSecret + safeFetch + webFetch + audit    ← key & egress
   └─ runUserTurn(...)   ← the INNER LOOP (the only thing B relocates)
```

- **Model A:** the resident runs the whole stack in the SW. **But not for free:**
  `runAgentTurn` today hardcodes `exposure:'main'` (which would shed the very
  tools a resident needs) and frames the turn around
  `browser.tabs.query({active:true})` (the *user's* foreground tab, not the
  resident's instance tab). So A needs a **kind-aware branch**: the `resident`
  exposure marker, a resident descriptor build, the `*_RESIDENT_PROMPT`, and
  honoring the resident's `activeTabId` instead of the foreground query. The
  **wrapper** (spend/clamp/scheduler/egress) is reused verbatim; the inner
  per-turn *setup* is real, bounded new work. ("Zero new turn runtime" was an
  over-claim; the honest claim is "the enforcement wrapper is reused.")
- **Model B (Phase 2):** relocate **only `runUserTurn`** into a per-tab worker
  behind a streaming proxy; the wrapper stays SW-side. Because enforcement never
  leaves the SW, B does not reintroduce the regressions the split's first draft
  had (uncapped spend, an unclamped inbound path, an invisible second scheduler).

**Design rule for A, so A supports B:** keep every key/egress/cost/clamp/scheduler
concern in the wrapper; keep the loop's IO behind the injected `REQUIRED_CTX`
seam. Then B is one scoped relocation. Spec the seam once; cross it later.

## What A ships vs what the split (Phase 2) adds

| | Model A (ship now) | The split (Phase 2, JS-safety) |
|---|---|---|
| Inner loop runs | SW heap | per-tab worker |
| Key in the loop's realm | held for `callModel` | none (proxied) |
| Defends prompt-injection | yes (gated tools) | yes (identical) |
| Defends a JS exploit of the loop reaching the key | no (shared SW heap) | **yes — the real delta** |
| Trigger | now | untrusted **code** live (dweb dwapps) + A battle-tested |

## Cost model (corrected — not "native and free")

A resident is a *separate session*. `makeTurnCostTracker` (`cost/turn-tracker.js`)
checks `limitUsd` **per session**, so **N residents = N independent caps**: the
user's attended chat hitting its limit does not stop its residents, and a
`message_resident` ping-pong burns two independent caps. P0 must therefore (a) carry
the `message_resident` runaway guard (Move 3), and (b) **document** that residents
multiply the cap by live-resident count. A true cross-session rollup into one
owning-user budget does not exist today and is an open question (below), not a P0
claim.

## Hardenings carried from the adversarial reviews

A structurally avoids the split's four regressions (loop is on the SW). Folded in:

- **Ephemeral resident confirm.** `sessionConfirmGrants` banks a blanket
  `yes_session` per session; a *persistent* resident would replay one approval
  every turn. Residents use **per-turn** grants (the runner's grant-less posture).
- **`message_resident` P0 fail-closed** on synthetic/unattended senders (Move 3).
- **SW-side reply correlation** (Move 3) — never a persisted sender pointer.

## Context shedding (goal #2)

Parent keeps create + `message_resident` + list; the ~23 instance tools move behind
the `resident` tier (minus `js_run`). Non-eroding (unlike `INSTANCE_GATED_TOOLS`
progressive disclosure). Net ~4.5–6 k tokens off every parent turn; the engine
prose moves into per-kind `*_RESIDENT_PROMPT`. (Honest: the per-resident prompt
re-incurs that prose per live resident — net positive for the parent, recompute
for always-warm residents.)

## Lifecycle

Bound to the instance (Move 1); **lazy execution** (the loop runs only on a
`tell`). Persists in IDB; instance persists via registries/OPFS/disks; SW boot
re-adopts via `registry.load()` + `tabTracker.bootstrap()`; a `tell` to a
tabless instance re-spawns the tab via `ensureTab`. Generalize
`onTabClosed → queue.interrupt` (VM-only at `:2031`) to all kinds.

## Security / invariants

- **Mutation is resident-tiered + per-instance-pinned** (Move 2), enforced at
  `exposureGate` + the closure strip. The dispatcher test is the proof.
- **Keyless tool context** (`restrictCtxCapabilities`) against the content threat;
  the shared SW heap is the named soft spot, closed for untrusted *code* in P2.
- **`confirm`/`audit` SW-authoritative**; residents never self-approve.
- **`webFetch` (allowlist-free) is the real exfil surface** — deny open-web tools
  to untrusted-input residents, as the runner does.
- **The isolate is the untrusted-code boundary** in both A and B.
- Reply `wrapUntrusted`; depth/trust/audit unchanged.

## Specifically NOT to do

- Implement the mutation shed as descriptor-hygiene only (the v1 kill) — it must
  be a `resident`-keyed **dispatch-gate refusal** + a per-instance pin.
- Grant the `resident` marker on either spawn surface.
- Re-introduce a per-call *session→instance owner check* (the rejected gate). The
  `residentSessionId` field is a *routing* pointer, not a mutation gate.
- Build the streaming proxy now (that's P2).
- Move cost/clamp/scheduler off the SW — ever.
- Give residents standing `yes_session`; treat `js_run` as an instance; run the
  loop in the isolate.

## Open questions

- **Which kinds get residents by default** (WebVM strongest; per-kind).
- **Cross-session spend rollup** — do residents share the owning user's budget, or
  is per-session-cap-× -tab-count acceptable? (No rollup exists today.)
- **The inbound clamp** is the shared dependency that unlocks `message_resident`'s
  unattended path; P0 ships attended-only without it.
- **The user talking to a resident** — does `kind:'resident'` appear in a switcher
  or only via the tab?
- **Phase-2 trigger** — what concretely flips the split on (first dweb dwapp
  execution path?).

## Phasing

1. **P0 — Model A core.** `kind:'resident'` (a `SessionKind` union change → audit
   kind-switches, the `/chats` filter, store-load default); the **`resident`
   exposure tier + dispatch-gate refusal + closure strip + per-instance pin +
   the dispatcher test** (Move 2 — the security spine); the instance→resident
   `residentSessionId` binding; `message_resident` (SW correlation + mailbox +
   runaway guard + the `!synthetic && active` fail-closed gate); the kind-aware
   resident turn branch (exposure/descriptors/`*_RESIDENT_PROMPT`/`activeTabId`);
   ephemeral confirm; resident-spawn wired across all three trackers. Behind a
   flag. *Battle-test + release.* (Honest build surface — this is not "zero new
   runtime".)
2. **P1 — persistence + the conversational surface** (durable resident sessions;
   the side-panel "talk to this instance" affordance; the unattended `tell`
   path once the clamp lands).
3. **P2 — the split (Model B), for JS-safety.** Relocate `runUserTurn` into a
   per-tab worker behind the proxy (streaming Port, egress relay,
   vault-`unlocked` relay, cross-boundary abort); wrapper stays SW-side.
   Triggered by untrusted-code use cases + a battle-tested A.
4. **P3 — durable resume** across vault unlock / browser restart (DESIGN-08).

## The seam is the bet

A ships the actor model and the lean parent now, regression-free, by reusing the
SW turn-driver wrapper and a resident-keyed capability tier. The split is then one
well-scoped relocation — move the inner loop into a per-tab worker, leave
enforcement in the SW — for the day untrusted *code* runs. **Design the seam once
(P0); cross it when the threat arrives (P2).** That's why A directly buys B.
