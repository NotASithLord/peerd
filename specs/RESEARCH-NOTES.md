# RESEARCH NOTES — sources, method, and provenance

> **Why this file exists:** defensive documentation. peerd is Apache-2.0;
> BrowserOS is **AGPL-3.0**. This file records exactly what we read, how we
> read it, and which idea in the specs came from where — so that if the
> provenance of the Scheduled-Tasks / Smart-Nudges / inventory work is ever
> questioned, the trail is explicit. **The deliverable specs contain no
> BrowserOS source code.**

---

## 1. Methodology (and an important mid-task change)

**Original method (the brief):** prefer PUBLIC DESCRIPTIONS over source —
docs, README, blog, release notes — and avoid reading BrowserOS
implementation source to keep a clean copyleft boundary.

**Owner-directed change, mid-task:** the owner subsequently directed that
we **also read BrowserOS source to verify the public-docs findings and
build genuinely accurate understanding**, with one explicit safeguard:
**the deliverable artifacts must contain no source code — only maximally
accurate behavioral descriptions and peerd-native advice.** This file
documents that change so the posture is unambiguous.

**How the safeguard was honored:**
- Source was read **via the GitHub API only** (`gh api … -H "Accept:
  application/vnd.github.raw"`). The BrowserOS repo was **not cloned**, and
  **no BrowserOS file was saved into the peerd tree** or anywhere on disk.
- The five spec files contain **zero BrowserOS source code** — no code
  blocks, no copied function/type/file bodies. Where BrowserOS tool names
  or app names appear, they are **public product-feature names** used only
  for the comparison, never proposed as peerd identifiers.
- All peerd-facing designs use **peerd-native naming** (`schedule_task`,
  `suggest_schedule`, `peerd-runtime/schedule/`, etc.). All prompt text in
  `SYSTEM-PROMPT-LESSONS.md` is **original wording**, re-expressing
  patterns from scratch — no prompt strings were copied.
- The reading was for **verification and understanding**; the designs are
  derived from peerd's own architecture and its existing, locked
  `DESIGN-08-schedule.md`, not transliterated from BrowserOS.

**Net result:** the deliverables are clean. Reading source improved the
*accuracy* of the behavioral descriptions and the inventory; it did not
introduce copied expression.

---

## 2. Sources

### 2.1 BrowserOS — public documentation (read first, all clean)
| URL | Type | Covered |
|---|---|---|
| docs.browseros.com (+ /llms.txt site map) | docs | Chat/Agent/Graph modes, feature index |
| docs.browseros.com/features/scheduled-tasks | docs | Schedule UX, types, background exec, 10-min timeout, 15-run history, sync |
| docs.browseros.com/features/smart-nudges | docs | App-connection + schedule-suggestion nudges, card delivery, suppression |
| docs.browseros.com/features/cowork (+ comparisons/claude-cowork) | docs | Local file/command tools, folder sandboxing claim |
| docs.browseros.com/features/memory (+ blog soul-memory-engineering) | docs | CORE.md + daily memory, fuse.js search, 30-day expiry |
| docs.browseros.com/features/soul | docs | SOUL.md, 150-line cap, presets, self-evolution |
| docs.browseros.com/features/connect-mcps | docs | 40+ integrations, OAuth, by category |
| docs.browseros.com/features/use-with-claude-code | docs | The 53-tool category breakdown |
| docs.browseros.com/features/workflows, /skills, /bring-your-own-llm | docs | Graph mode, SKILL.md, supported models |
| docs.browseros.com/comparisons/chrome-devtools-mcp | docs | Network/console tools "coming soon" |
| docs.browseros.com/changelog | docs | Agent v3 rebuild, tool counts, Agent Per Tab |
| github.com/browseros-ai/BrowserOS (README) | readme | Positioning, monorepo layout |

### 2.2 BrowserOS — source, read via GitHub API for verification (AGPL-3.0)
Repo: `browseros-ai/BrowserOS-agent` @ `main`. Files read (for behavioral
verification only; none reproduced in deliverables):
- **Scheduled tasks:** `apps/agent/lib/schedules/{scheduleTypes,
  createAlarmFromJob,scheduleStorage,scheduleSystemPrompt,
  getChatServerResponse}.ts`, `apps/agent/entrypoints/background/
  scheduledJobRuns.ts`.
- **Nudges:** `apps/server/src/tools/nudges.ts`.
- **System prompt / agent loop:** `apps/server/src/agent/{prompt,
  ai-sdk-agent,chat-mode,compaction}.ts`.
- **Tool registry + result shape:** `apps/server/src/tools/{registry,
  tool-registry,response}.ts`.
- **Tool capabilities:** `apps/server/src/tools/{input,page-actions,
  windows,navigation}.ts`.
- **Cowork filesystem:** `apps/server/src/tools/filesystem/*` +
  `output-file.ts`.
