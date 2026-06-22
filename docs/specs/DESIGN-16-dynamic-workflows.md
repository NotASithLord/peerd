# DESIGN-16 — dynamic workflows: orchestration-at-scale, the plan in code

> Status: DESIGN. Nothing here is implemented. Feature number 16
> (08 schedule, 11 async-subagents, 13 memory-v2, 14 workflows/recipes,
> 15 local-bridge taken). Depends on the shipped subagent orchestrator
> (`peerd-runtime/subagent/`, DESIGN-11), the headless `js_run` worker
> substrate (`offscreen/job-runner.js`, `notebook-tab/worker-source.js`),
> skills + composer, and the six-gate dispatcher. Read `docs/SUBAGENTS.md`
> and `DESIGN-11-async-subagents.md` FIRST — this design lives or dies on
> not violating their doctrine.
>
> Prompted by Claude Code's "dynamic workflows" feature
> (code.claude.com/docs/en/workflows, the `ultracode` / `/deep-research`
> surface).

## Two unrelated things are both called "workflow"

Disambiguate before reading further — the collision is real and will
otherwise waste a session:

- **DESIGN-14 — "workflows" = recipe capture.** Save ONE successful
  multi-step browser task as a rerunnable, permissioned, parameterized
  **skill** (`/weekly-invoice-summary`). The axis is *repeatability of a
  task*. Orchestration is incidental — a recipe usually runs one agent
  path, adaptively.
- **DESIGN-16 (this doc) — "dynamic workflows" = orchestration at
  scale.** Run MANY agents from a script the agent writes, where the
  *plan itself* lives in code rather than in the model's turns. The axis
  is *scale + keeping orchestration out of the context window*. A single
  workflow run might fan out dozens of agents.

They converge at exactly one point — both can be **saved as a
`/command`** — and that's reused, not rebuilt (see §Saving). Everything
else is distinct. Where this doc says "workflow" unqualified it means the
DESIGN-16 sense.

## What the feature actually is

Strip away the CLI packaging and a dynamic workflow is one idea: **move
the orchestration plan out of the model's turns and into a script the
runtime runs.** Every property follows from that:

- **Intermediate results live in script variables, not the context
  window.** The parent session only ever sees the final return value.
  This is the whole point — it's how you run a hundred agents without
  drowning the parent context, and it's a capability peerd does NOT have
  today (see §The gap).
- **The script holds the loop, the branching, the joins.** The model
  isn't deciding turn-by-turn what to spawn next; the code is. The model
  *writes* the script once, up front.
- **Deterministic quality patterns become expressible.** "Draft this
  plan from three independent angles and have a fourth agent adversarially
  cross-check them" is a loop in code, not a hope about what the model
  does this turn. This is the real argument for the feature over plain
  fan-out — repeatable rigor, not just more agents.
- **It's a saveable, inspectable artifact** — the script is a file you
  can read, diff, edit, and rerun.

Claude Code gates a run behind an explicit approval prompt and bounds it
(16 concurrent, 1000 total per run). Those aren't incidental — they're
load-bearing here too (see §Cap reconciliation).

## The gap this fills (why it isn't already covered)

peerd's `spawn_subagent` (async by default, DESIGN-11) is real fan-out:
the model emits N calls, children run fire-and-forget, results coalesce
back. But every child result **re-enters the parent context** as a
synthetic wake turn (`subagent/async-subagents.js:112-135`). Coalesced,
yes — but it lands in the window. And the anti-runaway caps (4
outstanding, 8/min) deliberately make large fan-out *impossible*
(`async-subagents.js:51-58`).

So peerd has nothing that:

1. keeps orchestration **and** all intermediate results OUT of the parent
   context, and
2. does so at a scale the current caps are specifically built to refuse.

That's the gap. It also partially answers the standing backlog item
"lineage-based context compression for very long sessions" (`CLAUDE.md`)
from the other end: a workflow never *grows* the context in the first
place.

## The trap: the substrate exists, and the obvious wiring is forbidden

peerd already ships both ingredients for a naive implementation:

- `js_run` → the headless sealed worker (`offscreen/job-runner.js`).
- `peerd.runtime.runAgent` → an embedded agent callable from inside
  sandbox code (`notebook-tab/worker-source.js:147-152`, routed through
  the `subagent/spawn` SW route → `makeSpawnSubagent`).

So mechanically, "a `js_run` script that calls `runAgent` in a loop"
*is* a workflow. **Do not build it this way.** `docs/SUBAGENTS.md`
forbids precisely this shape, twice:

