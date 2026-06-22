# Ralph — persistent fresh-context loop (feature 05)

> Feature design doc. Lives in `docs/` alongside `SUBAGENTS.md` (the
> project's per-feature design convention) rather than clobbering the
> root `DESIGN.md` (the 91 KB V1 system design). This IS the
> deliverable "DESIGN.md" for feature 05.

Ralph is a loop primitive that spawns **fresh-context** iterations
against a **plan file** until the plan is exhausted (or the user halts).
Reference points: Geoffrey Huntley's *Ralph*, Anthropic's `/loop` skill,
Hermes' `/goal`.

The single load-bearing idea: **persistence lives in the plan file +
git/checkpoints, never in an ever-growing context window.** Each
iteration is a clean slate. That is the discipline that makes a loop
runnable for hundreds of iterations without context rot, and the reason
this feature exists as a distinct primitive rather than "just keep
chatting."

```
read plan → pick ONE task → spawn fresh-context run → run gates
   → (pass) commit + mark done   → discard context → next
   → (fail) NO commit; retry fresh or block → discard context → next
```

## 1. The iteration state machine

`LoopState` (persisted at `ralph.loop.v1`) is a tiny record — a cursor,
not a context:

```
{ runId, status, iteration, maxIterations, currentTaskId,
  lastError, startedAt, updatedAt }
```

`status ∈ idle | planning | building | paused | done | halted | error`.

The **decision** for "what happens next" is a PURE function
(`decideNext(state, plan, signals)`), exhaustively testable with no IO:

```
halt signal / status=halted                → halted   (terminal)
iteration >= maxIterations                  → exhausted-iterations → error
plan.mode === 'planning'                    → plan      (one gap-analysis pass)
plan exhausted (no pending/in-progress)     → done      (terminal)
otherwise                                   → execute(taskId)
```

The **shell** (`runIteration`) acts on the decision and persists
`LoopState` + the plan file after every transition. One `runIteration`
call = one task attempt = the unit of resumability.

```
        ┌───────────── start (full-auto only) ──────────────┐
        ▼                                                    │
   ┌─ building ──────────────────────────────────────────┐  │
   │  pickNextTask  → write [~] to plan (single-writer    │  │
   │                  lock, crash-safe)                   │  │
   │  runFresh(task) → fresh subagent, no carried context │  │
   │  gateRunner.run → lint/test/build + console/DOM      │  │
   │     pass → checkpoint(commit) → mark [x] done        │  │
   │     fail → NO commit → failTask: [ ] retry or [!]    │  │
   │             block after maxAttempts                  │  │
   └──────────────────────────────────────────────────────┘ │
        │ plan exhausted            │ halt              │ iter cap
        ▼                           ▼                   ▼
       done                      halted               error
```

## 2. Fresh-context spawning

Each building iteration runs through the **subagent orchestrator**
(`makeSpawnSubagent`): a brand-new child session, depth-bounded, with the
plan **goal** + the **single task** as the only prompt. No history is
carried in. When the iteration returns, its context is discarded — only
the plan file (now with `[x]`) and the commit survive.

This reuses the existing fresh-context machinery rather than inventing a
second one: a Ralph iteration IS a subagent run with a task-scoped
prompt. The SW adapter `ralphRunFresh` builds that prompt and calls
`spawnSubagent`.

In tests, `runFresh` is a one-line fake — that's the DI seam that lets
the whole controller run standalone (`tests/peerd-runtime/ralph.test.ts`).

## 3. Plan-file format

GitHub-flavoured-markdown task list — human-editable, git-diffable,
trivially parseable. The plan file IS the durable memory.

```markdown
# Plan: ship the widget
<!-- ralph:meta {"version":1,"mode":"building"} -->

## Goal
Free-text north star. Carried verbatim into every fresh iteration so the
agent never loses the "why".

## Tasks
- [ ] pending task
- [~] in-progress task        (single-writer marker — at most ONE)
- [x] done task
- [!] blocked task: reason    (gate failed maxAttempts times)
- [ ] retried task (attempts: 1)
```

- `parsePlan` / `serializePlan` are pure and round-trip stable. Task ids
  derive from `index + slug(title)` so the SAME file re-parses to the
  SAME ids across restarts — resumability depends on stable ids.
- Reducers (`pickNextTask`, `completeTask`, `failTask`, `isPlanExhausted`)
  are pure and immutable; the iteration mutates the plan ONLY through
  them so the single-writer invariant stays checkable.

### Single-threaded writes (HARD constraint)

Exactly one task may be `[~]` in-progress at a time — that marker **is
the write lock**. `pickNextTask` refuses to hand out a second: if a task
is already in-progress it returns *that* one (resume), never a new one.
The in-progress marker is written to the plan file *before* the work
starts, so a crash mid-task leaves a recoverable `[~]` that the next
fresh iteration re-does from scratch (never half-committed).

## 4. Pluggable backpressure gates (the browser-native differentiator)

A gate is `{ name, kind, run(ctx) → {pass, detail} }`. The runner
executes them **in order** and **short-circuits on first failure** (fail
fast — don't inspect the live page if lint is already red). The runner
returns `{ pass, results }` — that is the `gates.run() → pass/fail`
interface the loop depends on.

Where terminal Ralph gates only on lint/test/build, peerd ALSO gates on
**live browser signals**, run IN-PROCESS through peerd's own tools — NOT
an external browser MCP (NO MCP is a hard constraint):

| kind      | gate              | how                                                |
|-----------|-------------------|----------------------------------------------------|
| `webvm`   | lint / test / build | shell command in the WebVM via injected `vmExec` |
| `browser` | **console-clean** | live page console-error buffer via `inspect`       |
| `browser` | **dom-contains**  | DOM snapshot contains an expected node via `inspect`|

`vmExec` and `inspect` are DI seams. In the SW, `vmExec` is
`vmClient.run` (the WebVM shell) and `inspect` reads the live page's
console + DOM through `read_page` / `page_exec` (peerd's own tab tools).
A gate that throws is a **failure**, not a loop crash. An empty gate list
passes vacuously (planning mode has nothing to verify).

Default set: `lint → test → build → console-clean`. A plan can override
the gate list (the **feature-10 hooks** adapter: a hook system appends
gates).

## 5. SW-restart resumability

MV3 service workers die after ~30 s idle. The loop survives because:

1. **Every transition persists** `LoopState` (`ralph.loop.v1`) and the
   plan file (`ralph.plan.v1`) to `chrome.storage.local`.
2. **Each iteration is independently resumable** — `runIteration`
   re-reads the plan + state; nothing in-memory is required.
3. On cold start the SW calls `ralph.resume()` (after the vault resumes,
   since a run needs unlocked secrets). It rehydrates `LoopState` + the
   plan and continues the SAME run from the next iteration. **No context
   is restored — only the cursor + the plan.** That is the whole point.
4. The `[~]` marker makes a crash *mid-task* safe: the resumed run sees
   it and re-does that task with fresh context, never half-committing.
5. `drive({ budget })` runs iterations in **budgeted bursts** so one
   awake-window can't exceed 30 s; `driveRalph` chains bursts with
   `setTimeout(0)` between iterations so halt/status RPCs interleave, and
   the offscreen keepalive port keeps the SW alive across a long run.

No aggressive auto-compaction anywhere — the anti-long-context design
removes the *need* for it. (See cross-cutting checklist below.)

## 6. Planning vs building modes

- **Planning** — `plan.mode === 'planning'` runs exactly one
  gap-analysis pass: a fresh run produces/refreshes the plan file
  (prioritized `## Tasks`), then the plan flips to `building`. Guards
  against looping forever in planning (no plan produced ⇒ flip anyway).
- **Building** — the steady state: pick one task, do it, gate, commit.

`ralph.start({ mode: 'planning' })` forces an up-front planning pass;
`{ mode: 'building' }` (default) executes an already-written plan.

## 7. Adapters (thin seams for the parallel features)

All of 01/02/03/10 build in parallel; Ralph sits on top with clean,
mockable interfaces:

| Feature | Interface Ralph depends on        | SW adapter           |
|---------|-----------------------------------|----------------------|
| 01 plan/persistence | `planStore` over `kv` (`load/save/loadText/saveText`) | `createPlanStore({ kv })` |
| 02 checkpoint/commit | `checkpoint(msg) → { ok, ref }` | git commit in the session's WebVM |
| 03 permissions tier  | `canRunUnattended() → bool` (refuse start otherwise) | `resolveCanRunUnattended`: Act mode + confirmActions OFF |
| 10 hooks for gates   | `gateRunner.run(ctx) → { pass, results }` | `createGateRunner([...gates])` |

Each is a one-liner to mock, which is exactly why the loop runs
standalone in the Bun test.

## 8. Cross-cutting checklist

- **No long-lived context / no aggressive auto-compaction** — every
  iteration is a fresh subagent session; persistence is the plan file +
  commits. The panel's event log is a bounded ring (50 lines). The SW
  holds only a tiny `LoopState`, never conversation history.
- **Single-threaded writes** — at most one `[~]` task; `pickNextTask` is
  the lock; `driveRalph` is re-entrancy-guarded (`driving`) so two
  drives can't run concurrently.
- **Browser-native** — at least one browser gate (console-clean) ships in
  the default set, run via peerd's own tools, NO MCP.
- **MV3 30 s** — budgeted bursts + per-iteration persistence + boot
  resume; reuses the existing offscreen keepalive.
- **Reversibility** — work is committed (git) only after gates pass;
  `ralph/reset` clears state; the plan file is hand-editable.
- **Permissions** — refuses to start unless the trust tier is full-auto
  (it commits unattended).
- **a11y / reduced-motion** — the status line is an `aria-live` region;
  the log just appends (no auto-scroll animation).
- **No telemetry, no bare fetch** — all network is the model call via the
  injected (egress-gated) provider; gates use the WebVM + tab tools.
```
