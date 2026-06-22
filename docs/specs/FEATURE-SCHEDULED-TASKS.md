# FEATURE — Scheduled Tasks

> **Status:** SPEC, build-ready. Absorbs and supersedes the original
> DESIGN-08 schedule design (now carried as the `## Appendix — original
> design (DESIGN-08, merged)` below; the standalone `DESIGN-08-schedule.md`
> file is retired). This document is the version an engineer builds from:
> it carries DESIGN-08's adversarially-reviewed decisions forward, fills in
> the concrete schema, execution path, and phasing, and is scoped so
> **Phase A is one engineer-week**.
>
> **Module:** `peerd-runtime/schedule/` — a new sibling of `clock/`. No
> sixth `peerd-*` module is created; this lives inside `peerd-runtime`
> (the *r* in the wordmark). Nothing depends on `schedule/`; it depends on
> `clock`, `sessions`, `subagent`, `tools/exposure` + `permissions`, and
> `egress`.

---

## 0. Why this exists, and what already exists

An agent that lives in a browser is turned off constantly: the MV3
service worker dies after ~30s idle, the side panel closes, the laptop
sleeps. Today every peerd capability is synchronous with an open,
attended browser. There is no primitive under "check the update feed
every morning," "watch CI and tell me when it goes red," or "pick this
plan back up tomorrow."

What peerd has today that is adjacent but **not** this feature:

- **`clock` (`peerd-runtime/clock/`, shipped):** `now` and `wait_until`.
  `wait_until` blocks *inside a single turn* until a time/duration. It
  burns tokens against a browser that may close, and dies with the SW.
  It is in-turn temporal grounding, not durable scheduling.
- **Goal mode (the Goal toggle, shipped):** an autonomous run that keeps
  taking normal turns in the main chat until the agent calls
  `complete_goal` (or Stop / a turn cap). Its runs persist and resume on
  SW restart *within the same browser session*, but there is no way to
  *re-enter* a goal after the browser closed without the user starting it
  again (`peerd-runtime/loop/goal-runner.js`).

The primitive this feature adds is **a durable task that wakes the agent
and re-enters a session with context** — "an alarm that resumes a
conversation." Three user-visible shapes, one mechanism:

1. **Timers** — run X at a time, or every N hours/minutes/days.
2. **Watches** *(Phase B)* — poll a condition until it changes, then resume.
3. **Continuations** *(Phase C)* — re-enter a long autonomous goal run
   after the browser was closed.

---

## 1. The honest semantics (state them in the UI)

peerd has no backend by design. A peerd schedule means **"as soon as
possible once the browser is running, at or after time T."** The UI says
this verbatim: **"Runs only while your browser is running."** (Not "open":
on macOS the browser process routinely outlives its last window, so fires
*can* happen with zero windows — see §5.4.)

Platform truths this design is built on (verified against Chrome/MDN docs):

- **The IDB task store is the single durable truth.** `chrome.alarms` is
  a *best-effort wake hint*, not state. Chrome usually persists alarms
  across restarts (`persistAcrossSessions` defaults true); **Firefox
  clears all alarms at session end, always.** peerd therefore recomputes
  and re-arms its alarm from the task store **unconditionally on every
  SW/event-page boot**. On Firefox that boot scan is the *only* delivery
  path for fires missed while closed.
- An alarm wakes a dormant background context with no UI open — Chrome's
  service worker, Firefox's event page (`packaging/gen-manifest.ts`
  already rewrites `background.service_worker` → `background.scripts` for
  Firefox). The `alarms.onAlarm` / `runtime.onStartup` listeners must be
  registered **synchronously at top level** on every boot; the scan they
  trigger may be async, the subscription may not.
- Granularity: Chrome clamps published-extension alarms to ≥30s (≥1 min
  pre-Chrome-120) and does **not** enforce the clamp for unpacked dev
  extensions, so dev timing lies. Irrelevant at product level: **peerd
  floors every schedule and poll at 1 minute** and the in-browser tests
  assert the re-arm logic never asks for less.
- `chrome.notifications` tells an away user that something fired.