> **Specifically NOT to do:** Using `peerd.runAgent` to fan out the
> model's OWN work (a scratch sandbox that `Promise.all`s runs). The
> model parallelizes by emitting multiple `spawn_subagent` tool calls;
> `runAgent` is only for apps the agent builds that embed an agent inside
> themselves. (`docs/SUBAGENTS.md`, §"Specifically NOT to do" and
> §"The two surfaces")

The reasons are load-bearing, not stylistic:

1. **Visibility/audit is peerd's identity.** Every `spawn_subagent` is a
   visible chip, runs the six gates, and is audited with `parentSessionId`
   + depth (`subagent/spawn.js:305-310`). `runAgent`-from-sandbox "buys
   no isolation… it just hides the delegation." A workflow that fans out
   through `runAgent` would be invisible and unaudited — the exact
   property the brand won't ship.
2. **The caps exist to stop this.** The runaway guard
   (`async-subagents.js:14-20`) was written against a literal fan-out
   loop that "opened/closed research tabs until the browser had to be
   force-quit." A `Promise.all` of `runAgent` routes straight around it.

The feature is good. The obvious implementation is the one thing the
codebase explicitly outlaws. The rest of this doc is how to get the
former without the latter.

## The core decision: a first-class orchestration primitive, not a `runAgent` hack

**A workflow is a new orchestration surface in `peerd-runtime` (the *r*
letter), a sibling to `spawn_subagent` — not a use of
`peerd.runtime.runAgent`.** This is the same call `docs/SUBAGENTS.md`
already makes for subagents: "who is reasoning about the next step" is the
agent loop, the *r* letter, not an engine kind. A workflow is "who is
*coordinating* the next step" — still *r*, still orchestration, just with
the coordinator being a script instead of the model's turn.

Concretely:

- The workflow **script runs in the sealed-worker substrate** (your
  `js_run` instinct, correct) — `offscreen/job-runner.js`, no tab, the
  same isolate untrusted code already gets. The script is untrusted
  *code*; the realm boundary is exactly right for it.
- The script's **agent-spawning calls route through the SAME
  orchestrator** the `spawn_subagent` tool uses — `makeSpawnSubagent`
  (`subagent/spawn.js:174`) — NOT a relaxed `runAgent`. So **audit,
  the six gates, parentage, depth, tool-narrowing, and trust-mode
  inheritance all still hold** for every agent a workflow spawns. We move
  the *loop* into code without relaxing the *gate chain*. That is the
  entire reconciliation: the thing `runAgent`-fan-out strips (visibility +
  gates), the workflow primitive keeps.

The difference from a sandbox calling `runAgent` is not the mechanism —
both end up in `makeSpawnSubagent`. The difference is that a workflow is a
**recognized, gated, surfaced** orchestration mode with its own approval,
its own caps, and its own run view, whereas `runAgent`-fan-out is the same
power smuggled in unlabeled. We're not adding capability; we're adding the
labels, gates, and visibility that make the capability shippable.

## Architecture

```
 user prompt ("ultracode: audit every route for missing auth")
   │
   ▼
 model writes a workflow SCRIPT (one artifact, reviewed before run)
   │
   ▼  approval gate (§Approval)
   │
 workflow runtime  (offscreen sealed worker — offscreen/job-runner.js)
   │   script holds: the loop, branching, intermediate results (variables)
   │
   │   peerd.workflow.spawn({ task, tools, model, ... })   ← the ONE bridge
   │        │   (NOT runAgent; a distinct, workflow-only host call)
   ▼        ▼
 host (SW)  ──►  makeSpawnSubagent(...)  ──►  six gates · audit · parentage
   │                                          (one child session per spawn)
   │   child results return to the SCRIPT, not the parent context
   ▼
 script computes a final value
   │
   ▼
 ONE result re-enters the parent session (wrapUntrusted, like a subagent)
```

### The script ↔ host bridge

A new host capability, exposed to the workflow worker only:
`peerd.workflow.spawn(req)` (and `spawnAll`, a bounded concurrent map).
It posts a `workflow/spawn` message to the SW; the SW dispatches it
through the existing bound `spawnSubagent`. Key points:

- It is **deliberately a different name and route from `runtime.runAgent`**
  so the doctrine line stays bright: `runAgent` is "an app the agent built
  embeds an agent"; `workflow.spawn` is "the workflow runtime coordinates
  agents." Code review can grep the boundary.
- The worker that runs a workflow script has `runtime.runAgent` **removed**
  from its `peerd.*` surface — a workflow orchestrates through
  `workflow.spawn` or not at all. (Prevents the script from re-acquiring
  the ungated path.)
