# Feature 08 — Clean-context review subagent (DESIGN)

> A SECOND agent instance with NO shared context that reviews the writer's
> diff and returns a STRUCTURED summary the parent incorporates.
> References: Cognition's *clean-context review*; Amp's *oracle*.

## The thesis

The agent that wrote a change is the worst reviewer of it: it carries the
rationalizations that produced the bug. A reviewer with a **clean context**
— it sees the diff and nothing of the conversation — is a genuine fresh
pair of eyes. We spawn that reviewer through peerd's existing subagent
machinery, scope it **read-only**, and require it to emit a **structured
summary** the parent can act on programmatically.

Three properties, each mapped to a mechanism we already have:

| Property | Mechanism |
|---|---|
| Clean context | `spawnSubagent({ task })` already creates a FRESH child session whose only input is `task`. The reviewer never sees the parent's messages — clean context for free. |
| Read-only | `spawnSubagent({ tools: readOnlyToolNames(...) })` narrows the reviewer to read-classified tools (what it SEES); `reviewerToolGuard` fails non-read calls closed (what it can DO). |
| Structured | The reviewer prompt mandates one fenced ```json block; `parseReviewSummary` extracts + validates it into `{verdict, severity, issues[]}`. |

## Reusing spawn.js (NOT a new orchestrator)

`makeRequestReview` is a thin imperative shell over the SAME bound
`spawnSubagent` the SW already wires from `makeSpawnSubagent`. We do not
duplicate the loop, the session store, the gates, the audit, or the trust
inheritance. We call `spawnSubagent` with:

- `task` = the rendered diff + cross-cutting checklist + output schema.
- `tools` = the read-only subset (spawn's `narrowTools` intersects it with
  the registry; an empty intersection = pure-reasoning reviewer).
- `allowRecursion: false` — a reviewer that could spawn its own children
  would escape the read-only contract. `spawn_subagent` is never in the
  read-only set anyway; this is explicit belt-and-suspenders.

Everything else (depth+1, maxDepth refusal, parent permissions, provider
key, parentage-tagged audit, live nested-transcript forwarding to the side
panel) is inherited from the spawn machinery unchanged.

## Structured-summary schema

```json
{
  "verdict": "approve | request_changes | comment",
  "severity": "critical | high | medium | low | info",   // worst issue
  "summary": "one paragraph, plain English",
  "issues": [
    { "severity": "...", "title": "...", "detail": "...",
      "location": "file:line", "fix": "suggested change" }
  ]
}
```

`parseReviewSummary` (schema.js) is tolerant by design — a clean-context
reviewer is still an LLM, and a malformed block must never crash the
parent's turn:

- extracts the **last** fenced ```json block (a reasoning model often shows
  a scratch block first; the last is the committed one). Falls back to bare
  `{…}` braces, then to a well-formed fallback summary flagging the parse
  failure as a single `info` issue.
- **derives** `severity` from the worst issue rather than trusting the
  model's self-report → verdict/severity stay coherent.
- **overrides** an over-optimistic `approve` to `request_changes` when any
  high+ issue exists → never silently approve a critical finding.

## Read-only enforcement (the CRITICAL constraint)

Single-threaded writes: only the writer edits. Enforced in two layers
(read-only.js):

1. **What the reviewer SEES** — `readOnlyToolNames(descriptors)` keeps only
   tools whose descriptor declares `sideEffect: 'read'`, minus an
   always-denied list (`spawn_subagent`, `request_review`). This is the
   allowlist passed to `spawnSubagent({ tools })`. No `click`, `type`,
   `navigate`, `page_exec`, `app_write_file`, `submit_form`, VM/JS write
   tools — none are read-classified, so none reach the reviewer.
2. **What the reviewer can DO** — `reviewerToolGuard` (orchestrator.js)
   wraps dispatch and refuses any non-read call at call time. Catches the
   edge case where a tool's `sideEffect` is mis-declared OR re-tagged after
   the subset was computed. Fails closed on unknown tool names. The spawn
   machinery's own subset narrowing already blocks ungranted tools; this is
   defense in depth.

This is also a **lethal-trifecta** defense: the reviewer reads the diff
(potentially untrusted content the writer pulled from the web), so it must
not simultaneously hold a mutation/exfiltration channel. Read-only removes
the third leg. The diff itself is wrapped in `<diff>…</diff>` with a
standing instruction to treat its contents as data, never instructions.

## Cross-cutting checklist (prompt.js)

The reviewer prompt is peerd-specific and load-bearing — a generic "review
this" misses the harness's real failure modes. The checklist maps 1:1 to
the hard constraints: correctness; lethal-trifecta / bare-fetch / plaintext
secrets; reversibility; MV3 SW 30s budget; a11y + reduced-motion; no
telemetry; conventions (ES modules, index.js API, injected IO, // why:
comments); lean memory; test coverage.

## Browser-native angle

The reviewer's read-only toolset includes peerd's browser-native read tools
(`read_page`, `query_dom`, `inspect_*`, `app_read_file`). For an App change,
the reviewer isn't limited to static diff reading — it can open the changed
App in its sandboxed iframe and inspect the rendered DOM / console of the
running result, the same way a human reviewer would click through. This is
the peerd differentiator a terminal harness can't match: review against the
**running** artifact, not just the text.

## Adapters for features 02 + 03

Both build in parallel; we assume clean interfaces and define thin adapters
(diff.js, read-only.js) so feature 08 works standalone today.

- **Feature 02 (search/replace edits + checkpoints)** — source of the diff.
  `checkpoints.diffSince(ref)` → a changeset. `fromCheckpointDiff(raw)`
  normalizes it into our `{files:[{path,status,before,after}]}` shape
  (tolerant of minor interface drift). Standalone path when 02 isn't wired:
  `synthesizeDiff(before, after)` compares two App/sandbox file-tree
  snapshots ourselves — pass `before`/`after` to `request_review`.
- **Feature 03 (plan/act permissions)** — source of the read-only set.
  `permissions.readOnlyTools()` → a name set. `intersectReadOnly(local,
  external)` intersects it with our local `sideEffect:'read'` floor
  (intersection, not union — neither gate can widen the other). When 03 is
  unbound, the local floor stands alone.

The integrator binds `checkpoints` / `permissions` in `makeRequestReview`
at the SW call site (currently commented placeholders). Until then the
reviewer works on explicit snapshots/diffs — fully functional.

## Surfaces

- **`request_review` tool** (defs/request-review.js) — the model decides to
  review after a non-trivial change. Returns the structured summary
  formatted for the model to incorporate.
- **`review/run` SW route** — the `/review` command + sandbox
  `peerd.review()` shim. Same orchestrator, direct invocation.

## What's NOT here (V1.x gaps)

- Auto-trigger of review at turn end (a policy decision left to the parent).
- Applying fixes automatically (the parent's writer does that; we only
  report).
- A dedicated side-panel review-card component (reuses the nested
  subagent-transcript rendering; a richer issues table is V1.x UI work).
- Multi-reviewer ensemble / disagreement resolution (Amp oracle V2 shape).