- **Memory + SOUL:** `apps/server/src/tools/memory/*`, `lib/soul.ts`,
  `apps/agent/lib/onboarding/soulPresets.ts`.
- **Integrations:** `apps/server/src/lib/clients/klavis/*`,
  `agent/mcp-builder.ts`.
- **Browser backends:** `apps/server/src/browser/backends/{cdp,
  controller,types}.ts`.
- **Workflows:** `apps/server/src/graph/executor.ts`.
- **Eval search:** tree-wide; only `apps/cli/cmd/eval.go` (a JS-in-page CLI
  command, not a benchmark) found.

**AGPL license headers observed** on (not reproduced): the klavis files,
`agent/chat-mode.ts`, `graph/executor.ts`, `api/services/graph-service.ts`,
`packages/shared/src/constants/{paths,limits}.ts`. Many other files read
carried no inline header; a top-level `LICENSE` governs the repo.

### 2.3 Analogous harnesses & primitives (MIT/Apache/vendor docs — safe)
- **chrome.alarms / chrome.offscreen / SW lifecycle** —
  developer.chrome.com; **browser.alarms** — MDN (Firefox: no persistence
  across sessions).
- **Cron libs** — croner, cron-schedule, cronstrue, cron-parser (all MIT,
  zero-dep, browser-capable).
- **browser-use** (MIT) — indexed-DOM, `evaluation_previous_goal`
  self-check, action-list-per-step, `done`+success.
- **Stagehand** (MIT) — `act`/`extract`/`observe`, atomic-instruction +
  specificity philosophy, observe-before-act.
- **Nanobrowser** (Apache-2.0) — planner/navigator/validator, direct-URL +
  viewport-first efficiency, credential handoff.
- **Anthropic** — Computer Use docs (confirm-before-irreversible,
  self-verify loop), "writing tools for agents" (tool-description
  principles), agent-autonomy research (ask-when-uncertain).
- **MCP** — modelcontextprotocol.io + servers repo + official registry
  (category taxonomy).

### 2.4 peerd internal (the design baseline)
`CLAUDE.md`, `ARCHITECTURE.md`, `ROADMAP.md`, **`DESIGN-08-schedule.md`**
(the locked, unbuilt schedule design these specs implement),
`docs/DO-GET-CHECK-DESIGN.md`, `peerd-provider/system-prompt.txt`,
`peerd-runtime/{loop/system-prompt.js, tools/exposure.js,
tools/manifests.js, subagent/spawn.js, tools/defs/*}`, and a structured
read of the egress / IDB / clock / memory / offscreen / engine subsystems.

---

## 3. What each BrowserOS source confirmed or corrected vs the public docs