- Every spawn carries `parentSessionId` = the workflow's owning session,
  `parentDepth`, and the workflow run id, so the audit trail reconstructs
  from any level and the depth cap (`DEFAULT_MAX_DEPTH = 5`) still bites.

### Intermediate results stay in the worker

The script's variables hold every child's output. The host never folds
those into the parent session — only the script's final return value
re-enters, wrapped `wrapUntrusted` (it's model-authored over possibly
page-derived bytes, same trust posture as a subagent result,
`async-subagents.js:117-119`). This is the context-window win, and it
falls out for free from running the loop in the worker.

## Cap reconciliation (the part most likely to be done wrong)

peerd's per-parent caps — 4 outstanding, 8 spawns / 60s
(`async-subagents.js:51-56`) — are **anti-runaway caps for *implicit*,
model-driven fan-out**: the model shouldn't be able to accidentally
spin up an unbounded burst. A workflow is the *opposite* situation:
an **explicit, user-approved, bounded batch**. Applying the anti-runaway
caps to it would defeat the feature (you can't run 30 agents under a cap
of 4); ignoring caps entirely reintroduces the force-quit bug.

The resolution: a workflow run gets its **own cap regime**, distinct from
the per-parent async caps:

- **Per-run concurrency cap** (mirror CC: ≤16, lower on constrained
  machines — but peerd runs in a browser SW, so start *much* lower, e.g.
  4–6 concurrent child loops, tunable).
- **Per-run lifetime cap** (mirror CC's 1000; peerd should start far
  lower, e.g. 100, given SW memory).
- These are **gated behind the explicit approval** (§Approval). The
  per-parent anti-runaway caps do NOT apply inside a workflow run, because
  the approval is the human bound the caps were standing in for.

State the invariant plainly: *implicit* fan-out stays capped at 4/8-per-min
forever; *explicit, approved* fan-out gets the batch caps. The approval is
what flips which regime applies.

## Visibility: the run view is non-negotiable

CC keeps delegation visible with a `/workflows` progress view (phases,
per-agent token/time, drill-in to each agent's transcript). For peerd this
is not optional polish — it's how the feature stays consistent with "every
delegation is visible," the value that forbids `runAgent`-fan-out in the
first place. Minimum bar:

- A **workflow run card** in the side panel: live status, child count,
  cumulative tokens/cost, elapsed.
- **Drill-in** to each spawned child's session (we already render subagent
  child transcripts inline, indented, recursive — `docs/SUBAGENTS.md`
  §data-model; reuse that surface keyed by the run id).
- The script artifact itself is **viewable before approval and after**
  (it's just text in the worker's OPFS scratch / session dir).

If the run view doesn't ship, the feature doesn't ship — an unaudited
hundred-agent fan-out is precisely what the codebase refuses today.

## Approval & permission model

- A workflow run is **side-effecting by nature** and explicitly an Act-tier
  thing. In **Plan mode** the agent may WRITE a workflow script and show it,
  but launching is refused (consistent with `decideAction`).
- Launch requires an **explicit approval** surfacing the script's planned
  shape (phases / spawn count estimate) and a token-cost caution — the
  peerd analog of CC's per-run prompt. Reuse the confirmation gate
  (`confirmActions`), not a new modal framework.
- **Spawned children inherit the parent's Plan/Act + confirm posture**
  through `makeSpawnSubagent` already (`subagent/spawn.js:283-298`). No
  escalation: a workflow can't grant its children more than the session
  has.
- **Tool envelope:** the workflow declares the tool set its children may
  use; it intersects with the session's `toolManifest` exactly as subagent
  narrowing already does (`narrowTools` + `resolveManifestAllow`,
  `subagent/spawn.js:60-73, 316-317`). A workflow can't widen the surface.
- **Store posture:** like remote skill install (`REMOTE_SKILL_INSTALL`
  off on store), default the whole feature **off on the store channel**
  behind a flag until the approval + run-view surfaces are proven. It's a
  preview/dev capability first.

## Saving — the one convergence with DESIGN-14

