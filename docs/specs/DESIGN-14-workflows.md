# DESIGN-14 — workflows: recipe capture and repeatability

> Status: DESIGN. Nothing here is implemented. Feature number 14.
> Depends on shipped systems (skills/DESIGN, composer, sessions, the
> policy-gated dispatcher, per-session toolManifest) and on DESIGN-08
> (schedule) for the rerun primitive. Read those first.

## Motivation

This is the stickiness feature. A user gets the agent to do something
real and multi-step — "pull this week's open invoices from the billing
portal, total them, drop the summary in a notebook" — and today that
work evaporates when the session ends. The next time they want it, they
re-prompt from scratch and hope the agent rediscovers the same path.

A **workflow** turns a successful task into a reusable, inspectable,
re-runnable artifact:

- Save a successful browser task as a reusable **recipe**.
- Turn a recipe into a **slash command**.
- Let the user inspect/edit the recipe's **permissions and allowed
  origins**.
- Add **scheduled/manual reruns** — but only after the permission model
  is unmistakably clear.

The good news from the codebase survey: **every primitive already
exists.** The dispatcher records policy lineage, origins, hooks, and
duration on every tool result. Sessions persist the complete turn-log.
Skills are just text and already surface as `/<name>` commands through
`composer/command-sources.js`. Sessions already carry a `toolManifest`
for per-session tool narrowing. DESIGN-08 already specs durable timers.
A workflow is mostly *assembly* of things that ship — plus one real
design decision (below) and one new editor surface.

## The core decision: what IS a recipe?

Three models. The choice determines everything downstream.

- **(A) Deterministic replay.** Store the exact recorded tool calls and
  re-dispatch them. Brittle on the open web: DOM selectors drift, dynamic
  data shifts, dates move, a logged-out session breaks step 1. Fine for
  pure compute / `call_api` sequences; a trap for browser tasks — which
  is exactly the case the feature is for.
- **(B) Adaptive playbook.** Distill the session into a parameterized
  natural-language procedure plus the tool/skill sequence, and let the
  agent *re-execute it adaptively* with fresh context. Robust to UI
  drift. This is, almost exactly, **what a Skill already is**.
- **(C) Hybrid (recommended).** An adaptive playbook that *also* carries
  the recorded concrete values (selectors, args, origins) as **hints and
  guardrails**, not as a rigid script. The agent follows the playbook,
  uses the hints to go fast, and the captured origin/tool set becomes the
  *permission envelope* the run is confined to.

**Recommendation: (C), built on the Skills system.** A recipe is a
generated skill body + a permission/origin **manifest** sidecar +
declared **parameters**. This reuses the skill store, the progressive-
disclosure `load_skill` path, and the skill→slash-command adapter
wholesale. We are not building a new execution engine; we are recording a
playbook and constraining how it reruns.

This also keeps the boundary with memory (DESIGN-13) crisp: **memory is
what's true; a recipe is what to do.** A recipe is permissioned,
versioned, and parameterized; memory is not.

## The recipe object

Stored as a Skill (`SKILL.md` text + frontmatter) plus a recipe manifest.
The manifest is the new part:

```jsonc
{
  "kind": "recipe",
  "name": "weekly-invoice-summary",      // kebab; becomes /weekly-invoice-summary
  "description": "Total this week's open invoices and write a summary.",
  "version": "1.0.0",
  "params": [
    { "name": "week_of", "description": "ISO date of the Monday", "example": "2026-06-15" }
  ],
  "envelope": {
    "mode": "act",                       // recipes are side-effecting by nature
    "tools": ["do", "get", "check", "js_run", "remember"],   // -> session.toolManifest
    "origins": ["https://billing.example.com"]               // captured from lineage
  },
  "playbook": "<the SKILL.md body: NL steps + tool sequence, with {{week_of}} placeholders>",
  "hints": {                             // optional deterministic accelerators (model C)
    "selectors": { "...": "..." },
    "recordedArgs": [ /* per-step arg snapshots */ ]
  },
  "source": { "sessionId": "01ARZ...", "capturedAt": 1718700000000 }
}
```

Where each field comes from is the whole trick:

- **`playbook`** — distilled from `session.messages` by a cheap,
  clean-context model call (the same pattern as auto-memory's extraction,
  DESIGN-09): summarize the turn-log into ordered, parameterized steps.
  The user edits it before save.
- **`envelope.origins`** — *not* guessed. The dispatcher already attaches
  `origins` and the gate lineage to every `ToolResult.meta`. Walk the
  session's tool results, union the origins actually touched → that's the
  allowlist. This is the feature's spine: the permission envelope is
  *derived from what the successful run actually did*, so it's tight by
  construction.
- **`envelope.tools`** — union of tool names used in the session.
- **`params`** — the distiller proposes placeholders for values that
  look like inputs (dates, search terms, target URLs); the user confirms
  and names them.

## Capture flow

1. Session completes successfully. The chat offers **"Save as recipe"**
   (and the user can also invoke it on any past session from history).
2. A clean-context distiller call produces a draft: playbook + proposed
   params + the derived tool/origin envelope (origins/tools are computed
   deterministically from lineage, *not* by the model — the model only
   writes prose).
3. The user reviews and edits in the **recipe editor** (next section),
   names params, tightens origins.
4. On save, store as a skill (`installFromLocal`-style, `source:'recipe'`,
   `origin: sessionId`) plus the manifest sidecar. It immediately appears
   as `/weekly-invoice-summary` in the composer palette via the existing
   `skillRegistrySource()`.

## The permission/origin editor (the gate before reruns)

