# DESIGN-08 — schedule: durable timers, waits, and resumable work

> Status: DESIGN. Nothing here is implemented. Feature number 08
> (01 memory, 02 edit, 03 plan/act, 06 cost, 07 skills are taken).
> Reviewed by an adversarial panel (platform-truth + security lenses);
> their must-fixes are folded in below and marked where load-bearing.

## Motivation

An agent that lives in a browser gets turned off constantly — the MV3
service worker is killed after ~30s idle, the side panel closes, the
browser quits, the laptop sleeps. Today every peerd capability is
synchronous with an open, attended browser: if the user asks "watch CI
and tell me when it goes red," "check the update feed every morning,"
or "keep working through this plan tomorrow," there is no primitive
underneath any of it. The agent can't schedule, can't wait, can't
resume. Everything dies with the service worker.

The primitive this design adds: **a durable task that wakes the agent
and re-enters a session with context** — "an alarm that resumes a
conversation." Three user-visible shapes, one mechanism:

1. **Timers** — run X at time T, or every N hours.
2. **Waits/watches** — poll a condition until it's true (or changes),
   then resume.
3. **Continuations** — pick a long-running plan back up after the
   browser was closed (Ralph already journals plan state; this gives it
   a way to be *re-entered* without the user retyping "continue").

## The honest semantics (browser reality)

