# peerd-runtime

> The **`r`** (green) in the peerd wordmark — the agent.
> The loop, the tool dispatcher and its six gates, the do/get/check
> browser runner, subagents, sessions, memory, skills, review, goal
> mode, cost telemetry, the composer, voice, and the clock. This
> is the biggest module and the one the user actually talks to. Part of
> [peerd](../../README.md); read the root README first, then
> [`ARCHITECTURE.md`](../../ARCHITECTURE.md) and
> [`DESIGN.md`](../../DESIGN.md).

**Status: 0.x — experimental beta.** The agent loop, tools, and the
do/get/check security boundary are shipped. Native in-browser WebGPU
inference and full multi-profile isolation are not built yet; the
Firefox/no-CDP automation path is the default but has permanent gaps.
See [known limitations](#known-limitations).

---

## What it does

`peerd-runtime` is everything agent-facing. It takes a user turn, builds
the system prompt, streams the model, dispatches the tools the model
calls (through six security gates), and loops until the task is done or
stopped. On top of that loop it layers the features that make peerd a
harness rather than a chat box: a disposable page-reading runner,
subagents, file-based memory, skills, a review subagent, an autonomous
goal mode, cost metering with a hard spend limit, slash commands,
voice, and temporal grounding.

The defining design choice lives here: **the main agent never reads a
raw page.** A clean-context runner with no keys, no egress, and no
spawn does the DOM work and returns a fenced, untrusted summary, so an
injected page can't reach anything worth exfiltrating. That's the
do/get/check layer.

The runtime is **independent of the model providers.** It speaks one
provider-agnostic message shape and dispatches through
[`peerd-provider`](../peerd-provider/README.md)'s registry; it neither
knows nor cares which adapters are installed. Which providers exist is a
provider concern, not a runtime one.

## The tool inventory (verified against source)

| Group | Count | Notes |
|---|---|---|
| `BUILTIN_TOOLS` | 58 | inspect, DOM/page, sessions, VM/Notebook/App, edit, subagent, do/get/check, memory, review, dweb |
| Clock | 2 | `now`, `wait_until` |
| Web | 1 | `capture` (the only remaining web wrapper — see `WEB_TOOLS`; `fetch_url` is a `BUILTIN_TOOLS` def). `call_api`/`read_article`/`web_search`/`submit_form` were all removed — the web actor covers web work via `fetch_url` + its DOM tools |
| `load_skill` | 1 | registered like a built-in |
| **Total registered** | **66** | |

Not all 66 reach the main agent:

- **The low-level DOM/page tools are runner-only** — `read_page`,
  `snapshot`, `read_state`, `watch_changes`, `query_dom`, `page_eval`,
  `page_exec`, `page_keys`, `navigate`, `type`, `click`, `read_pdf`
  (and `fetch_url`). They stay registered (the runner/web-actor gets
  them via tool narrowing) but are hidden from the main agent at dispatch
  (`tools/exposure.js` `MAIN_AGENT_HIDDEN_TOOLS`). The main agent reaches
  the page only through `do` / `get` / `check` or by messaging a tab's
  actor.
- **7 dweb tools** reach the main agent on the **preview** build only;
  on the store build they're absent from the descriptor list.

So **54 tools reach the main agent on preview, 47 on the store build.**
Progressive disclosure trims the *visible-this-step* surface further:
instance-gated engine ops (`vm_write_file`, …) appear only once the chat
has an instance of that kind, and the dweb secondary controls
(`dweb_peers`, `dweb_block`, `dweb_discovery`) appear only once the
session has called a dweb tool.

## How it works today

### The agent loop (`loop/`)

An async generator. Per turn it builds the system prompt once, then
loops up to `MAX_STEPS = 100`: recompute the visible tool set (for
progressive disclosure), stream the model (text / reasoning / tool-use
deltas), dispatch the resulting tool calls, and continue. Consecutive
**READ-class** calls run as parallel waves (never hoisted past a write,
confirm-gated calls never race), reassembled in emitted order. Stop and
steer land at iteration boundaries; partial state persists. Long
sessions get **rolling trim-summaries**: the oldest history compresses
into a persisted structured summary (an optional cheap model call with a
mechanical fallback that never blocks).

### The six-gate dispatcher (`tools/`)

Every tool call passes through `persona → exposure → origin →
confirmation → egress → audit`, with full lineage attached to the
result:

- **persona** — Plan/Act enforcement (`decideAction`): Plan refuses
  side-effecting tools but permits pure URL loads.
- **exposure** — runner-only enforcement: the main agent is refused the
  hidden DOM tools at dispatch.
- **origin** — the denylist (seed + user overlay).
- **confirmation** — async, policy-driven (the one *Confirm before
  actions* toggle: on = every non-read confirms).
- **egress** — a no-op in the chain; enforcement lives in the
  egress-allowlist **pre-tool-use hook** and `safeFetch` in
  [`peerd-egress`](../peerd-egress/README.md).
- **audit** — records everything.

Pre/post tool-use **hooks** (`tools/hooks/`) are fail-closed; the egress
allowlist rides the pre-hook.

### do / get / check (`runner/`)

The main agent's only browser surface. `do` (act), `get` (read), and
`check` (assert) each spawn a disposable browser-runner subagent with a
fresh context, a narrowed DOM toolset, and a step budget. The runner
drives one tab, wraps page content as `<untrusted_..._content>`, and
returns a plain-text summary, itself re-wrapped untrusted on the way
back. **Scripting is the default automation path** on store-Chrome and
Firefox (a DOM-walk pseudo-snapshot feeding the same serializer); CDP
ships preview/dev only. CDP-only paths (`page_exec` on Trusted-Types
pages, trusted `page_keys` input) return a `debugger_unavailable` error
elsewhere.

### Everything else

- **Subagents** (`subagent/`) — depth-bounded (≤5), tool-narrowed,
  output-capped; async by default (a handle returns immediately, the
  child's result re-enters as a wake turn) with a per-parent cap. See
  [`docs/SUBAGENTS.md`](../../docs/SUBAGENTS.md).
- **Permissions** (`permissions/`) — Plan/Act + the single
  confirm-actions toggle, plus **per-session tool manifests** (`/tools
  research|browse-only|full`) enforced fail-closed at both descriptor
  filtering and dispatch, inherited by subagents as an intersecting
  authority bound.
- **Memory** (`memory/`) — file-based AGENTS.md memory injected as
  `{{MEMORY_BLOCK}}`, `/init` workspace scanner, confirm-gated
  `remember`, and **auto-memory** (wrap-up extraction proposes durable
  notes as pending suggestions you approve or dismiss, never
  auto-written).
- **Skills** (`skills/`) — progressive disclosure: cheap descriptions in
  the prompt, the full SKILL.md body loaded only on `load_skill`;
  enabled skills surface as `/<name>` commands. Remote install is gated
  off for the store channel.
- **Review** (`review/`) — `request_review` spawns a clean-context,
  read-only reviewer over a diff. See
  [`docs/REVIEW.md`](../../docs/REVIEW.md).
- **Goal mode** (`loop/goal-runner.js`) — the Goal toggle arms the next
  message to start an autonomous run: the agent keeps taking normal turns
  in the main chat (later turns are hidden `synthetic` continuation
  nudges) until it calls `complete_goal`, the user hits Stop, or a 40-turn
  cap is hit. Runs persist and resume on SW restart, and auto-flip the
  session to Act + confirm-off for their duration.
- **Cost** (`cost/`) — per-turn/per-session token + dollar metering and
  a hard `spendLimitUsd` ceiling.
- **Composer** (`composer/`) — slash commands + @-refs (tabs, files).
- **Clock** (`clock/`) — a minimal self-describing per-turn `<time>`
  block plus `now` / `wait_until` tools.
- **Voice** (`voice/`) — local Moonshine transcription (WASM,
  SRI-pinned) with a Web Speech fallback, hosted offscreen.
- **Profiles** (`profiles/`) — the default profile + first-run
  onboarding (the multi-profile *shape*; namespacing is still ahead).
- **DOM** (`dom/`) — the a11y-tree serializer, diffable snapshots,
  element refs, and the DOM-walk pseudo-snapshot used as the universal
  no-CDP fallback.
- **Transfer** (`transfer/`) — settings export/import.

## Public API (`index.js`)

A large surface (~250 exports). The entry points core code wires:
`runUserTurn` (the loop), `registerTool` / `getTool` / `listTools` and
`dispatchToolCall` (the dispatcher), `BUILTIN_TOOLS` / `CLOCK_TOOLS` /
`WEB_TOOLS` / `loadSkillTool`, `mainAgentDescriptors` and the exposure
filters, the session store, `makeSpawnSubagent`, `createMemoryStore`,
`createSkillRegistry`, `makeRequestReview`, the goal runner, the cost
tracker, the composer parser, and the permission classifiers, plus the
tool-manifest presets and default hooks.

## Known limitations

- **Multi-profile is shape-only.** The default profile and onboarding
  landed in the multi-profile shape; per-profile vault/denylist/skills/
  memory/session namespacing is still ahead.
- **Firefox/no-CDP gaps are permanent.** The DOM-walk fallback is the
  default path, but Trusted-Types `page_exec` and trusted synthetic
  input have no Firefox-side API and stay CDP-only.
- **No user-facing undo/redo.** Generalized turn rollback was decided
  against (2026-06-12); workspace snapshots survive only as review's
  `diffSince` substrate.
- **Async subagents are in-session only.** A service-worker death loses
  an outstanding child (reported interrupted on the next drain). Durable
  subagents are future work.

## TODO / backlog

In-code TODOs are light (labelled slots in `memory/initializer.js`). The
runtime-facing backlog (tracked in GitHub Issues):

- **Multi-profile namespacing** — the full per-profile isolation story.
- **Lineage-based context compression** for very long sessions (beyond
  today's rolling trim-summaries).
- **Per-session tool-manifest residuals** — the manifest layer ships;
  finer authority/lineage work remains.

Provider coverage (the OpenAI adapter, native in-browser WebGPU
inference) lives in [`peerd-provider`](../peerd-provider/README.md), not
here: the runtime is provider-agnostic.

## See also

- [`docs/DO-GET-CHECK-DESIGN.md`](../../docs/DO-GET-CHECK-DESIGN.md) — the
  runner layer.
- [`docs/SUBAGENTS.md`](../../docs/SUBAGENTS.md),
  [`docs/REVIEW.md`](../../docs/REVIEW.md),
  [`docs/skills/`](../../docs/skills/),
  [`docs/hooks/`](../../docs/hooks/),
  [`docs/COMMANDS-DESIGN.md`](../../docs/COMMANDS-DESIGN.md),
  [`docs/DOM-NAVIGATION-DESIGN.md`](../../docs/DOM-NAVIGATION-DESIGN.md) —
  the per-feature design records.
- [`peerd-egress`](../peerd-egress/README.md) — the gates and the
  no-web-tools runner boundary.
