# peerd V1 feature buildout — SUMMARY

**Integrated on local `main` (not pushed).** Ten SOTA developer-agent
primitives, each built browser-native, all on one branch. The combined Bun
suite is **429 pass / 0 fail / 39 files**; every non-vendor extension JS file
parses clean (`node --check` sweep). No MCP shipped in peerd anywhere.

The integrated system gives peerd the developer-harness feature set the
mid-2026 field converged on — persistent file memory + `/init`, Plan/Act with
permission tiers, search/replace edits with checkpoint/undo, slash commands,
progressive-disclosure skills, a Ralph loop, BYOK cost telemetry, a
clean-context review subagent, lifecycle hooks, and auto-memory with explicit
review — but expressed through the browser substrate rather than a terminal.
The load-bearing differences a developer sees: **`@-tab`** pulls the live DOM
of a logged-in app into a turn; the **Ralph loop's backpressure gates** read
the page console/DOM in-process (not via an external browser MCP); **WebVM is
the shell** for lint/test/build; memory and `/init` are keyed by the
**browsing context**, not a file tree; and the whole thing keeps peerd's
security spine — deny-all egress through an allowlist (now also expressed *as*
a default hook), and a mandatory user-confirmation gate on every persistent
memory write.

What a developer does on first run: unlock the vault, paste an Anthropic or
OpenRouter key, and they have a Plan/Act selector + a live cost meter in the
top bar, `/logs` `/skills` `/ralph` routes, an `/init` that drafts an
AGENTS.md from the workspace + active tab, slash commands and `@-tab`/`@-file`
in the composer, checkpoint/undo on App edits, a `remember` tool that always
asks before persisting, and a `/review` that spawns a read-only second
opinion. Every tool call still passes the six gates + the new pre/post hooks.

---

## Per feature

### 01 — File-based memory + `/init`
File-based AGENTS.md memory with hierarchical scope (user → project → subtree),
loaded into the system prompt under a `<200`-line budget (`{{MEMORY_BLOCK}}`),
plus an `/init` that scans the workspace and drafts an initial AGENTS.md and a
feature checklist. **Code:** `peerd-runtime/memory/{memory,initializer,store,index}.js`,
tools `tools/defs/{remember,read-memory}.js`, SW wiring + `memory/*` routes,
`{{MEMORY_BLOCK}}` in `loop/system-prompt.js`. **Browser-native:** "project" is
keyed by the **active tab origin**; `/init` reads the live page (`chrome.scripting`)
+ Apps + a WebVM FS listing. **Interactions:** foundational — it is also the
authoritative implementation of feature **09** (see Integration Log). Skills
(07) and the review/Ralph features sit alongside it. **Limits (V1.x):** no
dedicated Settings memory-editor UI yet (export/delete routes exist).

### 02 — Search/replace edits + checkpoint/undo
Aider-style SEARCH/REPLACE blocks as the primary agent write path (`edit_file`
tool), plus content-addressed per-turn workspace snapshots with `/checkpoint`
and `/undo`. **Code:** `peerd-runtime/edit/{search-replace,snapshot-store,checkpoint,errors,permissions-adapter}.js`,
`tools/defs/edit-file.js`, `sidepanel/components/checkpoints-bar.js`, SW
`edit/*` routes + post-turn auto-snapshot. **Browser-native:** the "workspace"
is an App's OPFS subtree (`app:<id>` scopes), snapshotted directly in the SW
(no tab spawn); checkpoints live in a dedicated `peerd-checkpoints` IDB.
**Interactions:** writes route through 03's permission policy; 08 reviews its
diffs. **Limits:** sandbox/WebVM snapshots are a documented V1.x gap (the
manager already accepts any scope).

### 03 — Plan/Act + permission tiers
PLAN (read-only) vs ACT, and within ACT three tiers — SUGGEST / AUTO-EDIT /
FULL-AUTO — mid-session switchable, always visible. **Code:**
`peerd-runtime/permissions/{policy,index}.js` (pure `decideAction`),
`tools/gates.js` (persona+confirmation gates now real), `tools/dispatcher.js`,
`sidepanel/components/mode-badge.js` (`ModeSelector`), SW `permission/set`.
**Browser-native:** Plan blocks not just file writes but side-effecting
DOM/tab actions (click/type/navigate/page_exec) and side-effecting fetch,
classifying each tool by its existing `sideEffect`+`primitive`. **Interactions:**
foundational write-authorization; 02/05/08 and the memory write all consult it.
It **subsumes** the old `confirmActionsEnabled` toggle via a one-time migration.

### 04 — Slash commands + @-references + `@-tab`
`/command` resolution from a `.peerd/commands/` store, `@-file` inlining, and
the star feature **`@-tab`** — inlining the live DOM/URL/visible text of an
open tab under the user's session — with a keyboard-first command palette.
**Code:** `peerd-runtime/composer/*`, `sidepanel/components/command-palette.js`
+ `input-bar.js` wiring, SW `commands/*` + `composer/*` routes + `applyComposer`
in `agent/send`. **Browser-native:** `@-tab` is the whole point; it reuses
`read_page`'s `<untrusted_web_content>` wrap + denylist origin gate (run
before AND after capture, redirect-safe). **Interactions:** command sources
can merge with 07's skills (adapter present; wiring noted as a follow-up).

