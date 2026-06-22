# FEATURE — Smart Nudges (proactive suggestions)

> **Status:** SPEC, build-ready. **Module:** `peerd-runtime/` — specifically
> a small `peerd-runtime/nudges/` policy module plus two tool defs and one
> side-panel card component. No new `peerd-*` top-level module. Phase 1 is
> **~1 engineer-week**.
>
> **Hard constraints honored (from the brief):** nudges are **OFF by
> default and opt-in**; peerd is not the "always watching" agent.

---

## 0. The thesis tension, stated up front

The brief's motivating example — *"you have N unread emails — want me to
summarize?"* — describes an **ambient, page-state-scanning** suggestion
engine. That model is **incompatible with peerd's thesis and culture**,
and this spec deliberately does **not** build it as the default:

- peerd's owner rule is **the agent never steals focus** and surfaces
  things passively; an engine that watches your tabs to volunteer
  unprompted offers is the opposite posture.
- The session **event recorder was deliberately removed (2026-06-12)** as
  context bloat that confused models in the field. Re-introducing a
  standing "observe everything the user does" loop walks straight back
  into that.
- peerd's whole security story is that **untrusted page content never
  reaches the powerful context** (the do/get/check runner boundary). An
  ambient engine that reads every page to decide what to suggest is a new,
  always-on ingestion of untrusted content — the exact surface peerd spent
  its architecture closing.
- It reads as surveillance. peerd ships **no telemetry**; "we're
  continuously analyzing your browsing to be helpful" is off-brand even
  when it's local.

So peerd's "Smart Nudges" are reframed to what is actually useful **and**
thesis-aligned, and it happens to match how the comparable product really
implements them (verified): **a nudge is a structured suggestion the agent
emits as a tool call during a turn the user already started, rendered as
an inline card. It is not a background scanner.** No standing observer, no
extra model call, no page-content ingestion — the suggestion rides the
work the user already asked for.

The one sanctioned form of "ambient" — "tell me when CI goes red" — is
**not** a scanner either; it is a **user-armed watch** that reuses the
Scheduled Tasks machinery (`FEATURE-SCHEDULED-TASKS.md`, Phase B). The
user names the target explicitly; nothing is watched that the user didn't
point at.

---

## 1. What a nudge is in peerd

A **nudge** is a small, structured, opt-in suggestion surfaced as an
**inline card in the side panel**, offering the user a single next action
they can accept, dismiss, or silence. Two delivery models, by phase:

| Model | When it fires | Cost | Default |
|---|---|---|---|
| **Reactive nudge** (Phase 1) | During a turn the user started, when the agent recognizes a suggestible situation, it calls a nudge tool. | **Zero extra LLM call** — it's a tool the already-running agent invokes. | OFF (opt-in) |
| **Armed watch** (Phase 2) | A target the user explicitly asked to be alerted about changes. | A scheduled `webFetch` poll (no extra reasoning call until it actually fires). | OFF; created per-target by the user |

There is intentionally **no third "ambient scanner" model** in V1.x. §7
specifies the narrow, heavily-gated conditions under which a future
opt-in ambient hint could exist, and why it is not the default.

---

## 2. Phase 1 — reactive nudges (the flagship)

### 2.1 Nudge classes

Two nudge tools, both emitting a structured card payload, both **at most
once per conversation**:

