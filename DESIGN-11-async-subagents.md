# DESIGN-11 — async subagents (non-blocking delegation, push-back-as-a-turn)

> Status: DESIGN, building Phase 1. Prior art studied: Hermes Agent
> `async_delegation`, LangChain deepagents async middleware, Kiro task graphs,
> OpenAI Codex, Vercel ai-sdk (2026-06-15 study). The cross-harness lesson:
> sync stays the *structural* default for "fan out and synthesise this turn";
> async earns its place only for "go do a thing while I keep working."

## Motivation

Today `spawn_subagent` **blocks the parent turn**: `spawn-subagent.js` does
`await ctx.spawnSubagent(...)` and the chat is frozen until the child's whole
loop drains (`spawn.js`). For a subagent that "goes and does something" (browse,
build, watch, a long fan-out) that freeze is the wrong UX — the user is locked
out of their own chat while the agent waits on itself.

The fix the owner wants as the **default** for `spawn_subagent`: the parent
fires off the child, **the turn ends**, the user keeps chatting, and when the
child finishes it **comes back as a new turn** carrying its result. No polling,
no task-id babysitting — *push on completion*. This sidesteps the #1 async
failure every other harness fights (premature-poll collapse): there is nothing
to poll.

## Scope: in-session, not durable

This design is deliberately **in-session only**. The async child runs in the
live service worker (kept alive by the offscreen keepalive, like any turn). It
**survives the user switching chats** — turns run SW-side, independent of which
session the panel shows — but it does **not** survive the SW being killed or the
browser closing. That long-lived/durable case is a `continuation` task in
DESIGN-08 (the waker re-enters the parent on the next boot); see the hand-off at
the end. We build the in-session slice now because it delivers the UX win on a
substrate that already exists, with no dependency on the unbuilt scheduler.

If the SW dies mid-child in this design, the child is **reported
`interrupted`** on the parent's next turn, not silently lost. Upgrading that to
"resumes after a browser restart" is the DESIGN-08 follow-on.

## The default policy (and its two exceptions)

`spawn_subagent` defaults to **async**. Two cases stay synchronous:

1. **The do/get/check runner stays sync.** When the agent calls `do`/`get`/
   `check`, the internal browser-runner subagent must return its result *now* —
   the agent's next step is literally "use that page result." That path keeps
   `await` (it does not go through the agent-facing async default). Async there
   would be strictly worse and would break the runner's contract.

2. **`sync: true` escape hatch for synthesise-this-turn.** The one case async
   hurts is "spawn 3 reasoners, compare them, answer *this* turn" — async would
   split that into N separate return-turns. So the tool takes `sync: true`, and
   the agent is taught: *async to go-do-things-while-the-user-keeps-chatting;
   `sync:true` when your very next sentence depends on the result.* A parallel
   fan-out the parent will synthesise immediately should pass `sync:true` on
   each — they still run concurrently (the existing `CONCURRENT_TOOLS` wave),
   they just all complete before the turn ends.

Rule of thumb baked into the tool description and the system prompt: **if you
would do nothing but wait for the result, you wanted `sync:true`.**

## The reintegration contract (the crux)

The Anthropic Messages model forbids the obvious approach: a `tool_use` must be
answered by a `tool_result` **in the same assistant turn**, and the loop only
delivers tool_results on the next iteration of the *same generator*
(`agent-loop.js` appends them as one trailing user message). A child that
finishes *after* the turn closed cannot backfill that tool_result. So:

- **The async tool returns immediately** with a real `tool_result`: a handle
  line — `subagent <id> started (async); its result will arrive on a later
  turn — do not wait, continue or end your turn.` That text *is* the
  anti-premature-poll instruction, and it answers the `tool_use` in-turn (no
  reliance on `to-anthropic.js`'s orphan-repair safety net).

- **The result re-enters as a NEW turn** against the parent session — a
  `synthetic: true` user message, the *exact* mechanism already used for
  truncation-continuation (`agent-loop.js:528-548`). The API accepts it (a
  trailing assistant prefill 400s; a user turn is sanctioned), and `synthetic`
  already hides it from the normal chat render so the transcript does **not**
  read as if the user typed "subagent X finished." The UI renders it as a
  passive wake banner (see UI).

- **The child result is UNTRUSTED.** It is model-authored from a fresh context
  over possibly page-derived bytes, so the result portion enters via
  `wrapUntrusted` (reuse `wrapUntrustedRunner`, `prompt-wrap.js`) with
  fence-tag neutralisation. Only the one-line "subagent X finished" framing is
  trusted.

- **Size-capped + idempotent.** The reintegrated text is capped (well under the
  sync path's `MAX_RESULT_CHARS` 200KB — link to the side-panel card for the
  full transcript). Each child record carries `reintegrated:false`, flipped
  atomically when its wake turn commits, so a redelivered completion is a no-op.

- **Never abort the user's live turn.** If the parent session is mid-turn when
  the child finishes (the user is chatting with it), the wake turn must **wait
  for the slot**, not steer-abort it. `turnSlots` today only has
  `claim`/`stop`/`isBusy` and `claim` *aborts* the current turn — so we add
  `turnSlots.runWhenIdle(sessionId, fn)` (a release-drain hook), and the wake
  runs only once the live turn releases. Multiple children finishing close
  together **coalesce** into one wake turn at drain time (collect all
  `reintegrated:false` children of the parent), so the parent reasons over a
  batch, not N interleaved turns.

## Execution

- New `ctx.spawnSubagentAsync(req)` on the SW side: registers the child in an
  **in-memory per-session async-children map** (id, task, status, Abort
  controller, ring-buffer of last-N output lines for `subagent_tasks` peek),
  then kicks `spawnSubagentCore` **fire-and-forget** (NOT awaited) with
  `persistDeltas:true` so the nested transcript streams and a partial is
  recoverable. The driver is held alive by the offscreen keepalive, **not** the
  parent turn's keepalive (the parent turn ends — that's the point).