**Manifest change (Phase A, deliberate and reviewable):** add `alarms`
and `notifications` to `manifests/base.json` and regenerate
(`bun run gen:dev`). Both channels. Check the store listing's
permission-warning copy before the submission that includes it.

---

## 2. Scope: what ships when

| Phase | Scope | Effort |
|---|---|---|
| **A** (V1.x) | Manifest perms; `schedule_tasks` IDB store; the waker (boot-scan-first, single pinned alarm); **timers + recurring** (daily / every-N-hours / every-N-minutes / optional cron); the Scheduled side-panel section; `schedule_task` / `schedule_list` / `schedule_cancel`; the `ctx.unattended` flag + the unattended read-only tool allow-list (this is where the exposure gate becomes real for unattended turns); **dry-run default**; per-fire + cumulative budgets; generic notifications; export/import field. | **~1 week** |
| **B** (V1.x+) | **Watches:** pinned-host GET-only polling through `webFetch`, hardened declarative matchers, backoff; `wait_for` sugar; system-prompt hand-off guidance; `wrapUntrusted` on every watched byte. | ~1 week |
| **C** (V2) | **Acting unattended:** the hashed grant flow (act tier + pinned tools + budgets + instruction binding); pause-don't-replay redelivery for acting fires; **continuations** that re-enter goal runs. | ~1–1.5 weeks |

Phases are independently shippable. Phase A alone is a complete,
useful, safe feature (read-only recurring tasks with preview).

---

## 3. UX

### 3.1 Creating a schedule

Three entry points, all landing in the same confirm flow:

1. **Natural language in chat.** "Every morning at 8, summarize my GitHub
   notifications." The agent calls `schedule_task` (§8); the call is
   **confirmation-gated** and renders a **schedule card** in the composer
   area showing the parsed schedule (name, cadence, next fire, the
   instruction text, the capability tier, budgets). The user confirms or
   edits before anything is armed.
2. **`/schedule` composer command.** Opens the same card pre-filled,
   for users who'd rather fill a form than phrase it.
3. **From a Smart Nudge** *(see `FEATURE-SMART-NUDGES.md`)*. After a turn
   that looks recurring ("here's today's news digest"), the agent may
   surface a one-tap "Run this every morning?" card. Accepting opens the
   same confirm flow — it never arms silently.

### 3.2 Cadence options (keep the common case one tap)

The card offers, in order of how often they're used:

- **Daily** at HH:MM (local time).
- **Every N hours** (1–24).
- **Every N minutes** (≥1, floored at 1).
- **Advanced → cron expression** (optional, power users): a standard
  5-field cron string, with a human-readable echo ("Every weekday at
  9:00 AM") rendered beneath it so the user can sanity-check.

> **Why both simple pickers and cron:** the three simple types cover ~all
> real use and are zero-friction; cron is the escape hatch for "weekdays
> only," "1st of the month," etc. without us inventing a bespoke recurrence
> UI. Cron parsing uses a **vendored zero-dependency parser** (e.g.
> croner-class library, MIT, ~7KB) under `vendor/` with a `SOURCE.txt`,
> used only to compute the **next fire timestamp** statelessly — we never
> hand a cron period to `chrome.alarms`; see §5.

### 3.3 The Scheduled view

A **Scheduled** section in the side panel (a sessions-view sibling, under
the existing Context/Activity surfaces):

- Each task row: name, cadence, **next fire with a live countdown**,
  state (armed / running / paused / failed), and the capability tier
  badge (Preview / Read-only / Acting).
- Expand a row → **the run journal**: last N fires with timestamp,
  outcome, cost, and a link to the resumed session transcript. (We cap
  the journal per task — see §6.5.)
- Per-row controls: **Pause / Resume / Delete / Run now (preview)**.
- The verbatim sentence **"Runs only while your browser is running."**
- Every fire is also an audit-log entry.

### 3.4 Dry-run / preview is the default, always

**No schedule's first real run happens without the user having seen a
preview.** On creation, the default capability tier is **Preview**
(read-only; §7). The card explains: "Scheduled tasks start in preview —
they'll gather and report, but won't click, submit, or send. Promote to
Acting once you trust it." This satisfies the hard constraint *never
schedule an irreversible action without explicit pre-approval*: acting
unattended requires an explicit, separately-confirmed grant (Phase C,
§7.3), and that grant is bound to the exact instruction text.

---

## 4. Persistence — the `schedule_tasks` IndexedDB store

A new object store `schedule_tasks` in the existing `peerd` IndexedDB
database (the same DB that holds sessions/audit/memory; bump
`DB_VERSION`, add the store in the upgrade path). **Not** `chrome.storage`
— the store is the durable source of truth and `chrome.storage` is the
wrong instrument for a growing, queried record set.

Task record (the canonical shape; carries DESIGN-08 forward with the
fields the build needs):

```
ScheduleTask {
  id:            string           // UUIDv7
  title:         string
  kind:          'timer' | 'watch' | 'continuation'

  schedule:                       // exactly one shape, by kind
      { at: number }                       // one-shot, epoch ms
    | { everyMinutes: number }             // recurring interval (≥1)
    | { cron: string, tz: string }         // cron + IANA tz
    | { pollMinutes: number }              // watch (≥1)

  action: {
    sessionId:   string | null    // resume here, or null → fresh session
    instructions:string           // user-authored, TRUSTED prompt content
    tier:        'preview' | 'readonly' | 'acting'   // capability tier (§7)
    grantHash?:  string           // acting only: hash binding (§7.3)
  }

  // watch-only:
  condition?:  { url: string, matcher: Matcher }     // §6 Phase B

  budget:      { perFireUsd: number, totalUsd: number, maxFires: number }
  missed:      'run-once' | 'skip'   // collapse N missed fires → 1, or drop
  state:       'armed' | 'running' | 'paused' | 'done' | 'failed'

  journal:     RunRecord[]        // capped, newest-kept (§6.5)
  createdBy:   'user' | 'agent'   // agent-created ⇒ was confirmation-gated
  createdAt:   number
  nextFireAt:  number | null
  lastFireAt:  number | null
  backoffMs:   number             // watch backoff on unchanged results
  heartbeatAt: number | null      // liveness for interrupted-fire detection
}

RunRecord {
  id: string; firedAt: number; finishedAt: number | null
  outcome: 'ok' | 'failed' | 'interrupted' | 'no-window' | 'budget' | 'denied'
  costUsd: number; summary?: string; error?: string
  sessionId?: string            // the resumed/created session, for the transcript link
}
```

Functional core / imperative shell, per the house rule: the **due-task
scan, re-arm computation, budget checks, matcher evaluation, and
missed-fire collapse are pure functions over `(tasks, now)`** —
Bun-testable. `chrome.alarms` / IDB / notifications IO is injected at the
SW seam like every other module.

---

## 5. Execution

### 5.1 The waker (`peerd-runtime/schedule/waker.js`)

One module owns all alarms. It keeps **a single `chrome.alarms` entry
pinned to the soonest `nextFireAt`** across all tasks, plus one slow
heartbeat alarm (~15 min) as the interrupted-fire sweeper.

> **Why one pinned alarm, not one-per-task** (this is where peerd
> deliberately differs from the naive approach): a single re-arm point
> makes "what fires next" answerable in one read for the UI, sidesteps any
> per-name alarm-count concerns, and — critically — lets cron schedules
> work at all (you can't express cron as a `chrome.alarms` period; you
> compute the next timestamp and arm a one-shot, then recompute on wake).

The due-task scan runs from four triggers; **the first is load-bearing**:

1. **Unconditional top-level boot scan** on every SW / event-page start.
   This is the only thing that makes Firefox work (alarms gone at session
   end) and the backstop for any Chrome alarm that didn't survive.
2. `alarms.onAlarm`.
3. `runtime.onStartup` (browser cold start).
4. `runtime.onInstalled` (update/enable — `onStartup` doesn't fire there).

Each scan: load tasks → compute which are due (pure) → run them
sequentially (§5.3) → recompute and re-arm the single pinned alarm to the
new soonest `nextFireAt`.

### 5.2 The 1-minute floor

Every `everyMinutes` / `pollMinutes` is floored to 1; cron next-fire
computation that yields a sub-minute delta is pushed to the next
whole-minute boundary. The in-browser test suite asserts the waker never
calls `alarms.create` with `< 1` minute.

### 5.3 Running a fire — the durable path

A fire does **not** replay anything. It starts a normal agent turn in the
target session (or a fresh one) with an injected **wake event**, and it
runs through peerd's existing in-browser agent loop — **no server, no new
egress path, BYOK to the model exactly as an attended turn does.**

The execution seam reuses what's already built:

1. The waker marks the run: it writes a `RunRecord` with
   `outcome` pending, sets `state:'running'`, stamps `heartbeatAt`, and
   **sets `ctx.unattended = true`** on the turn context (§7).
2. **The turn runs in the offscreen document, not the SW.** The waking SW
   is capped at 5 min/event and 30s idle — too short and too fragile for
   an agent turn. The offscreen document has a stable, SW-independent
   lifetime and is already peerd's home for long-running work (voice,
   DOM sanitize). The waker ensures the offscreen doc exists
   (`chrome.offscreen.createDocument` if absent; reason
   `IFRAME_SCRIPTING` / `WORKERS` as appropriate) and dispatches the run
   there; the offscreen doc `postMessage`-heartbeats the SW to keep it
   alive for the messaging bridge.
3. The turn is a **`spawnSubagent` call** with:
   - `systemPromptOverride` = the base prompt **plus** a wake-event frame
     (§5.5) — reusing the existing per-spawn prompt override built for
     the browser-runner.
   - `tools` = the capability tier's tool set, applied as a
     **per-session tool manifest** (§7.2) so it's enforced at *both*
     descriptor filtering and dispatch, and inherited (intersected) by any
     child runner.
   - `model` = the user's configured model (cheaper model allowed for
     preview tier; see Open Questions).
   - `maxSteps` / `maxOutputTokens` = fire-scoped caps (§6.4).
   - `persistDeltas: true` — unlike a browser-runner, a scheduled turn's
     transcript is user-visible in the Scheduled view.