- **Scheduled tasks are simpler and less hardened than peerd's design.**
  Source uses `chrome.storage.local` arrays (not durable IDB), **one alarm
  per job** (not a single pinned waker), and relies on Chrome alarm
  persistence + a coarse 24h boot "missed jobs" scan (would not survive
  Firefox's session-end alarm clearing). 15-run history and a 10-min stale
  cleanup confirmed. **No budgets, grants, dry-run, unattended clamps, or
  watches.** → peerd's `DESIGN-08` already exceeds this; our spec builds
  DESIGN-08 and merely *borrows the pragmatic bits* (run-history cap, boot
  missed-run scan, the simple daily/hourly/minutes UX).
- **Scheduled execution runs against a server.** The extension POSTs the
  query + API key + context to `${agentServerUrl}/chat` and renders a
  streamed event protocol; schedule **definitions sync to a cloud backend
  keyed by `userId`.** → This is the architectural opposite of peerd
  (in-browser loop, BYOK, no backend). It validates *why* peerd's egress
  chokepoint and in-browser execution are the load-bearing constraints in
  our schedule spec.
- **Nudges are agent-callable tools, not a scanner.** `suggest_schedule`
  (post-task) and `suggest_app_connection` (blocking pre-task) emit card
  payloads during a normal turn; the system prompt gates them ("at most
  once per conversation," "emit with zero text"). **No ambient
  page-scanning, no extra model call.** → Confirms our nudge spec's core
  decision and our rejection of the ambient "you have N unread emails"
  model.
- **"40+ integrations" = 47 apps via the Klavis "Strata" CLOUD MCP
  gateway.** Not native connectors — a hosted third-party endpoint, OAuth
  by Klavis, tools registered dynamically. → Sharpens the inventory's
  thesis-divergence verdict (don't adopt; use web-driving + API-recipe
  skills).
- **Cowork = full host-level coding agent.** Unrestricted `bash` with the
  server's env, **no path jail**, follows symlinks; upload takes
  **absolute host paths**; downloads/PDF write to **host disk**. → The
  docs' "sandboxed to one folder" framing is generous; source shows the
  working dir is a *starting point*, not a jail. This is the inventory's
  hardest "do NOT adopt."
- **Memory = fuse.js lexical search** (not embeddings); **SOUL.md = 150-
  line self-evolving identity, 4 presets** (Balanced/Professional/Friendly/
  Minimal). → Informs the inventory (memory: covered; search is a minor
  candidate) and the prompt spec's "don't adopt self-rewriting SOUL"
  recommendation.
- **Browser control = CDP against a FORKED Chromium with custom `Browser.*`
  domains** + an inbound controller-extension websocket. → BrowserOS owns
  the browser; peerd rides any unprivileged browser. Reframes the whole
  comparison.
- **Agent loop = Vercel AI SDK `ToolLoopAgent`, 100-step cap, 200K
  context, multi-stage adaptive compaction.** Comparable to peerd's
  MAX_STEPS=100 + rolling trim summaries.
- **No eval/benchmark harness in the agent repo** (only a CLI `eval` that
  runs JS in the page). → Contradicts the public README's implication of a
  benchmark framework. **peerd is ahead here** (`extension/eval/`).
- **Tool count:** the registry is **56** browser tools (Nav 8, Obs 8,
  Input 14, Page-actions 3, Windows 5, Bookmarks 6, History 4, Tab-groups
  5, Info 1, Nudges 2), plus separate filesystem/memory/soul/skills/Strata
  toolsets — i.e., "53+" is a marketing floor.

---

## 4. Idea provenance — which spec idea came from where

| Spec idea | Source |
|---|---|
| Durable "alarm that resumes a conversation"; IDB-as-truth; single pinned waker; Firefox boot-scan; unattended clamps; budgets; dry-run; watches; grants | **peerd's own `DESIGN-08-schedule.md`** (pre-existing, locked). Our spec implements it. |
| chrome.alarms floor (30s/1min), Firefox no-persistence, offscreen-doc lifetime, cron-to-timestamp pattern | Chrome/MDN docs + croner-class libs |
| Run-history cap (15→our 20), stale-run cleanup, boot missed-run scan, simple daily/hourly/minutes UX, "needs browser open" honesty | BrowserOS source (pragmatic bits worth borrowing) |
| Nudge = agent-emitted tool rendered as inline card; once-per-conversation; emit-with-no-prose | BrowserOS source (verified), aligned with peerd's never-steal-focus rule |
| Rejecting ambient page-scanning nudges | peerd thesis (event recorder removed; no surveillance; runner content boundary) |
| Armed-watch as the only "ambient" | peerd `DESIGN-08` watches + the brief's "watch CI" example |
| Cheap-model worth-surfacing gate (only in the deferred ambient option) | model-cascade research + Nanobrowser cheap-planner pattern |
| Observe→act→verify; obstacle handling; error-recovery ladder; auto-included snapshot | BrowserOS prompt patterns + Computer Use self-verify + browser-use (re-expressed originally) |
| Atomic/batched + specific `do` instructions; observe-before-act `get` | Stagehand + browser-use (re-expressed) |
| Direct-URL + viewport-first efficiency; credential handoff | Nanobrowser (re-expressed) |
| Durable-wait hand-off (end turn, get resumed) | peerd `wait_for` design + the harness scheduling research |
| "Don't adopt self-rewriting SOUL; use layered presets" | peerd's confirm-gated memory + minimal-context rules, contrasted with BrowserOS SOUL.md |
| Inventory gaps (upload, bookmarks/history read, close_tab, sandboxed export) and do-NOT-adopt list | Side-by-side of verified BrowserOS registry vs peerd registry, judged against peerd's security model |

---

## 5. Where we deliberately DIVERGED from BrowserOS

These are decisions, not omissions:
- **No ambient suggestion engine** (surveillance posture; event recorder
  was removed; runner boundary).
- **No MCP / no cloud integration gateway** (no-backend, no-MCP,
  egress-chokepoint, no-telemetry thesis). Use web-driving + API-recipe
  skills.
- **No host filesystem / `bash`** (sandboxed-by-default; WebVM/JS Sandbox
  are the safe substitutes).
- **No host-path upload / host-disk export** (sandbox-sourced + browser-
  download only).
- **No cloud sync of schedules / no server execution** (in-browser, BYOK).
- **No self-rewriting personality file** (confirm-gated memory; minimal
  context).
- **No window choreography / focus stealing** (background tabs only).
- **No history deletion tools** (destructive + injection hazard).

---

## 6. Confidence & caveats

- BrowserOS moves fast (an "Agent v3" rebuild is noted in their
  changelog). Tool counts and exact behaviors reflect `BrowserOS-agent`
  `main` at the time of reading; treat specific numbers as "as of now."
- A few peerd subsystem details in the supporting research (exact IDB store
  lists, some tool return shapes) came from an automated code-map and are
  *illustrative*; the specs deliberately define their **own** schemas
  (grounded in `DESIGN-08` and files read directly) rather than asserting
  inferred peerd internals as fact. Verify field names against the live
  code at build time.
- No BrowserOS source was persisted; re-verification means re-reading via
  the GitHub API.