1. **`suggest_schedule`** — the flagship; the natural bridge to
   `FEATURE-SCHEDULED-TASKS.md`. After a turn whose work plausibly
   recurs ("here's today's GitHub digest," "the cheapest flight right
   now is…"), the agent may offer: **"Run this every morning?"** Accepting
   opens the Scheduled-task confirm card (preview tier; nothing arms
   silently). This is the highest-value nudge because it converts a
   one-off into durable utility with one tap, and it's pure upside —
   no surveillance, no extra cost.

2. **`suggest_skill`** — when the user just walked the agent through a
   repeatable multi-step procedure by hand ("first filter to open PRs,
   then…"), the agent may offer: **"Save this as a reusable skill?"**
   Accepting drafts a `SKILL.md` via the existing skills mechanism
   (confirm-gated). Optional for Phase 1; ship if the skills owner agrees
   the capture flow is cheap.

> **Why not a peerd "connect this app" nudge?** The comparable product's
> second nudge type asks the user to OAuth-connect an external app so the
> agent can use a hosted integration. peerd has **no MCP / no app
> connectors by thesis** — the web app *is* the integration, reached with
> `do`/`get`/`check`. So there is nothing to "connect," and the system
> prompt already tells the agent to just `open_tab` and work. The peerd
> analog of "you're blocked, here's the unblock" is the existing,
> non-nudge behavior: surface a denylist refusal, or tell the user a tab
> needs a manual login (the runner already hands off on credential walls).
> We do **not** add a connect-app nudge.

### 2.2 How it works (no new machinery, no extra call)

A nudge tool is an ordinary tool def in `peerd-runtime/tools/defs/`. Its
`execute` does not act — it returns a structured payload the side panel
renders as a card:

```
{ kind: 'nudge', type: 'schedule' | 'skill', title, rationale, params }
```

The agent calls it as the **last tool call of a turn** (for
`suggest_schedule`) when the prompt's nudge guidance (below) says it's
warranted. Because it's just another tool in the turn the user already
paid for, **there is no separate model invocation, no batching question,
no background loop.** The card streams in under the assistant message like
any tool card.

### 2.3 The prompt guidance (gated, terse, ship this)

Added to the main system prompt **only when nudges are enabled** (the
block is omitted entirely when the feature is off — zero tokens for the
default config). Concrete text in `SYSTEM-PROMPT-LESSONS.md` §"nudges";
the shape:

- Call `suggest_schedule` **at most once per conversation**, as the final
  action, only when the completed task plausibly recurs and needs no
  real-time human decision. Infer cadence/name from context; do not
  interrogate the user.
- **Emit the nudge card with no surrounding prose.** The card is the
  message; narrating it ("I've added a suggestion below…") is redundant
  and clutters the chat. (This mirrors the verified competitor rule and is
  good UX hygiene.)
- Never nudge to push an action with real-world consequences; a schedule
  nudge always lands in **preview** tier.
- If the user has dismissed this nudge type before for similar work
  (suppression, §4), do not re-offer.

### 2.4 Surface: inline card, never an interruption

- Nudges render **inline in the side panel**, beneath the turn that
  produced them. **Never** a toast, a popup, an OS notification, a
  new-tab takeover, or anything that steals focus or fires when the side
  panel is closed. (Owner rule: never steal focus.)
- A nudge that the user ignores simply scrolls away with the
  conversation. No nagging, no re-surfacing.

---

## 3. Phase 2 — armed watches (the only sanctioned "ambient")

"Tell me when CI goes red," "ping me when this product is back in stock,"
"let me know when the visa-slot page changes." These feel proactive but
are **user-armed, single-target watches** — not scanning.

- Implemented entirely as **Scheduled Tasks watches**
  (`FEATURE-SCHEDULED-TASKS.md` Phase B): a `watch` task with a pinned
  host, GET-only `webFetch`, a hardened declarative matcher, and backoff.
- When the matcher trips, the watch fires a normal (read-only) resumed
  turn that **surfaces a nudge card / generic notification** — "CI for
  repo X is now red." The watched bytes are `wrapUntrusted`-fenced and
  never ride a trusted frame.
- The user created it by explicitly naming the target. Nothing ambient,
  nothing scanned, no page the user didn't point at.

This is the honest, safe answer to "proactive based on browser/page
state." It is proactive about **one thing the user asked to be told
about**, on a timer, through the egress chokepoint — not a standing
analysis of everything.

No new code beyond Scheduled Tasks Phase B + the shared nudge card.

---

## 4. User controls

- **Master switch: OFF by default.** Settings → a single "Proactive
  suggestions" toggle. Nothing in this feature does anything until the
  user turns it on. When off, the nudge tools are **not registered into
  the agent's manifest** and the prompt block is omitted — so it is off at
  the source, not merely hidden.
- **Per-class toggles:** schedule suggestions / skill suggestions
  independently.
- **Frequency throttle:** hard cap of **once per nudge-type per
  conversation** (enforced in `nudges/` policy, not just by prompt), plus
  a global cooldown so a heavy session can't produce a wall of cards.
- **"Don't suggest this again":** dismissing a card with the overflow
  option writes a **suppression record** (§5) keyed by nudge type +
  a coarse signature of the situation. The prompt guidance and the policy
  module both consult it; suppressed situations never re-nudge.
- **Mute for session / snooze:** one-click "no suggestions this session."

Defaults are conservative on purpose: a user who never opens Settings
never sees a nudge.

---

## 5. Persistence

Small and boring — no new store needed if a settings/prefs store exists;
otherwise a `nudge_prefs` record:

```
NudgePrefs {
  enabled: boolean            // master, default false
  classes: { schedule: boolean, skill: boolean }   // default false
  suppressions: Array<{ type: string, signature: string, at: number }>
  lastShownAt: number | null  // global cooldown bookkeeping
}
```

Armed watches persist as `schedule_tasks` records (Phase 2) — no separate
storage.

---

## 6. Model interaction & cost

- **Reactive nudges (Phase 1): no extra model call.** The suggestion is a
  tool the running agent invokes within the turn the user already
  initiated. There is nothing to batch and no cheaper-model question — the
  whole point is that it costs ~nothing beyond the tool-call tokens.
- **Armed watches (Phase 2):** the poll is a `webFetch` + a tiny
  declarative matcher (no model call). A model turn is spent **only when
  the matcher actually trips** — i.e., you pay for reasoning exactly when
  there's something worth saying. Watch polls are rate-capped globally and
  back off on unchanged results.
- **No cheap-model "is this worth surfacing" classifier in V1.x**, because
  there is no ambient stream to classify. (If §7's gated ambient option is
  ever built, that is where a Haiku-tier worth-surfacing gate over
  *minimal non-content signals* would live — see §7.)

---

## 7. The ambient option we are NOT shipping (and the rails if we ever do)

For completeness, since the brief asked about page-state observers: an
ambient "notice something on the current page and offer help" engine is a
**V2+, opt-in, heavily-gated** possibility — **not** part of this feature,
and not recommended for launch. If it is ever revisited, these rails are
non-negotiable, and they exist to keep it from becoming surveillance:

- **Off by default, separately opt-in** from reactive nudges, with a
  blunt one-line description of exactly what it observes.
- **No page content in the deciding step.** The "should I offer
  something?" gate may see only **minimal, non-content signals** the
  browser already exposes without reading the DOM — the active tab's
  **host** and **title**, tab count, and time-of-day. It must **never**
  read page text to decide whether to nudge. (Reading page text is what
  the do/get/check runner is for, and it only happens *after* the user
  accepts and the agent runs a real turn.)
- **Cheap-model gate, throttled.** A Haiku-tier classifier over those
  minimal signals outputs `{ worth_surfacing, confidence, reason }`; a
  nudge is considered only above a confidence threshold and within a
  strict per-hour cap. The classifier never generates the suggestion — it
  only decides whether to let the agent propose one.
- **Still an inline card, still never focus-stealing, still suppressible.**
- **Still no new egress** — the gate model call rides `safeFetch`.

Even with all that, this remains a posture shift for peerd. The
recommendation in this spec is: **don't build it for launch.** Ship the
reactive nudge + armed watch, which deliver the real user value ("turn
this into a recurring thing," "tell me when X changes") without standing
observation. Revisit the ambient option only on clear demand, behind its
own opt-in.

---

## 8. Interaction with do/get/check (the security boundary holds)

- A nudge **never** ingests page content into the main context. The card
  payload is the agent's own structured suggestion, not page bytes.
- If a suggestion's *justification* depends on page state ("this cart has
  3 items expiring"), that state was already obtained through `get` /
  `check` during the user's turn — i.e., it passed through the runner
  boundary and arrived as a fenced summary, exactly as today. The nudge
  adds no new path to page content.
- Armed watches (Phase 2) read through `webFetch` with the watch
  host-pin; matched bytes are `wrapUntrusted`-fenced before any model sees
  them. A nudge derived from a watch never elevates watched content to a
  trusted instruction.

---

## 9. Phasing & effort

| Phase | Scope | Effort |
|---|---|---|
| **1** (V1.x) | Master + per-class toggles (default off); `suggest_schedule` tool + card; suppression store; prompt nudge block (gated on enabled); throttle/cooldown in `nudges/` policy; eval cases. `suggest_skill` if skills owner agrees. | **~1 week** |
| **2** (V1.x+) | Armed-watch → nudge wiring (rides Scheduled Tasks Phase B); shared nudge card reused for watch alerts. | ~2–3 days on top of Scheduled Tasks Phase B |
| **(deferred)** | The §7 ambient option — only on demand, behind its own opt-in. | not scheduled |

---

## 10. Test plan

- **Bun (pure):** throttle logic (once-per-type-per-conversation, global
  cooldown), suppression matching, the gated-prompt-block assembly
  (present only when enabled).
- **In-browser:** a card renders inline and never raises a toast /
  notification / focus change; the master-off state registers no nudge
  tools and emits no prompt block; "don't suggest again" writes a
  suppression that silences the next matching situation.
- **Eval (`extension/eval/`):** (a) with nudges ON, a recurring-looking
  task ends with exactly one `suggest_schedule` card and no prose about
  it; (b) with nudges OFF, the same task emits zero nudges; (c) a
  non-recurring task (one-off lookup) emits no schedule nudge.

---

## 11. What we deliberately do NOT build

- No background page/tab scanner. No standing "observe the user" loop
  (we removed the event recorder on purpose).
- No focus-stealing surface — no toast, popup, OS notification, or
  new-tab takeover for nudges.
- No connect-an-app nudge (peerd has no MCP/app connectors; the web app is
  the integration).
- No nudge that pushes a real-world-consequence action; schedule nudges
  always land in preview.
- No extra LLM call per nudge in V1.x.
- Nothing on by default.