4. On completion: write the final `RunRecord` (outcome, cost, summary,
   `sessionId`), clear `state` back to `armed` (or `done` for one-shots),
   recompute `nextFireAt`, fire a **generic** notification (§5.6).

### 5.4 Zero-window fires

A fire may run with no browser window at all (macOS background process).
SW-side / offscreen-side capabilities (`call_api`, `read_article` via
`webFetch`, `inspect_*`, memory reads) work fine. **Anything that needs a
real tab** (`do`/`get`/`check`, which spawn a browser-runner against a
tab) **hard-fails at the exposure/permission gate with a journaled
`no-window` outcome** — it never auto-opens a window on an absent user.
This is by design: a preview/read-only schedule that only reads APIs and
memory is the safe, common case; tab-driving schedules require a window
to already exist or are reported as `no-window` for the user to see.

### 5.5 The wake event (trusted frame, untrusted payload)

The resumed turn's first message is a one-line **trusted** frame rendered
through the existing temporal machinery (`{{TEMPORAL_BLOCK}}` style):

> Scheduled task "<title>" fired at <t> (scheduled for <t₀>; N missed
> fires collapsed per policy). Instructions: <instructions>. This may be a
> redelivery.

**Trust boundary (load-bearing):** the wake frame and the user-authored
`instructions` are trusted prompt content. **Anything derived from a
watched response or a page — the matched value, the body, "what changed"
— is untrusted and enters context only through `wrapUntrusted` with the
same fence-tag neutralization as `read_article` / `call_api` output.** The
temporal block stays a trusted one-line summary; bytes never ride it.

### 5.6 Notifications are generic by rule

A finished unattended fire raises a `chrome.notifications` toast + a badge
on the Scheduled row. **Content is generic: task title + fired / needs-
attention only. Never result values, never watched content.** (OS
notification centers and lock screens are a leak surface.) "Open" deep-
links to the resumed session transcript inside the side panel.

