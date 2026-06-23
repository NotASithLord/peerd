# DESIGN-17 — resident tab agents: a per-tab session that owns its instance

> Status: DESIGN. Nothing here is implemented. Feature number 17.
> On branch `experimental/resident-tab-agents`.
>
> Design history (kept deliberately — the rejected path is load-bearing
> context): this started as a *tab-hosted loop* design (the loop runs in the tab
> page; the SW is a key/egress proxy — "Model B / the split"). An adversarial
> review (`docs/SUBAGENTS.md` threat model + a code-grounded swarm) showed the
> split's headline justification — renderer isolation as a boundary against
> *prompt-injection* — does not hold: a text-steered loop can only call its
> already-gated tools, identical wherever the loop runs. The split's one real
> benefit is **JS-level heap isolation** (a code exploit of the loop reaching the
> in-memory key / co-resident data), which is desirable but is a *different,
> later* threat (untrusted **code**, e.g. dweb-delivered dwapps), and the split
> introduced four SW-side regressions. **Decision: ship Model A now** (loop on
> the SW heap, bound structurally to the tab); **stage the split as Phase 2** on
> the *same seam*, for JS-safety, once A is battle-tested and untrusted-code use
> cases are live. A is not a stepping stone thrown away — **A is the substrate B
> relocates onto.**
>
> Read first: `docs/SUBAGENTS.md` (a resident is "a session with parentage" — the
> shape reused), `docs/specs/DESIGN-11-async-subagents.md` (the wake/mailbox
> reused for `tell_instance`), `DESIGN.md` §8.5 (which instances are in scope).

## Motivation

Three goals, from the owner:

1. **Functional purity of instance access** — *"tabs as global objects any
   session can mutate bothers my functional sensibilities."*
2. **A lean parent context that doesn't re-bloat** as instances accumulate.
3. **Isolation** — a per-tab, secret-less agent, the do/get/check browser-runner
   trust model generalized to every stateful tab; eventually hardened against
   untrusted **code** (git repos, API responses, dweb-delivered dwapps).

A ships #1 and #2 in full, and #3 against the live threat (untrusted *content*).
The remaining slice of #3 — JS-level heap isolation against untrusted *code* — is
Phase 2 (the split), built on A's seam.

## What a resident IS (Model A)

A **resident** is a persistent session — `kind:'resident'`, the third
`SessionKind` member alongside `chat`/`subagent` — **one per tab-hosted instance**
(WebVM, Notebook, App). Its agent loop runs **on the SW heap**, through the
existing `turn-driver.js` → `runUserTurn` path, exactly like the main chat and
every subagent today. Nothing new runs in the tab; the instance still lives in
its tab and is driven by the existing `vm-client`/`notebook-client`/`app-client`
RPC. Three things make it a resident:

1. its **lifecycle is bound 1:1 to the tab** (the tab-tracker entry);
2. it **owns the instance's tools** — and is the only session that has them;
3. you **reach it only by message** (`tell_instance`).

`js_run` (headless, no tab, ephemeral throwaway compute) is **out** — it stays a
parent tool. Scope is the three tab-hosted kinds (§8.5).

## The three moves

### 1. Structural binding — the tab-tracker entry, no pointer

`tab-tracker.js` already maps `byId: Map<instanceId, {tabId, ready, …}>`, born on
`onTabReady(id, sender.tab.id)` (`service-worker.js` ~2007) and evicted on
`tabs.onRemoved → onTabRemoved(tabId)` (~2031). **That map is the binding.** A
resident session is minted when its instance's tab first goes ready, and archived
when the tab closes — riding those exact events. No `ownerSessionId` field, no
resident registry to reconcile, no orphan bookkeeping. The earlier draft's
imperative ownership pointer is gone: there is nothing to go stale because the
binding *is* the tracker entry's lifecycle.

### 2. The tool-shed — purity by exposure, not enforcement

The instance-mutating tools (`vm_*`, `js_*` except `js_run`, `app_*`) are added to
a hidden-set mirroring `MAIN_AGENT_HIDDEN_TOOLS` (`exposure.js`):
`mainAgentDescriptors` drops them from the main turn and `exposureGate` refuses
them on `exposure:'main'`. They are granted **only to resident sessions.** So the
parent (and any normal chat) literally *cannot* mutate an instance — not because
of a per-call owner check, but because **it doesn't have the tools.** Purity is a
property of *where the capability lives* (exactly one place: the resident), which
is cleaner than a gate and needs no registry lookup. The parent's only verbs are
**create-a-tab**, **`tell_instance`**, **list**. This *is* goal #2 — and unlike
`INSTANCE_GATED_TOOLS`' progressive disclosure (which re-bloats once a chat has one
of each kind), a hard shed doesn't erode. The heavy engine prose
(`system-prompt.txt` Sandboxes + WebVM blocks, ~8.7 KB) moves into each kind's
byte-stable `*_RESIDENT_PROMPT`, where per-env toolsets can expand aggressively.

