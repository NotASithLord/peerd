# DESIGN-19 — reversible execution traces (Shepherd-style fork/revert) — proposal, undecided

Status: **proposal, not adopted.** This is a tracking doc for an idea, not a
committed roadmap item. It exists so the option is written down with an
honest read of where peerd already has the pieces and where it doesn't,
before anyone commits build time to it.

---

## 1. The idea, in one paragraph

[Shepherd](https://github.com/shepherd-agents/shepherd) (Stanford, early
alpha) is a runtime substrate that turns an agent run into a reversible,
Git-like trace instead of a flat message log. A "scope" exposes four
primitives — `emit` (append an effect), `fork` (open a copy-on-write child
scope), `merge` (fold a child's effects into its parent), `discard`
(abandon a child, reverting the worker to its pre-fork state). `fork`
captures the worker's filesystem, processes, and bindings together in one
COW step — reported ~5x faster than `docker commit`, with ~95% KV-cache
reuse on replay because the unchanged prompt prefix through the fork point
never gets reprocessed. On top of that, a "meta-agent" can watch the trace
and revert a bad step before it's committed, rather than either patching
forward (more tokens, growing context) or restarting the whole run (pays
for every step again, and is non-reproducible anyway since the run isn't
deterministic). Their own numbers: a supervisor meta-agent lifted
[CooperBench](https://github.com/shepherd-agents/shepherd) pair-coding pass
rate from 28.8% to 54.7%. Also explicit in their framing: not everything is
reversible — file/sandbox state undoes itself, but a database write needs a
hand-authored undo step, and something truly external (a sent email, a
real charge) can only be *caught before it fires*, never undone.

Sources: [shepherd-agents/shepherd](https://github.com/shepherd-agents/shepherd),
[arXiv:2605.10913](https://arxiv.org/abs/2605.10913) ("Shepherd: A Runtime
Substrate Empowering Meta-Agents with a Formalized Execution Trace").

## 2. Why it rhymes with peerd's shape

peerd already has an orchestrator/actor split that is structurally close to
Shepherd's supervisor/worker split: `peerd-runtime/actor/spawn.js` spawns a
bounded child (depth ≤ `DEFAULT_MAX_DEPTH`, step-capped, wall-clock-capped),
each child actor runs in its own throwaway offscreen Worker heap rebuilt
from its transcript every turn, and the orchestrator can already reach into
a running child and abort it (`actor_cancel` → `stopSubtree()` in
`spawn.js`, which walks the live-children registry and aborts every
descendant's turn slot). `delegation-lineage.js` already reconstructs a
full parent-chain ("who ultimately asked, and through what chain") for
every actor. That's most of Shepherd's *supervisor* half already built.

What's missing is the *environment* half: today `actor_cancel` stops a
child's reasoning loop, but it does not undo anything that child already
wrote to a sandbox. There is no COW snapshot of a Sandbox's state to fork
from or discard back to — cancelling a misbehaving actor stops it from
making things worse, it doesn't put things back the way they were.

## 3. What actually exists today (the honest gap read)

peerd has three trace-adjacent systems today, and they're disjoint:

- **Gate lineage** (`peerd-runtime/tools/gates.js`) — a typed,
  per-tool-call record of which gates ran and what they decided
  (Plan/Act, exposure, origin/denylist, confirmation, audit), attached to
  that call's `ToolResult.meta`. Ephemeral — lives only as long as the
  side panel keeps the message around.
- **Audit log** (`peerd-egress/audit/`) — a durable, hash-chained,
  append-only IndexedDB log of security-relevant events (`tool_executed`,
  `actor_spawned`, `permission_granted`, ...). Tamper-*evident*, not
  tamper-proof. Security-event-scoped: it records *that* something
  happened, not the state before/after.
- **Checkpoints** (`peerd-runtime/edit/checkpoint.js` +
  `edit/snapshot-store.js`) — a real, content-addressed, Git-object-model
  file store (SHA-256 blobs, parent-linked manifests) that captures an
  App workspace's files after every turn. But: **App workspaces only** —
  Notebook OPFS scratch is an acknowledged gap in the code comments, and
  VM disk state isn't a checkpoint scope at all. And it's
  **capture-only** — `diffSince()` feeds the review actor's "what changed"
  view; user-facing rollback over these snapshots was deliberately
  removed (`turn-driver.js`, **DESIGN-09**, 2026-06-12), though the
  parent chain is kept "so a future rollback could walk it."

None of the three captures live sandbox state (a running WebVM's process
state, a Notebook worker's in-memory bindings). Sandbox persistence today
is: VM disk is a single IndexedDB overlay with exactly one lifecycle op
beyond read/write — `reset()`, which deletes the whole overlay (no
snapshot, no fork, no partial rollback); Notebook OPFS has no snapshot
mechanism; App has metadata + an HTML body store, and a *second* IDB store
(`peerd-engine/app-store.js`) is explicitly commented as "reserved for the
future SNAPSHOT tier" and deliberately not re-exported from the module's
public surface — i.e. the one spot in the codebase already earmarked for
something like this.

Net: peerd can already *stop* a runaway actor. It cannot yet *fork* a
Sandbox's state to try something risky, or *discard* back to a known-good
point, because there's no COW primitive under any of the three Sandbox
kinds, and the one file-level system that's closest (checkpoints) is
scoped to one Sandbox kind and has had its rollback path intentionally
pulled.

## 4. Where the pieces would plug in, if built

Mapping Shepherd's shape onto peerd's modules, non-committally:

- **`scope.fork()` / `discard()`** → a COW snapshot primitive per Sandbox
  kind in `peerd-engine`. Each kind needs a different mechanism (VM: a
  copy-on-write layer over the block-device overlay instead of
  reset-only; Notebook: OPFS has no native COW, so this would mean either
  a content-addressed snapshot/restore pass similar to checkpoints, or
  accepting it's out of scope for a first cut; App: the reserved
  SNAPSHOT tier in `app-store.js` is the natural landing spot). This is
  the single largest lift — Shepherd gets COW cheaply because it's
  forking OS processes + a real filesystem; peerd's sandboxes are a WASM
  VM, a Worker + OPFS, and a sandboxed iframe, none of which offer that
  primitive natively.
- **The supervisor watching the trace** → an extension of the existing
  orchestrator/`spawn.js` relationship, not a new actor kind: the
  orchestrator already has `actor_cancel` and the lineage walk; a
  `actor_fork` / `actor_revert` tool would sit right next to it, keyed on
  the same session lineage `delegation-lineage.js` already tracks.
- **A unified, replayable trace** → merging the three disjoint systems in
  §3 into one typed event stream (gate lineage decisions + audit events +
  state-diffs), rather than inventing a fourth. This is largely a
  refactor/consolidation, not new capability.
- **KV-cache reuse on replay** → peerd's Anthropic provider already sets
  prompt-cache breakpoints. If a supervisor reverts to step *N* and
  replays, reusing the existing breakpoint at *N* instead of reprocessing
  is plausible *if* the trace can guarantee a byte-identical prefix
  reconstruction — which needs the unified trace above to actually work.
- **What can't be auto-reverted** — peerd already has the right instinct
  here independent of Shepherd: egress confirmation gates and the
  denylist already exist specifically to catch irreversible actions
  (a real `fetch_url` POST, a VM `git push`, an A2A message to a peer)
  *before* they fire. A fork/revert layer wouldn't replace that — it
  would need to consult it, so a "revert" never claims to undo something
  that already left the browser.

## 5. Options

**Option A — close the existing, acknowledged gap first.** Extend
`checkpoint.js`'s scope from App-only to Notebook (closing the gap its own
comments flag), and reconsider DESIGN-09 narrowly: bring back a rollback
path, but scoped to *actor-initiated* changes only (an actor's spawn
session already has a lineage id to key snapshots off of), not a general
user-facing undo button. No new Sandbox-level COW primitive, no new
module. Small blast radius, reuses machinery that already works and is
tested.

**Option B — build the COW fork primitive.** Add real snapshot/fork/discard
to `peerd-engine` for at least one Sandbox kind (App is the obvious first
target — the SNAPSHOT tier stub already exists), wire `actor_fork` /
`actor_revert` next to `actor_cancel` in `spawn.js`, and let a goal-mode
supervisor use it. Bigger lift, real new capability, but only worth it if
goal-mode autonomous runs are actually burning meaningful tokens on
patch-forward recovery today — that's an empirical question this doc
doesn't answer.

**Option C — don't chase the general abstraction.** peerd's sandbox model
(three isolate kinds, no shared process/filesystem host) is different
enough from Shepherd's that a faithful port doesn't fit cleanly. Take only
the narrow, clearly-valuable idea — unify the three disjoint trace systems
in §3 into one typed, inspectable stream — as a trace/observability
improvement, and leave "fork a live Sandbox" as a bigger future bet pending
evidence it's needed.

**Recommendation:** Option A first — it closes a gap the code already
flags as a gap, reuses the checkpoint system that's already shipped and
tested, and is reversible in scope (pun intended) if it turns out not to
matter. Track Option B as a follow-on, gated on whether goal-mode usage
data shows actors actually thrashing on bad steps often enough to justify
building a COW primitive for browser-native sandboxes, which is a real
engineering lift with no existing prior art to lean on in this codebase.

## 6. Open questions

- Does goal mode (the autonomous loop) currently have telemetry on how
  often a run "goes off track" and self-corrects vs. needs a restart? If
  not, that's a cheap first step before committing to either option.
- If Notebook/VM checkpointing is added (Option A), does it get the same
  automatic after-every-turn capture as App checkpoints, or only on
  actor-spawn boundaries (cheaper, narrower)?
- Is there any acceptable approximation of COW for OPFS/WASM VM disk
  short of a real block-level overlay diff — e.g., is the existing
  content-addressed blob store (already dedup'd by hash) "good enough"
  fork/restore if snapshot frequency stays low?
- Would reviving any rollback UI need to revisit the DESIGN-09 rationale
  with the owner, or does an actor-scoped-only revert (not user-facing)
  sidestep whatever concern led to pulling it?

## 7. Non-goals for this doc

This proposal does not argue for adopting Shepherd's code directly (it's a
process/Docker-oriented Python framework; peerd is a no-build-step browser
extension) — only for the idea of a fork/revert-capable trace, evaluated
against what peerd's Sandboxes and actor model can actually support.