---

## 6. Failure handling

### 6.1 At-least-once, never exactly-once

A fire that dies mid-run (SW killed, browser quit) is left as `running`
with a stale `heartbeatAt`. The next scan (or the 15-min heartbeat
sweeper) detects `now - heartbeatAt > STALE_MS` (10 min, matching the
per-fire cap) and marks that `RunRecord` `outcome:'interrupted'`, then
applies the missed policy.

- **Read-only / preview fires tolerate redelivery by construction** —
  rerunning a read is harmless, so an interrupted preview/read-only fire
  is simply re-run per `missed`.
- **Acting fires never get silent redelivery** (Phase C): an interrupted
  acting fire **pauses the task and notifies** rather than re-running side
  effects under a stale grant.

### 6.2 Missed fires (browser was closed)

On the boot scan, for each task whose `nextFireAt` is in the past:
- `missed: 'run-once'` → collapse all missed occurrences into **one** run
  (the wake frame says "N missed fires collapsed"). This is the default —
  it's what users mean by "every morning" when the laptop was shut over
  the weekend.
- `missed: 'skip'` → drop the missed occurrences, arm the next future one.

### 6.3 Retry / backoff

- **Timers:** a `failed` (non-interrupted) fire does **not** auto-retry by
  default — the user sees it in the journal and can "Run now." (Silent
  retries of a failing task are a token sink and, for acting tasks, a
  hazard.) An optional per-task "retry once after 5 min on failure" toggle
  may be added later; not in Phase A.
- **Watches (Phase B):** exponential backoff on *unchanged* results
  (`backoffMs`), reset on change; a hard floor of 1 min and a global cap
  on total watch egress per hour.

### 6.4 Per-fire and cumulative budgets

Budgets are checked **before** a fire starts; hitting any limit **pauses
the task and notifies** — never silently drops:

- `perFireUsd` binds to a **fresh, fire-scoped cost tally**, not the
  session-global spend limit. (A recurring task resuming one session would
  trip a session-global limit forever; fresh sessions would reset it
  forever — both wrong.)
- `totalUsd` is cumulative across all fires of the task.
- `maxFires` is a hard backstop, mirroring goal mode's 40-turn safety cap.
- A **per-fire wall-clock cap** (default 10 min) doubles as the
  interrupted-fire `STALE_MS`. A run still `running` past it is marked
  `interrupted` and the offscreen turn is aborted via its `AbortSignal`.

### 6.5 Journal retention

Each task keeps its **last 20 `RunRecord`s** (configurable constant),
pruned newest-kept on each append — bounded storage, same discipline as
the audit log's capped retention. (The full audit log retains the fire
events independently under its own 20k-entry cap.)

---

## 7. Security — the unattended model

A scheduled turn runs with nobody to click "Allow." This is the heart of
the feature's risk and the bulk of its design.

### 7.1 The `ctx.unattended` flag (fail-closed)

The waker stamps **`ctx.unattended = true`** on every fired turn. **An
absent flag is treated as unattended.** Dispatcher policy checks read it.

- **Unattended turns can never widen themselves.** `schedule_task`,
  `schedule_cancel`, `wait_for`, and any grant/tier edit are
  **HARD-DENIED under `ctx.unattended`** — denied at the exposure/persona
  gate *before* confirmation is even consulted, not "confirmation fails
  closed." `schedule_list` (read) is allowed. This kills the injection
  pivot "schedule a new acting task for me."
- The confirmation gate under `ctx.unattended` answers **DENY** for any
  tool that would otherwise prompt, and journals it (`outcome:'denied'`).

### 7.2 Capability tiers = per-session tool manifests

The three tiers are concrete **tool manifests** (the shipped
`peerd-runtime/tools/manifests.js` mechanism — presets as data, enforced
fail-closed at descriptor filtering *and* dispatch, intersected by any
child runner):