### 3. The message channel — `tell_instance`

`tell_instance({ to, message, sync? })`; `to` is the instance id. The SW resolves
`tracker.getTabId(to)` → the resident session → `turnSlots.runWhenIdle(resident,
fn)` (the existing serializing mailbox: a `tell` runs when the resident is idle,
**never interrupting an in-flight turn**, DECISIONS #20). The resident's turn is
just `runAgentTurn({ sessionId: residentSessionId, synthetic, … })` — the
async-subagent reintegration path, already shipped. The reply re-enters the
**sender** as a `synthetic:true` wake turn, `wrapUntrusted`-fenced (mandatory for
App residents — they render attacker content). **Sender correlation is pinned
SW-side** (a transient `{correlationId → senderSessionId}` map, lifetime one
round-trip — never a persisted per-message sender pointer in the resident).

## The resident-runtime boundary — why A is B's foundation

This is the design's spine and the reason A is not throwaway. peerd's turn
machinery is already split exactly where the A↔B seam needs to be:

```
turn-driver.js  (the WRAPPER — stays SW-side in BOTH A and B)
   ├─ makeTurnCostTracker / maybeHalt / spendLimitUsd   ← spend cap
   ├─ the inbound clamp (ctx.inbound, when it lands)     ← unattended gate
   ├─ turnSlots (claim/release/runWhenIdle)              ← scheduler / anti-focus-theft
   ├─ vault.getSecret + safeFetch + webFetch + audit     ← key & egress
   └─ runUserTurn(...)   ← the INNER LOOP (the only thing B relocates)
```

- **Model A:** the resident runs through the whole stack in the SW —
  `runAgentTurn({ sessionId: resident })`. The wrapper enforces spend, clamp,
  scheduling; the loop calls `callModel`/egress directly. **Zero new turn
  runtime** — it reuses the existing driver, parameterized by session id.
- **Model B (Phase 2):** relocate **only `runUserTurn`** into a per-tab worker.
  The wrapper — cost meter, clamp, scheduler, key, egress — **stays in the SW**,
  now talking to the relocated loop over a streaming proxy (`callModel` Port +
  egress relay + a vault-`unlocked` relay + cross-boundary abort). Because the
  enforcement never leaves the SW, B does **not** reintroduce the regressions the
  split's first draft had (uncapped spend, an unclamped inbound path, an invisible
  second scheduler — all were artifacts of moving the *wrapper*, which we never
  do).

**The design rule for A, so A supports B:** keep every key/egress/cost/clamp/
scheduler concern in the turn-driver wrapper (where it already is), and keep the
resident loop's IO behind the existing injected `REQUIRED_CTX` seam. Then B is the
single, well-scoped act of filling that ctx from a worker-proxy instead of
in-process. Spec the seam once; cross it later.

## What A ships vs what the split (Phase 2) adds

| | Model A (ship now) | The split (Phase 2, JS-safety) |
|---|---|---|
| Inner loop runs | SW heap | per-tab worker (spawned by the host page) |
| Key in the loop's realm | held for `callModel` (SW heap) | **none** — `callModel` proxied |
| Defends prompt-injection | yes (gated tools) | yes (identical) |
| Defends a JS exploit of the loop reaching the key | **no** — shared SW heap | **yes** — the actual delta |
| New build | deny-set + `tell_instance` + `kind:'resident'` | streaming Port + abort + vault relay + worker host |
| Trigger | now | untrusted **code** live (dweb dwapps) + A battle-tested |

The split's value is real and the owner wants it sooner-not-later — but it is
precisely the JS-heap-isolation hardening, *not* the injection-boundary claim, and
it rides A's seam. Until then, A's keyless *tool* context (`restrictCtxCapabilities`
already strips `getSecret`/`safeFetch` from the tool ctx) is the proportionate
mitigation for the content threat.

## Hardenings carried from the adversarial review

A structurally **avoids** the split's four regressions (the loop is on the SW, so
spend-cap, scheduler, and clamp are native; a tab discard or App `reloadTab` can't
nuke a loop that isn't in the tab). Three findings still apply to A and are folded
in:

- **Ephemeral confirm for residents.** `sessionConfirmGrants` banks a blanket
  `yes_session` per session (`service-worker.js:1802`); a *persistent* resident
  would turn one user approval into standing self-approval it replays every turn.
  Residents use **per-turn** grants (no `yes_session` banking) — the runner's
  grant-less posture.