The feature brief is explicit: scheduled reruns come **only after the
permission model is very clear.** So the editor is not optional polish —
it is the thing that makes unattended rerun safe, and it ships *before*
scheduling.

A recipe-detail view (in Options, next to Skills) showing:

- **Allowed origins** — the derived list, each toggleable/removable, with
  an "add origin" field. Intersected with the denylist at run time (the
  denylist always wins). Shown exactly as the run will enforce them.
- **Tool set** — the captured tools, editable; becomes the run's
  `session.toolManifest` (per-session narrowing already exists).
- **Permission mode** — recipes default to **Act** (they have side
  effects) with **confirmActions ON** for attended runs. The editor makes
  this explicit and lets the user see what "unattended" would change.
- **Parameters** — names, descriptions, defaults.
- **Dry-run / Plan preview** — run the recipe in **Plan mode** first: it
  walks the playbook read-only (Plan permits reads + pure nav, never
  clicks — DECISIONS #16) and reports what it *would* do and which
  origins it *would* touch, surfacing drift before any side effect.

## How a recipe reruns

A rerun is a normal agent turn, pre-loaded and pre-constrained:

1. Resolve params (from `/cmd key=value`, or prompt the user for missing
   ones).
2. Open a session with `toolManifest = envelope.tools`,
   `permissionMode = envelope.mode`, and an **origin allowlist scoped to
   `envelope.origins ∩ (not denylisted)`** installed for the run.
3. Inject the playbook (the `load_skill` body) with params substituted as
   the opening instruction.
4. Run. Every tool call still passes the policy-gated dispatcher — the
   recipe envelope *narrows* what's permitted; it never *widens* it or
   bypasses policy. A recipe cannot grant itself an origin the denylist
   blocks, nor a tool the channel doesn't expose.

The origin scoping is the new enforcement bit. Options, cheapest first:
a **pre-tool-use hook** (the hooks system is already the egress-
enforcement seam) installed for the run that rejects tool calls whose
origins fall outside the recipe envelope. This reuses existing
machinery and keeps the envelope as a *hook-level* constraint layered on
top of the global denylist.

## Slash command

Falls out for free. The recipe is a skill; enabled skills already become
`/<name>` via `composer/command-sources.js`. Params render as
`/<name> arg=value` (parsed by `composer/parse.js`'s arg parser) with
missing required params prompted. Local `.peerd/commands/` entries still
shadow recipe commands (user override), per the existing merge order.

## Scheduled / manual reruns (last, and gated)

Built entirely on **DESIGN-08 (schedule)** — do not invent a second
timer. A scheduled recipe is a DESIGN-08 durable task whose action is
"re-enter a session running recipe X with params P."

Hard gates, all required for an *unattended* scheduled run:

- The recipe must have a saved, user-reviewed envelope (you cannot
  schedule a recipe you never opened the permission editor for).
- Unattended runs require **Act + confirmActions OFF**, which is the
  full-auto tier — already a real, gated capability (goal mode reuses it,
  `peerd-runtime/loop/goal-runner.js`).
  Attended scheduled runs (confirm each side effect) need only Act.
- Honest semantics inherited from DESIGN-08: **runs only while the
  browser is running**; the UI says so in those words.
- Every scheduled fire writes an audit entry (`tool_executed` chain plus
  a `recipe_run` event) and is visible in history; a failed/blocked step
  halts the run and notifies, it does not silently retry.

## Phasing (deliberately ordered by the brief)

1. **Capture + slash command.** Distill → editor (params + playbook) →
   save as skill → `/run`. Manual, attended runs only. Delivers the
   "save a task, run it again" core.
2. **Permission/origin editor + dry-run.** The envelope made fully
   visible and editable; origin-scoping hook enforced at run time. This
   is the explicit prerequisite the brief names.
3. **Scheduled reruns.** Only after (2), on top of DESIGN-08, behind the
   full-auto gate.

## MCP / local tools

The brief's "MCP-localhost / constrained MCP bridge" bullet is a
*transport* question, not a workflow question — it's about what tools the
agent can reach, and it collides with a stated peerd thesis. It is specced
separately in **DESIGN-15 (local bridge)** so the workflow design doesn't
quietly smuggle in a thesis reversal. Recipes are transport-agnostic: if
MCP-localhost tools ever exist, they're just more tools a recipe's
envelope can capture and constrain.

## Security / invariants

- A recipe **narrows, never widens.** The envelope is a subset filter on
  top of the global denylist + channel exposure + Plan/Act. No recipe can
  reach an origin the denylist blocks or a tool the channel hides.
- The origin envelope is *derived from observed lineage*, not authored by
  the model — tight by construction, then only loosened by an explicit
  human edit.
- Distillation is read-only over a stored transcript; it writes no
  memory and touches no web origin.
- Scheduled unattended runs ride the existing full-auto gate; there is no
  new "trust this recipe forever" bypass.
- New pure logic (envelope derivation from lineage, param extraction,
  playbook assembly) lives in a testable core with Bun tests; the editor
  is Mithril in Options.

## Open questions

- Distillation quality: how much hand-editing will real recipes need
  before they rerun cleanly? Phase 1 should treat the playbook as a draft
  the user *expects* to edit, not a finished artifact.
- Versioning on drift: when a rerun's dry-run shows the site changed,
  do we auto-bump the recipe from the corrected run? Leaning: offer
  "update recipe from this run" as an explicit action, never automatic.
- Sharing recipes over the dweb (preview channel): a recipe is a skill +
  manifest, both already shareable shapes — but the origin envelope is
  user-specific. Defer; flag in `docs/distributed/ROADMAP.md`.
