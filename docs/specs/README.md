# docs/specs/

> The single home for **feature specs and their design records** — the
> forward-looking designs for things not yet built (or only partly built),
> the landed records of features that shipped from a spec, and the research
> notes that fed them. The rest of `docs/` records shipped behavior; this
> dir carries the *why* and the *what-next*.

A spec lands here when a feature has a clear enough shape to write down
but hasn't been built. When it ships, the spec stays as the design
record (cross-linked from `ROADMAP.md` and, for the catalog of shipped
features, `FEATURES.md`) — specs are not deleted on landing, they become
history.

> Two design records live at the **repo root**, not here: `DESIGN.md`
> (the central technical design record, the anchor of `CLAUDE.md`'s
> reading order) and the architecture docs. Everything spec-shaped is
> here.

House shape for a spec (loose, not enforced):

- A `>` blockquote header: one-line what-it-is, the date/status, and
  lineage (what it supersedes / sits beside).
- **Summary** — the thesis in a paragraph. What we're building and the
  one idea that makes it simple.
- **Non-goals / scope** — say what this is *not*, early. Specs rot when
  scope creeps silently.
- **Model**, **UX**, **state**, **security** — as the feature needs.
- **Open questions** — the decisions deliberately deferred.

## Index

Grouped by workstream; status in parentheses. *Landed record* = shipped,
kept as the design history.

### Agent runtime designs

- **`DESIGN-11-async-subagents.md`** *(landed record — Phase 1, 2026-06-16)* —
  non-blocking delegation: a spawn returns a handle and the result
  re-enters the parent as a synthetic wake turn. Durable (survive-restart)
  variant is the scheduled-tasks appendix below.
- **`DESIGN-13-memory-v2.md`** *(planned)* — addressable memory entries,
  batch ops, and recall at scale.
- **`DESIGN-14-workflows.md`** *(planned)* — "workflows" = **recipe
  capture**: save one successful task path as a replayable `/command`.
- **`DESIGN-16-dynamic-workflows.md`** *(planned)* — "dynamic workflows" =
  **orchestration at scale**: the plan expressed in code, fanning out
  subagents. (§2 disambiguates this from DESIGN-14 — two unrelated things
  both called "workflow.")
- **`DESIGN-15-local-bridge.md`** *(planned)* — a subscription transport
  (ACP) and the MCP question for a local bridge.

### Scheduling & proactivity

- **`FEATURE-SCHEDULED-TASKS.md`** *(planned)* — durable timers, waits, and
  resumable unattended work via `chrome.alarms`. Absorbs and supersedes
  the original DESIGN-08 schedule design (now its appendix).
- **`FEATURE-SMART-NUDGES.md`** *(planned)* — opt-in reactive cards, not
  surveillance; depends on Scheduled Tasks.

### Persistence, sharing & export

- **`DESIGN-10-export.md`** *(landed record)* — the one `.peerd` bundle
  format under shares, publishing, and dwapps (content-addressed chunks
  + signed manifest, via `/shared/bundle`).
- **`FEATURE-APP-PERSISTENCE-DWAPPS.md`** *(partial)* — instances survive
  restart (Phase-1 storage + dwapp step shipped; Library landed in the
  home SPA). Remaining: content-addressing-on-save, IDB content tier,
  share-time signing.
- **`FEATURE-GIT-VERSIONING-DWAPPS.md`** *(planned)* — a version-history
  layer beneath app persistence. Read `FEATURE-APP-PERSISTENCE-DWAPPS.md`
  first.

### Context compression

- **`RESEARCH-HERMES-COMPRESSION.md`** *(landed record)* — the research
  spike; four trim/summary adoptions shipped, plus the lineage axis.
- **`DESIGN-LINEAGE-COMPRESSION.md`** *(landed record)* — fleshes out §5
  of the Hermes doc; lineage-based body compaction shipped
  (`peerd-runtime/loop/lineage-compaction.js`).

### Local inference

- **`FEATURE-LOCAL-WEBGPU.md`** *(landed record, opt-in)* — Gemma-4-E2B
  on-device WebGPU behind an opt-in download; broader model support
  staged. (The §4 "remove Ollama" decision was reversed — both ship.)

### Remote control

- **`PHONE-REMOTE-CONTROL.md`** *(planned)* — driving the browser agent
  from a phone, as a remote view + command inlet over a direct sealed
  channel. The phone is a remote `uiPort`, not a peer; the desktop is the
  single authoritative writer.

### Prompt text & research notes

- **`SYSTEM-PROMPT-LESSONS.md`** *(partial)* — system-prompt lessons; some
  adopted, some not.
- **`TOOL-INVENTORY-COMPARISON.md`** *(research)* — tool-surface gap
  analysis vs other agents.
- **`RESEARCH-NOTES.md`** *(research)* — provenance / clean-room license
  record for the BrowserOS-learning cluster (scheduled tasks, nudges,
  tool inventory, prompt lessons).