peerd has no backend by design. A peerd schedule means "as soon as
possible once the browser is running, at or after time T." The UI says
this in those words — **"runs only while the browser is running"**
(not "open": on macOS the browser process routinely outlives its last
window, so fires CAN happen with zero windows — see "zero-window
fires" below).

What the platform actually gives us, stated precisely (panel-checked):

- **The IDB task store is the single durable truth.** `chrome.alarms`
  is a *best-effort wake hint*, not state: Chrome documents that alarms
  "may be cleared when the browser restarts" (in practice they usually
  survive), and **Firefox clears alarms at session end, always**. The
  waker therefore recomputes and re-arms its alarm from the task store
  unconditionally on EVERY service-worker/event-page boot; on Firefox
  that boot scan is the *only* delivery path for fires missed while
  closed, not a backstop.
- An alarm DOES wake a dormant background context with no extension UI
  open — Chrome's service worker and Firefox's event page (Firefox MV3
  has no SW; packaging/gen-manifest.ts already rewrites
  `background.service_worker` → `background.scripts`).
  Implementation rule: the `alarms.onAlarm` / `runtime.onStartup`
  listeners must be registered **synchronously at top level** on every
  boot (the current SW already follows this pattern for all listeners);
  the scan they trigger may be async, the subscription may not.
- Granularity: Chrome clamps alarms to ≥30s since Chrome 120 (1 min
  before) — but does NOT enforce the clamp for unpacked extensions, so
  dev-mode timing lies; Firefox documents no floor. Irrelevant at the
  product level: **peerd floors every schedule and poll at 1 minute**
  and the in-browser tests should assert the re-arm logic never asks
  for less.
- `chrome.notifications` for telling an away user something fired.
- **Manifest change (08a, deliberate and reviewable):** add `alarms`
  and `notifications` to `manifests/base.json` permissions and
  regenerate (`bun run gen:dev`). Both channels; check the store
  listing's permission-warning impact before the submission that
  includes it.

## Mechanism

Three parts, smallest possible surface:

### 1. The task record (IDB, new store `schedule_tasks`)

```js
{
  id, title,
  kind: 'timer' | 'watch' | 'continuation',
  schedule: { at?: ms } | { everyMs: number } | { pollMs: number },
  action: {
    sessionId,            // resume HERE (or null → fresh session)
    instructions,         // user-authored text (trust note below)
    grant,                // null = read-only; see "Unattended permissions"
  },
  // watch-only:
  condition: { url, matcher },   // see "Watches"
  // budgets — enforced BEFORE a fire starts (see "Budgets"):
  budget: { perFireUsd, totalUsd, maxFires },
  // catch-up policy when fires were missed while the browser was closed:
  missed: 'run-once' | 'skip',   // run-once = collapse N missed → 1 run
  state: 'armed' | 'running' | 'done' | 'failed' | 'paused',
  journal: [ { firedAt, outcome, costUsd, error? } ],
  createdBy: 'user' | 'agent',   // agent-created ⇒ was confirmation-gated
  createdAt, nextFireAt, backoffMs,
}
```

At-least-once, never exactly-once: a fire that dies mid-run (SW killed,
browser quit) is visible as `running` with a stale heartbeat; the next
scheduler pass marks it `failed(interrupted)` and applies the missed
policy. Read-only fires tolerate redelivery by construction; **acting
fires do not get silent redelivery** — see the grant rules.

### 2. The waker (`peerd-runtime/schedule/`)

One module owns all alarms. It keeps a single `chrome.alarms` entry
pinned to the soonest `nextFireAt` (plus a slow heartbeat alarm, ~15
min, as the missed-fire sweeper). The due-task scan runs from FOUR
triggers, first one is the load-bearing one: **unconditional top-level
boot scan** on every SW/event-page start, then `onAlarm`,
`runtime.onStartup`, and `runtime.onInstalled` (the latter two are
redundant extra wakes — onStartup doesn't fire on update/enable, and on
macOS reopening a window fires nothing because the process never died).

why one pinned alarm instead of one alarm per task: Chrome caps alarm
count and the scan is cheap; a single re-arm point also makes the
"what fires next" question answerable in one read for the UI.

**Zero-window fires.** A fire may run with no browser window at all
(macOS background process). webFetch and inspect tools are SW-side and
fine; anything needing a tab hard-fails at the exposure gate with a
journaled `no-window` outcome — never auto-opens a window on an absent
user.

### 3. Resume — re-entering a session

A fire does NOT replay anything. It starts a normal agent turn in the
target session with an injected **wake event** rendered through the
existing clock/temporal machinery (`{{TEMPORAL_BLOCK}}`):

> Scheduled task "<title>" fired at <t> (scheduled for <t₀>; N missed
> fires collapsed per policy). Instructions: <instructions>. This may
> be a redelivery.

Trust boundary (panel must-fix): the wake-event frame and a
user-authored `instructions` string are trusted prompt content.
**Anything derived from a watched response — the matched value, the
body, even "what changed" — is untrusted and MUST enter the context
through `wrapUntrusted` with the same fence-tag neutralization as
`read_article`/`read_api` output.** The temporal block stays a trusted
one-line summary; page bytes never ride it.

The session store already persists full history, so "pick up where it
left off" is free. If the user is present they watch it run like any
turn; if not, the turn runs unattended and finishes with a
`chrome.notifications` toast + a badge on the session row.
**Notification content is generic by rule — task title + fired/needs
attention. Never result values, never watched content** (OS
notification centers and lock screens are a leak surface).

### 4. Async-subagent continuations (the durable variant of DESIGN-11)

`DESIGN-11` ships **in-session** async subagents: a non-blocking
`spawn_subagent` whose child runs in the live SW and pushes its result
back as a `synthetic` wake turn when done. That slice deliberately does
NOT survive the SW being killed — a child lost to SW death is reported
`interrupted` on the parent's next turn. This section is the **durable
upgrade**: make a long async child survive a browser restart by routing
its completion through the waker instead of a live-SW callback.

Mechanism, reusing everything above:

- When an async child is spawned in "durable" mode, register a
  `kind:'continuation'` task whose `action.sessionId = parentSessionId`
  and which carries `{childSessionId, caps}`. The child session is just a
  session with durable history (DESIGN-11), so it is independently
  recoverable.
- Two completion paths converge on the **same** re-entry (§3): (a) the
  child finishes while the SW is alive → enqueue the continuation, which
  fires the parent wake turn; (b) the SW died mid-child → the boot scan
  finds the `running`-with-stale-heartbeat child, re-enters the **child**
  session to finish it (a normal resumed turn), then enqueues the parent
  continuation. One durable path, not two regimes.
- The parent wake carries the child's `finalAssistantText` as the
  **untrusted** portion via `wrapUntrusted` exactly as §3 specifies for
  watched content; only the one-line "subagent X finished" framing is
  trusted temporal text. Reintegration is **idempotent** (a
  `reintegrated` flag flipped atomically on first commit; a redelivered
  fire is a no-op) and **coalesces** sibling completions into one wake.
- **Vault-locked is first-class**: a child that finishes while the vault
  is locked cannot run the parent turn (the model key is gated). Mark the
  task `paused`, fire the generic notification, badge the session row, and
  re-drain on the next unlock (`vault.subscribe`) — never run the model
  locked, never silently drop.
- Heartbeat: the live driver bumps `task.heartbeatAt` every N seconds so
  the boot scan can distinguish "still running in this SW" from "died
  mid-run" (older than ~2N ⇒ interrupted, then resume).

This needs no new agent-facing surface beyond DESIGN-11's tools — durable
is a `mode` on the spawn, not a new tool. See `DESIGN-11-async-subagents.md`
§"Phasing" Phase 3.

## Watches (wait-for)

A `watch` task polls `condition.url` through **`webFetch`** — the
egress-audited, denylist- and private-network-checked path. Honesty
note (panel): sharing the rail does NOT mean watches add nothing —
they create a new *pattern*: unattended, repeated, automated egress on
a timer while nobody watches the audit log. So watches are constrained
beyond interactive use:

- **Pinned host:** a watch may contact ONLY the host it was scheduled
  against; cross-origin redirects are not followed; the unattended turn
  it triggers gets the same single-host pin for its own webFetch reads
  (closes "read one URL, exfiltrate to another").
- **GET only, no custom headers/body** on watch fetches.
- Global rate cap on total watch egress; `pollMs` floors at 1 minute
  with exponential backoff on unchanged results.
- `matcher` is declarative and TINY: `{ status?, contains?,
  jsonPath?+equals?/changed? }` — evaluated by a hardened, bounded
  parser (length caps, no backtracking regex; matchers run on hostile
  bytes every poll). An arbitrary-predicate escape hatch (JS Sandbox
  over the response) is explicitly deferred.

## Unattended permissions (the hard part)

A scheduled turn runs with nobody to click "Allow." Rules, in order of
load-bearing-ness (panel must-fixes):

- **The waker stamps every fired turn `ctx.unattended = true`; an
  absent flag means unattended.** All gates read it; fail closed.
- **Unattended turns can never widen themselves: `schedule_task`,
  `schedule_cancel`, `wait_for`, and any grant edit are HARD-DENIED
  under `ctx.unattended`** — not "confirmation fails closed," denied at
  the gate before confirmation is consulted. `schedule_list` (read) is
  allowed. This kills the injection pivot "schedule a new full-auto
  task for me."
- Default capability is an explicit **allow-list of tool names** —
  `inspect_*`, `schedule_list`, and a GET-only, host-pinned webFetch
  read. Not "the read families": today's `read_api` can POST arbitrary
  bodies to any non-denylisted host, which is an exfiltration channel,
  and primitive tab tools are exempt from the egress-allowlist hook —
  both are OUT of the unattended set by name.
- Acting unattended (08c, not before) requires a user **grant** bound
  at confirmation time: act tier + pinned tool list + budgets + the
  exact instructions, **hashed together; any edit to a granted field
  voids the grant and re-prompts**. Redelivery of an acting fire is
  never silent — interrupted acting fires pause the task and notify
  instead of re-running side effects under a stale grant.
- Prerequisite called out honestly: the exposure gate is today a V1.3
  stub that always allows (`gates.js exposureGate`). **08a's allow-list
  enforcement makes that gate real for unattended turns; 08c does not
  ship until it is.** The six-gate chain itself is unchanged; the
  confirmation gate under `ctx.unattended` answers DENY and journals.

## Budgets (panel should-fix, adopted)

Per-fire `perFireUsd` binds to a **fresh, fire-scoped cost tally** (the
existing session-global spend limit is the wrong instrument — a
recurring task resuming one session would trip it forever; fresh
sessions would reset it forever). The waker checks `totalUsd`
(cumulative across fires) and `maxFires` (hard backstop, mirroring
Ralph's MAX_ITERATIONS discipline) BEFORE starting a fire; hitting
either **pauses the task and notifies** — never silently drops fires.

## Agent-facing tools

```
schedule_task    create timer/watch/continuation   (confirmation-gated;
                                                    HARD-DENIED unattended)
schedule_list    enumerate own tasks + journals     (read)
schedule_cancel  cancel/pause a task                (confirmation-gated;
                                                    HARD-DENIED unattended)
wait_for         sugar: schedule a watch that resumes THIS session, then
                 end the turn cleanly               (HARD-DENIED unattended)
```

`wait_for` is the primitive that changes agent behavior most: instead
of busy-polling inside a turn (burning tokens against a browser that
may close), the model ends its turn and lets the alarm bring it back.
The system prompt teaches exactly this hand-off.

## UI

A **Scheduled** section in the side panel (sessions-view sibling):
upcoming fires with countdowns, paused/failed states, per-task journal,
pause/resume/delete, and the "runs only while the browser is running"
sentence verbatim. Every fire is an audit-log entry.

## What we deliberately do NOT build

- No backend, no push, no server cron. Local-first stays local-first.
- No exact-time guarantees, no sub-minute schedules.
- No arbitrary-code matchers in V1 of the feature (declarative only).
- No cross-device schedule sync. A task lives in one browser profile.
  (Schedules DO ride the §10 export/import payload — a future
  `schedule` field — like every other piece of durable state; grants
  do NOT survive import, they re-prompt.)
- dweb note, research-track only: peers could eventually execute each
  other's watches while one side is offline — "social cron." That is a
  dwapp-layer experiment for the preview channel someday, not part of
  this feature.

## Module placement

`peerd-runtime/schedule/` — sibling of `clock/`, not inside it: clock
*observes* time (temporal grounding of events), schedule *acts* on it.
Schedule depends on clock (wake events render through it), sessions
(resume), tools/exposure + permissions (unattended clamps), egress
(webFetch, storage, audit). Nothing depends on schedule. Functional
core, imperative shell: the scheduler's due-task scan, budget checks,
matcher evaluation, and re-arm computation are pure functions over
(task records, now) — Bun-testable; `chrome.alarms`/IDB IO is injected
at the SW seam like every other module.

## Phasing

- **08a** — manifest permissions (`alarms`, `notifications`), task
  store + waker (boot-scan-first), timers/recurring, Scheduled UI,
  `schedule_task`/`list`/`cancel`, the `ctx.unattended` flag + the
  unattended tool allow-list (this is where the exposure gate gets
  real), budgets, generic notifications.
- **08b** — watches: pinned-host GET-only polling, hardened declarative
  matchers, backoff, `wrapUntrusted` on every watched byte, `wait_for`
  sugar, system-prompt guidance for the hand-off pattern.
- **08c** — acting unattended: the hashed grant flow (act tier, tool
  pinning, budgets, instruction binding), pause-don't-replay redelivery
  for acting fires, continuations that re-enter Ralph plans.
- **08d** — durable async subagents (the §4 upgrade to `DESIGN-11`): a
  long async child survives SW death via a `continuation` task + heartbeat
  + boot-scan resume; vault-locked-on-completion is a first-class `paused`
  state that re-drains on unlock. Ships only after DESIGN-11's in-session
  slice and 08a's store/waker exist.

Both channels get the feature identically (it's core, not dweb); the
caps are safety posture and therefore identical across channels per
the §11 rule — friction may diverge, the safety floor may not.