### 05 — Ralph persistent loop
A loop that spawns fresh-context iterations against a plan file: read plan →
pick one task → do it (a clean-session subagent) → run backpressure gates →
commit → discard context. Planning + building modes; survives SW restarts.
**Code:** `peerd-runtime/ralph/{plan-store,gates,loop,index}.js`, the **`/loop <goal>`**
chat command (SW-handled, like `/init`), SW loop wiring + budgeted `driveRalph`
bursts. (Post-review: the dedicated `/ralph` panel/nav was removed in favor of
the simple in-chat command; `ralph-view.js` is now unused.) **Browser-native (the differentiator):**
gates include WebVM lint/test/build **and** in-process `console-clean` /
`dom-contains` checks via peerd's own `read_page`/`page_exec` — no external
MCP. **Interactions:** sits on 01 (plan persistence), 02 (commit), 03
(full-auto tier), 10 (gates); thin adapters at the SW binding. **Limits:**
console-error extraction is a heuristic until a structured console tool exists.

### 06 — BYOK cost/usage telemetry
Live per-turn token + dollar cost, a running session total, and an optional
hard spend limit that halts the agent — 100% local. **Code:**
`peerd-provider/{pricing.js, format/from-anthropic.js, from-openai.js,
to-openai.js}` (usage events from the SSE streams), `peerd-runtime/cost/accumulator.js`,
`sidepanel/components/cost-meter.js`, SW accumulation + halt via the existing
AbortController. **Browser-native:** an always-visible meter under the top bar
while the agent works. **No telemetry:** dollar math runs client-side off an
in-code, user-overridable pricing table; nothing phones home. **Limits:**
subagent cost doesn't roll into the parent total yet.

### 07 — Progressive-disclosure skills (SKILL.md)
Agent-Skills standard: only skill **descriptions** load at startup
(`{{SKILLS_BLOCK}}`); the full SKILL.md **body** injects on invocation via a
`load_skill` tool. Installable from local dir / git URL / static manifest.
**Code:** `peerd-runtime/skills/{parse,store,registry,install,load-skill-tool,index}.js`,
`sidepanel/components/skills-view.js` (`/skills`), SW `skills/*` routes.
**Security:** git/manifest fetches go through egress-gated `webFetch` only;
unknown frontmatter is never interpreted as behaviour; `allowed-tools` is
advisory. Compatible with Claude Code / Codex / Gemini skill files.
**Interactions:** uses its own IDB store (the 01 storage adapter is a
documented one-line repoint).

### 08 — Clean-context review subagent
A second agent instance with **no shared context** that reviews a diff and
returns a structured summary (verdict / severity / issues / fixes), built on
peerd's existing `spawn.js` — the reviewer is a clean-session child narrowed
to **read-only** tools (enforced two ways, fail-closed), so the writer stays
the single writer. **Code:** `peerd-runtime/review/*`, `tools/defs/request-review.js`,
SW `review/run` + `/review`. **Browser-native:** the reviewer can open the
changed App and inspect its DOM/console (available via the read-only toolset).
**Interactions:** consumes 02's diffs + 03's read-only tool set (adapters
in place).

### 09 — Auto-memory with explicit user review
**Delivered by feature 01.** The spec — agent proposes a memory write, a UI
confirmation shows the change before persistence, accept appends / reject
discards, loads alongside AGENTS.md — is implemented by 01's confirm-gated
`remember` tool + the memory-diff `ConfirmModal` (the `isMemory` branch in
`app.js`) + `{{MEMORY_BLOCK}}`. The standalone `feature/09-automem` branch
(its own `peerd-runtime/memory/` module) was reconciled into 01 per brief §6
(foundational owns the interface) rather than landed as a duplicate. See the
Integration Log. **The no-silent-write guarantee is live.**

### 10 — Hooks (pre/post-tool-use)
Lifecycle hooks in the dispatcher: `pre-tool-use` (can BLOCK or MODIFY a call;
runs after the sync gates + async confirmation, before `execute()`) and
`post-tool-use` (observes). Hook errors **fail closed**. **Code:**
`peerd-runtime/tools/hooks/*` (runner/registry/compile + `defaults/`),
dispatcher integration, SW `hooks/*` routes. **Dogfooded:** the egress
allowlist ships as a default `egress-allowlist` pre-tool-use hook (the
requested model); a `active-tab-guard` default is the browser-native example.
**Interactions:** foundational — 03/05 and user config can register hooks.
**Limits:** no settings UI for user hooks yet (routes are in place);
post-hook veto deferred.

---

## Cross-cutting compliance (every feature)
- **No MCP.** Tabs / safeFetch|webFetch / WebVM / WebRTC throughout.
- **Single-threaded writes.** The edit path (02) is the single write
  mechanism; the reviewer (08) and Ralph iterations are read-only / one-writer.
- **Lethal-trifecta defense intact.** Egress allowlist preserved (and now a
  default hook); memory writes gated on explicit user confirmation,
  fail-closed; WebVM sandbox boundary untouched.
- **Lean memory** (<200-line budget), **MV3-safe** (IDB/storage persistence,
  budgeted Ralph bursts), **no telemetry**, **reversibility** (export/delete
  for memory, checkpoints, skills, hooks), **a11y + reduced-motion** on new UI.