- **`tell_instance` inherits the inbound-clamp posture.** A `tell` from the user's
  own attended chat is first-party. A `tell` from an **unattended/cross-trust**
  sender (a scheduled task, a peer message) is inbound and must ride the
  `ctx.inbound` clamp that `FEATURE-SCHEDULED-TASKS.md` /
  `FEATURE-FIRST-CLASS-MESSAGING.md` are building. There must be **one** clamp;
  `tell_instance`'s non-attended path gates on it.
- **SW-side reply correlation** (above) — never a persisted sender pointer.

## Context shedding (goal #2)

Parent keeps create + `tell_instance` + list (~5 tools); the ~23 instance tools
move onto residents (minus `js_run`). Net: ~4.5–6 k tokens off every parent turn,
non-eroding. Recompute the per-resident prompt cost if residents go always-warm vs
lazy (below).

## Lifecycle

- **Binding: structural** (tracker entry). **Execution: lazy** — the resident is a
  persistent session but its loop only *runs* on a `tell` (idle/no-tokens between).
- **Persistence:** the resident session persists in IDB (`sessions/store.js`); the
  instance persists via registries + OPFS + per-VM disks; on SW boot
  `registry.load()` + `tabTracker.bootstrap()` re-adopt live tabs. A `tell` to a
  resident whose tab is gone re-spawns it via `ensureTab` (the resident is data,
  the tab is reconstitutable).
- **Death:** `tabs.onRemoved` → resident sleeps (session + instance survive) or, on
  `vm_delete`/`app_delete`, archives. Generalize `onTabClosed → queue.interrupt`
  (VM-only today, `:2031`) to all kinds so a closing tab cancels in-flight work.

## Security / invariants

- **Keyless tool context** (`restrictCtxCapabilities`) — against the content
  threat. The **shared SW heap is the known soft spot** (`docs/SUBAGENTS.md` names
  it); A accepts it as proportionate for untrusted *content* and Phase 2 closes it
  for untrusted *code*.
- **`confirm`/`audit` are SW-authoritative** (native in A; proxied in B). Residents
  never self-approve (ephemeral grants).
- **`webFetch` (allowlist-free, open-web) is the real exfil surface** — deny
  open-web tools to untrusted-input residents, as the runner does.
- **The isolate is the untrusted-code boundary** in both A and B (the loop never
  runs in the guest/worker/iframe).
- Reply `wrapUntrusted`; depth/trust/audit unchanged.

## Specifically NOT to do

- Resurrect an `ownerSessionId` pointer — the binding is the tracker entry.
- Build the streaming proxy now — that's Phase 2; A reuses the SW turn-driver.
- Move the cost meter / clamp / scheduler off the SW — ever (that's what creates
  the regressions; the wrapper stays SW-side in both models).
- Give residents standing `yes_session` grants.
- Treat `js_run` as an instance; run the loop in the isolate.

## Open questions

- **Which kinds get residents by default?** WebVM has the strongest case; Apps /
  Notebooks may not be worth the message hop — per-kind.
- **The inbound clamp** is a shared dependency (scheduled-tasks /
  first-class-messaging); `tell_instance`'s unattended path gates on it.
- **The user talking to a resident** in the side panel — `kind:'resident'` is a
  first-class session; does it appear in a switcher, or only via the tab?
- **Phase-2 trigger criteria** — what concretely counts as "untrusted code live"
  (the first dweb dwapp execution path?) that flips the split on.

## Phasing

1. **P0 — Model A core.** `kind:'resident'`; structural tab-tracker binding; the
   tool-shed deny-set; `tell_instance` (SW-side correlation + mailbox); residents
   run through the existing `runAgentTurn`. Ephemeral confirm. Behind a flag.
   *Battle-test + release this.*
2. **P1 — persistence + the conversational surface.** Durable resident sessions;
   the side-panel "talk to this instance" affordance; per-kind `*_RESIDENT_PROMPT`.
3. **P2 — the split (Model B), for JS-safety.** Relocate `runUserTurn` into a
   per-tab worker behind the proxy (streaming `callModel` Port, egress relay,
   vault-`unlocked` relay, cross-boundary abort), wrapper staying SW-side.
   Triggered by untrusted-code use cases + a battle-tested A. *Desirable
   sooner-not-later — the seam is designed for it from P0.*
4. **P3 — durable resume** across vault unlock / browser restart (DESIGN-08).

## The seam is the bet

A ships the actor model and the lean parent now, regression-free, by reusing the
SW turn-driver and a one-table tool-shed. The split is then **one well-scoped
relocation** — move the inner loop into a per-tab worker, leave the enforcement
wrapper in the SW — for the day untrusted *code* runs. **Design the seam once
(P0); cross it when the threat arrives (P2).** That's why A directly buys B.