A workflow whose script did what the user wanted should be **saveable as a
`/command`**, identical plumbing to a DESIGN-14 recipe: it's a skill body
(here, an orchestration script + a manifest declaring its tool/origin
envelope) that surfaces through `composer/command-sources.js` →
`skillRegistrySource()`. A saved workflow accepts input via an `args`
global (CC's convention; cheap to mirror).

So the taxonomy of saved `/commands` becomes:

- a **skill** — instructions the agent follows;
- a **recipe** (DESIGN-14) — one parameterized, permissioned task path;
- a **workflow** (this doc) — a parameterized orchestration script.

All three reuse the skill store, `load_skill`, and the slash-command
adapter. None needs a new persistence layer.

## Background execution & resumability

CC workflows run in the background and are resumable *within the same
session* (cached results for finished agents, live for the rest); a
process exit starts them fresh. peerd's parity is worse by default: the
SW dies more aggressively than a CLI process, and subagent children are
**in-session only — lost to SW death, reported `interrupted` on the next
drain** (`docs/SUBAGENTS.md` §async, `async-subagents.js:12-13`). So:

- **v1: in-session only**, same honesty as subagents today. A workflow
  interrupted by SW death reports partial results; no resume.
- **Durable resume depends on DESIGN-08 §4 / phase 08d (durable
  subagents)** — the same primitive that lets an async subagent survive a
  browser restart. Don't front-run it; land in-session first, add resume
  when durability ships. The runtime should record per-child completion
  (cache) from day one so resume is a later addition, not a rewrite.

## Guardrails (non-optional)

1. **Spawns route through `makeSpawnSubagent` only.** No path from a
   workflow script to an ungated agent loop. `runtime.runAgent` is removed
   from the workflow worker's `peerd.*`.
2. **Depth cap still applies** (`DEFAULT_MAX_DEPTH = 5`): a workflow
   counts as a depth level; its children are depth+1; a child workflow
   intersects again. No depth at which gating evaporates.
3. **Own batch caps, behind approval** (§Cap reconciliation). The
   per-parent anti-runaway caps remain the law for implicit fan-out.
4. **Tool/trust inheritance via the existing narrowing** — a workflow
   never widens the session's tool or permission envelope.
5. **Every spawn audited** with the run id + parentage + depth (free via
   `taggedAudit`, `subagent/spawn.js:305-308`).
6. **Only the final return re-enters the parent context**, `wrapUntrusted`.
7. **Visible run view ships with it** — no headless hundred-agent fan-out.

## Specifically NOT to do

- Implementing workflows as `peerd.runtime.runAgent` fan-out from a
  `js_run` script. This is the codebase's named anti-pattern; the whole
  point of DESIGN-16 is to provide the *labelled, gated* alternative.
- A fourth/fifth engine kind for "workflow." It's orchestration (*r*),
  not an environment (*e*) — same argument as subagents
  (`docs/SUBAGENTS.md` §"Why a subagent isn't an engine kind").
- Lifting or bypassing the per-parent anti-runaway caps for *implicit*
  fan-out to "make room" for workflows. The two regimes are separate on
  purpose; the approval is the discriminator.
- Shipping the orchestration before the run view / approval surface.
- Defaulting it on for the store channel before the surfaces are proven.
- Letting a workflow script reach `getSecret` / `safeFetch` / dweb-sign
  closures — the worker is untrusted code; `restrictCtxCapabilities`
  discipline (`subagent/spawn.js:126-132`) is the model to follow for any
  capability the script's children don't explicitly need.

## Open questions

- **Does peerd want this at all in 0.x?** It's a large surface landing in a
  store-readiness window. The honest default is: spec it (this doc), ship
  nothing until the subagent/visibility foundations and DESIGN-08
  durability make it cheap. The gap it fills (context-free orchestration at
  scale) is real but not urgent.
- **Concurrency ceiling in a browser SW.** CC's 16 assumes a workstation.
  What's the real safe ceiling for concurrent child agent loops in an MV3
  service worker before keepalive/memory pressure bites? Needs measuring,
  not guessing.
- **`ultracode`-style auto-orchestration** (the model *chooses* to write a
  workflow for any substantial task) is almost certainly too aggressive for
  a browser agent spending the user's own API credits. If adopted at all,
  it's strictly opt-in and far behind the explicit `workflow.spawn` path.
- **Cost surfacing.** A workflow can outspend a normal session by a large
  multiple. The existing `spendLimitUsd` / CostChip must bound a run, and
  the approval must show an estimate. Where does the per-run estimate come
  from before the run exists?

## Phasing

1. **Primitive only.** `peerd.workflow.spawn`/`spawnAll` in the offscreen
   worker, routed to `makeSpawnSubagent`; in-session; own batch caps;
   approval gate; basic run card. No save, no resume, no auto-mode.
   Preview channel, flag-gated.
2. **Run view + drill-in**, reusing the subagent transcript surface.
   Cost estimate in the approval.
3. **Save as `/command`** (converges with DESIGN-14 plumbing) + `args`.
4. **Durable resume**, once DESIGN-08 §4 / phase 08d lands.
5. (Maybe never) an `ultracode`-style auto-orchestration effort tier.