- **Preview** (default): the existing **`browse-only`** preset — `get` /
  `check` (read-only runner), `read_article` / `call_api` / `web_search`,
  navigation that loads URLs only, `now`, `inspect_*`. **No `do`, no
  writes, no memory writes, no spawning, no VM/JS/App, no acting.** Plus
  watch's host-pinned GET-only `webFetch` (Phase B).
- **Read-only**: Preview + `remember` (still confirm-gated → effectively
  proposes a pending memory note, never auto-writes) + `read_memory`. For
  schedules whose whole job is "gather and report."
- **Acting** *(Phase C only)*: the above + `do` + a **named, pinned**
  subset of acting tools, available **only** under a valid grant (§7.3).

A new preset key `scheduled-preview` may be added to `manifests.js` if
`browse-only` needs trimming for the unattended case (e.g. dropping
`open_tab` so a zero-window fire can't try to spawn a tab-driving runner);
this is a one-line data edit. **The `exposureGate` (`gates.js`) is already
real and enforced** — it refuses any runner-only tool to a `ctx.exposure
=== 'main'` turn at dispatch, and it enforces the per-session tool manifest
by name (a hallucinated or injected off-list call fails closed with the
reason in the lineage). The unattended tier reuses this same dispatch-time
manifest enforcement; it adds the `ctx.unattended` clamp on top, it does
not make a stub real.

### 7.3 Acting unattended requires a hashed grant (Phase C)

Promoting a task to **Acting** requires a user grant bound at
confirmation time over: **act tier + the exact pinned tool list +
budgets + the exact instruction text**, all **hashed together**. The hash
is stored as `action.grantHash`. **Any later edit to a granted field
voids the grant and re-prompts.** A scheduled acting fire is only
permitted when the live record re-hashes to `grantHash`. Redelivery of an
acting fire is never silent (§6.1).

### 7.4 No new egress, ever

Every network call a scheduled turn makes routes through the **existing
egress chokepoint**: provider calls through `safeFetch` (hardcoded
provider allowlist), open-web reads through `webFetch` (SSRF guard +
denylist + audit, no redirects). Watches (§Phase B) add a *constraint*,
not a path: a watch may contact **only the host it was scheduled
against**, GET-only, no custom headers/body, and the unattended turn it
triggers inherits that single-host pin for its own `webFetch` reads
(closing "read one URL, exfiltrate to another"). The denylist applies
identically; a fire that targets a denylisted origin is refused and
journaled. **There is no agent-server, no `/chat` POST, and no API key
leaves the device** — the entire loop is in-browser, which is precisely
what makes the egress chokepoint a real boundary.

---

## 8. Agent-facing tools

Registered in `peerd-runtime/tools/defs/`, dispatched through the six
gates like every other tool:

```
schedule_task    Create a timer/watch/continuation.
                 Confirmation-gated. HARD-DENIED under ctx.unattended.

schedule_list    Enumerate the caller's own scheduled tasks + journals.
                 Read. Allowed under ctx.unattended.

schedule_cancel  Pause / resume / delete a task.
                 Confirmation-gated. HARD-DENIED under ctx.unattended.

wait_for         (Phase B) Sugar: schedule a watch that resumes THIS
                 session, then end the turn cleanly.
                 HARD-DENIED under ctx.unattended.
```

`wait_for` is the tool that changes agent behavior most: instead of
busy-polling inside a turn with `wait_until` (burning tokens against a
browser that may close), the model **ends its turn** and lets the alarm
bring it back. The system prompt teaches exactly this hand-off (see
`SYSTEM-PROMPT-LESSONS.md` §"durable waits").

### Tool description text (ship this)

`schedule_task` description:

> Schedule a task to run later or on a repeating cadence — "every morning
> at 8," "every 2 hours," or a cron expression. The task re-enters a
> session and runs your instructions automatically when it fires.
> Scheduled tasks **run only while the browser is running** and start in
> **preview** (read-only): they gather and report but never click, submit,
> send, buy, or delete until the user promotes them. State the cadence and
> the instruction plainly; the user confirms before anything is armed. Do
> NOT use this for one-off work you can just do now, and do NOT schedule
> an action with real-world consequences without telling the user it will
> start in preview.

---

## 9. Federation interaction

**Phase A–C: no cross-device schedule sync.** A task lives in one browser
profile. This is a deliberate divergence from server-backed competitors,
which sync schedule definitions to a cloud account keyed by a user id —
peerd has no account and no backend, so there is nothing to sync *to*, and
syncing through a server would violate the local-first thesis and the "no
new egress" constraint.

What schedules *do* participate in:

- **Export / import (`DESIGN-10-export.md`):** schedules ride the
  `.peerd` export payload as a new `schedule` field, like every other
  piece of durable state. **Grants do NOT survive import** — an imported
  acting task lands as `preview` and re-prompts for a grant. (You cannot
  carry "permission to act unattended" across a device boundary on the
  strength of a file.)
- **dweb "social cron" — research track only, not this feature.** Peers
  could eventually execute each other's *watches* while one side is
  offline ("watch this page for me while I'm away"). That is a
  dwapp-layer experiment for the preview channel, sequenced in
  `docs/distributed/ROADMAP.md`, and explicitly out of V1.x/V2 scope
  here. If it is ever built, watched bytes crossing a peer boundary are
  untrusted and `wrapUntrusted`-fenced exactly as local watches are.

---

## 10. Test plan

- **Bun (pure):** due-task scan, re-arm computation (incl. cron next-fire
  + the 1-min floor), missed-fire collapse, budget checks, matcher
  evaluation (Phase B), grant hashing/voiding (Phase C). Values in,
  values out.
- **In-browser (`extension/tests/runner.html`, headless via CDP):** real
  `chrome.alarms` arm/clear, the boot scan re-arming after a simulated
  cold start, the offscreen-doc dispatch path, `ctx.unattended`
  hard-denials at the gate, generic-notification content, the IDB store
  upgrade path. These catch the integration breakage unit tests can't.
- **Eval (`extension/eval/`):** add scheduled-fire tasks that assert (a)
  a preview fire produces a report with zero side-effecting tool calls,
  (b) an unattended `schedule_task` call is refused, (c) a `no-window`
  fire journals cleanly without opening a window.

---

## 11. Open questions (resolve during build)

1. **Cheaper model for preview fires?** A read-only digest could default
   the resumed turn to the configured small/fast model to cut cost. Needs
   a per-task `model` override surfaced in the card. Lean yes for preview,
   user's main model for acting.
2. **Run-now-preview vs run-now-real.** "Run now" in the Scheduled view
   should run at the task's *current* tier (preview tasks preview). Add a
   separate "Test as it will run" affordance only if users ask.
3. **Per-fire cost tally plumbing.** Confirm the cost accumulator
   (`cost/accumulator.js`) can scope a fresh tally per fire distinct from
   the session-global spend limit (needed for `perFireUsd`). If not, tag
   fire cost via the audit lineage and sum there.
4. **Continuation re-entry (Phase C).** Exactly how a continuation re-arms
   a goal run — re-enter goal mode with its persisted state, or start a
   fresh turn that re-states the goal? Decide with the goal-mode owner.

---

## 12. What we deliberately do NOT build

- No backend, no server cron, no push. Local-first stays local-first.
- No cloud sync of schedule definitions (the server-backed pattern).
- No exact-time guarantees, no sub-minute schedules.
- No arbitrary-code matchers in Phase B (declarative only; a JS-Sandbox-
  over-the-response escape hatch is explicitly deferred).
- No auto-opening a window for a tab-driving fire on an absent user.
- No silent acting under a stale or imported grant.

---

## Appendix — original design (DESIGN-08, merged)

This feature carries forward the decisions of the older locked design note
`DESIGN-08-schedule.md` (now retired into this section). The decisions in
§§1–12 above already incorporate it; what follows is the residue not
restated elsewhere.

### Provenance — the adversarial panel

DESIGN-08 was reviewed by an **adversarial panel (platform-truth + security
lenses)**; its must-fixes are the load-bearing constraints above and are
LOCKED, not open for casual relitigation during the build:

- **The IDB store is the single durable truth; `chrome.alarms` is a wake
  hint, not state** — recompute and re-arm from the store unconditionally
  on every boot (Firefox clears alarms at session end, so the boot scan is
  the only missed-fire delivery path there). *(platform-truth)*
- **Trust boundary:** the wake frame + user-authored `instructions` are
  trusted; anything derived from a watched response (matched value, body,
  "what changed") is untrusted and enters context only via `wrapUntrusted`.
  *(security)*
- **Unattended turns can never widen themselves** — `schedule_task` /
  `schedule_cancel` / `wait_for` / any grant edit are HARD-DENIED at the
  gate before confirmation is consulted, killing the "schedule a new
  full-auto task for me" injection pivot. *(security)*
- **Default unattended capability is an explicit allow-list of tool names,
  not "the read families"** — `read_api`/`call_api` can POST arbitrary
  bodies to non-denylisted hosts (an exfil channel) and primitive tab tools
  bypass the egress-allowlist hook, so both are OUT of the unattended set
  by name. *(security)*
- **Notifications are generic by rule** — task title + fired/needs-attention
  only, never result values or watched content (OS notification centers and
  lock screens are a leak surface). *(security)*
- **Budgets bind to a fresh, fire-scoped cost tally**, not the session-global
  spend limit, and are checked BEFORE a fire starts; hitting a limit pauses
  and notifies, never silently drops. *(should-fix, adopted)*
- **Module placement is deliberate:** `peerd-runtime/schedule/` is a sibling
  of `clock/`, not inside it — clock *observes* time, schedule *acts* on it.
  Nothing depends on schedule.

### Async-subagent continuations — the durable variant of DESIGN-11

(DESIGN-08 §4, not yet folded into the phasing above; sequenced after
DESIGN-11's in-session slice and Phase A's store/waker exist.)

`DESIGN-11` ships **in-session** async subagents: a non-blocking
`spawn_subagent` whose child runs in the live SW and pushes its result back
as a synthetic wake turn when done. That slice deliberately does NOT survive
the SW being killed — a child lost to SW death is reported `interrupted` on
the parent's next turn. This is the **durable upgrade**: make a long async
child survive a browser restart by routing its completion through the waker
instead of a live-SW callback. It needs no new agent-facing surface — durable
is a `mode` on the spawn, not a new tool. See
`docs/specs/DESIGN-11-async-subagents.md` §"Phasing" Phase 3.

Mechanism, reusing everything above:

- A child spawned in "durable" mode registers a `kind:'continuation'` task
  whose `action.sessionId = parentSessionId`, carrying `{childSessionId,
  caps}`. The child session is just a session with durable history, so it is
  independently recoverable.
- Two completion paths converge on the **same** re-entry: (a) the child
  finishes while the SW is alive → enqueue the continuation, which fires the
  parent wake turn; (b) the SW died mid-child → the boot scan finds the
  `running`-with-stale-heartbeat child, re-enters the **child** session to
  finish it (a normal resumed turn), then enqueues the parent continuation.
  One durable path, not two regimes.
- The parent wake carries the child's `finalAssistantText` as the
  **untrusted** portion via `wrapUntrusted`; only the one-line "subagent X
  finished" framing is trusted temporal text. Reintegration is **idempotent**
  (a `reintegrated` flag flipped atomically on first commit; a redelivered
  fire is a no-op) and **coalesces** sibling completions into one wake.
- **Vault-locked is first-class:** a child that finishes while the vault is
  locked cannot run the parent turn (the model key is gated). Mark the task
  `paused`, fire the generic notification, badge the session row, and
  re-drain on the next unlock (`vault.subscribe`) — never run the model
  locked, never silently drop.
- Heartbeat: the live driver bumps `task.heartbeatAt` every N seconds so the
  boot scan can distinguish "still running in this SW" from "died mid-run"
  (older than ~2N ⇒ interrupted, then resume).

This was DESIGN-08's phase **08d**: durable async subagents — a long async
child survives SW death via a `continuation` task + heartbeat + boot-scan
resume, with vault-locked-on-completion as a first-class `paused` state that
re-drains on unlock.