- On child completion the driver: writes the child's `finalAssistantText` to its
  own session (already recoverable), marks the map entry `done`, and calls
  `turnSlots.runWhenIdle(parentSessionId, drainReintegration)`.

- `drainReintegration(parentSessionId)`: gathers all `done && !reintegrated`
  children, checks `vault.isLocked()` first (see below), builds ONE
  `synthetic:true` wake message (trusted framing + each child's
  `wrapUntrusted`-wrapped, size-capped result), re-enters the parent session via
  a **session-parameterised** `runAgentTurn` (today it reads
  `currentSessionId`; we thread an explicit `sessionId`), flips `reintegrated`,
  and fires the passive UI surfacing.

- **Vault-locked deferral.** Re-entry needs the model key, which lives behind
  the vault (auto-locks at 45 min idle). In-session this is rarely hit (the user
  is actively chatting → unlocked), but handle it honestly: if locked at drain
  time, hold the finished children, fire a generic notification ("a subagent
  finished — unlock to see its result"), set the passive parent-row badge, and
  re-drain on `vault.subscribe` unlock. Never run the model locked; never drop.

## Concurrency, cancel, failure

- **Per-parent outstanding-async cap = 4** (in line with Hermes 3 / Codex 6 /
  Kiro 4). A 5th async spawn is **refused** with a clear error (not a hidden
  queue) — an agent reasoning about its own fan-out should see the bound. Note:
  async children do **not** occupy the `CONCURRENT_TOOLS` dispatch wave (they
  return immediately), so this cap is the sole concurrency bound for async.

- **Depth cap unchanged** (`maxDepth` 5, recursion stripped unless
  `allowRecursion`). An async child wanting its own children hits the same guard.

- **`subagent_cancel(id)`**: marks the map entry `cancelled`, aborts the live
  driver via its AbortController. **`subagent_tasks()`**: non-blocking peek —
  status + last-N output lines per outstanding child. (`steer_subagent` is
  deferred.)

- **Failure**: a child hitting `maxSteps` reintegrates its partial with an
  "incomplete" marker (today's `exceeded:true`). A child lost to SW death is
  reported `interrupted` in the next wake — until the DESIGN-08 durable
  resume lands.

- **Cost stays attributable**: child usage is NOT folded into the parent tally
  (preserve current behaviour).

## UI (never steal focus — DECISIONS #20)

- **Attended-live**: streams into the existing nested subagent transcript card
  via `forwardSubagentEvent` (only while the side panel is open — it
  early-returns without a panel port; that's fine, otherwise the child runs
  headless and surfaces on completion).
- **Completion while the user is elsewhere**: a passive badge on the parent
  session row + a generic `chrome.notifications` toast that says *only* "a
  subagent finished" (never the result text or any watched content). The wake
  turn appears inline in the parent transcript when it runs, rendered as a
  system/wake banner (not a user bubble) — but it must NOT auto-open the panel,
  auto-focus the window, or auto-switch the active session, and it must NOT
  shove itself into a chat the user is mid-sentence in (it waits for the slot).

## Files to change (Phase 1)

- `tools/defs/spawn-subagent.js` — add `sync?: boolean` (default async); async
  branch calls `ctx.spawnSubagentAsync` and returns the handle line; sync branch
  is today's code verbatim.
- `subagent/spawn.js` — factor the child-run body to run detached (fire-and-
  forget) as well as awaited; ensure `persistDeltas:true` on the async path.
- `loop/turn-slots.js` — add `runWhenIdle(sessionId, fn)` (drain on release;
  never abort).
- `background/service-worker.js` — bind `spawnSubagentAsync`; the per-session
  async-children map; `drainReintegration`; session-parameterised re-entry
  (thread an explicit `sessionId` through `runAgentTurn`); vault-locked deferral
  via `vault.subscribe`; the notification + parent-row badge.
- `tools/defs/` — new thin tools `subagent_tasks` (peek), `subagent_cancel`.
- `loop/agent-loop.js` — none expected (reuse the `synthetic` user-turn path);
  confirm the wake message renders/excludes correctly.
- `sidepanel/` — render the `synthetic` wake message as a passive banner; the
  parent-session-row badge.
- `peerd-provider/system-prompt.txt` + `docs/SUBAGENTS.md` — the async-default
  policy, the `sync:true` escape, the "don't wait — it comes back" discipline.
- manifests: `notifications` permission (alarms NOT needed for in-session);
  `bun run gen:dev`.

## Phasing

- **Phase 1 (this design)**: async-default `spawn_subagent`, fire-and-forget in
  the live SW, push-back via `synthetic` wake turn, `runWhenIdle`, per-parent
  cap, `subagent_tasks`/`subagent_cancel`, vault-locked deferral, passive UI.
  In-session durability only; SW death → `interrupted`.
- **Phase 2**: `steer_subagent` (mid-run guidance, attended-live).
- **Phase 3 (DESIGN-08)**: durable — a child that outlives the SW completes (or
  resumes) via a `continuation` task; the waker re-enters the parent on the next
  boot. See DESIGN-08 §"Async-subagent continuations."

## Why not just block (the honest counter-case)

Blocking is correct and simpler for short, sequential, synthesise-now work, and
async only pays off when the parent has *other* work while one child runs. We
keep blocking as `sync:true` and as the runner's hard default precisely so we
don't pay the async tax where it buys nothing. The bet is that "go do a thing
and report back" is common enough in a browser agent (browse, build, watch) that
non-blocking-by-default is the better daily UX — with the escape hatch one flag
away.
