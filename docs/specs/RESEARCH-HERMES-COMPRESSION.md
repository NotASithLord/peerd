# RESEARCH SPIKE — Hermes context compression, applied to peerd

> **Status:** research spike (no code changes). Maps the Hermes Agent
> context-compression design onto peerd's existing trim/rolling-summary
> stack, then recommends what's worth adopting and what peerd already does
> better. Feeds the `ROADMAP.md` backlog item *"Lineage-based context
> compression for very long sessions."*
>
> **Provenance:** built from PUBLIC descriptions only — Nous Research's
> Hermes Agent docs/wiki, a public GitHub issue (`NousResearch/hermes-agent#499`),
> and third-party write-ups. No Hermes source was copied; this doc is
> behavioral description + peerd-native advice. Hermes is Apache-2.0
> (no copyleft concern), but the no-source-in-deliverable posture from
> `RESEARCH-NOTES.md` is honored anyway.

---

## 0. Implementation status (this PR)

The spike's first four adoptions are now **implemented** on this branch
(the dynamic context-window trigger was the headline ask):

- **Context windows are model-accurate + provider-sourced** ✅ — the static
  table reflects reality (current Opus 4.6/4.7/4.8 and Sonnet 4.6 are **1M by
  default**, same id, no beta header; Haiku 4.5 is 200K), and the
  **authoritative** window is the provider's own value: Anthropic's Models
  API reports `max_input_tokens` per id (GA 2026-03), OpenRouter's
  `/models` reports `context_length`, Ollama's `/api/show` reports the
  configured `num_ctx` (the *usable* window, preferred over the model's
  max), and the **local WebGPU** runner reports its window through the same
  seam — canonical value in `MODEL_SPECS`, with a `setLocalModelInfo` hook
  so the offscreen engine can report the resident model's real config when
  it matures (future-proofed; nascent today). All providers — cloud and
  on-device — flow through one `providerModelContextWindow` dispatch and
  `resolveContextWindow`'s `live` input (cached 6h, fetched non-blocking so
  it never adds turn latency). Resolution order: **user override > live
  provider value > static table > unknown** (unknown ⇒ message-count
  backstop only).
- **Dynamic token trigger** ✅ — `peerd-provider/context-window.js` resolves
  each model's window (override > live > static table > unknown);
  `peerd-runtime/loop/estimate.js` is the char/4 prompt estimator;
  `planTrim` fires when the estimate crosses `TRIGGER_FRACTION` (0.75) of
  the active model's window and cuts down to `TARGET_FRACTION` (0.55), with
  a `MIN_KEEP_RECENT` floor. The SW resolves the window from `session.model`
  and threads it through `runUserTurn`. Unknown windows fall back to the
  original message-count backstop — fully backward compatible.
- **Pin the task verbatim** ✅ — `foldDropped` captures the first real user
  message once (`state.task`); `renderSummaryText` always emits a `Goal:`
  line (model goal when enriched, the verbatim task as the floor).
- **Richer template** ✅ — enrichment schema gains `goal` + `artifacts`
  (handles: tab ids, sandbox handles, file paths, URLs); rendered as an
  `Artifacts / handles` section that's dropped *last* under the size cap.
- **Handoff framing** ✅ — `buildSummarizationTask` is reframed as a
  resume-handoff (Codex/Hermes lesson).

Now **shipped** too: **compress along lineage** (§5). The dispatcher
stamps each tool result with its lineage spine, so old verbose bodies are
shrunk to that spine (what tool ran, on what primitive, touching what
origin, with what outcome) before the rolling summary even fires. The pure
core is `peerd-runtime/loop/lineage-compaction.js`, wired into the agent
loop ahead of `planTrim`; the full design record is
[`DESIGN-LINEAGE-COMPRESSION.md`](./DESIGN-LINEAGE-COMPRESSION.md).

The numbers (`TRIGGER_FRACTION`/`TARGET_FRACTION`, the window table) are
tunable constants; see §4.1 for the cache-cost reasoning behind the deep
cut.

## 1. TL;DR

peerd already has a real, well-factored context-compression system
(`peerd-runtime/loop/trim.js` + `rolling-summary.js` +
`summary-enrichment.js`): a sliding window that collapses old turns into a
single rolling summary, with a deterministic mechanical fold and an
optional cheap-model enrichment. Architecturally it's in the same family
as Hermes and in several ways **cleaner** (functional core, never blocks
the turn, lossless at rest, cache-friendlier summary placement).

The gaps worth closing are concrete and small:

1. **Trigger on tokens, not message count** *(highest value)* — peerd
   trims at `>60 messages`; Hermes trims at a **% of the model's context
   window**. A browser agent's messages vary 100× in size (a DOM snapshot
   vs. "ok"), so message count is a poor proxy for the thing peerd's own
   code comment says it's protecting (the context/rate-limit budget).
2. **Pin the task + recent user intent verbatim** — peerd folds *all* old
   turns (including the first user message — the actual task) into counts +
   model-derived facts. Hermes keeps the head turns intact and is moving to
   preserve user messages up to a token budget. Pin message[0] and recent
   user text deterministically.
3. **Richer summary template** — add a `goal` anchor and an
   `artifacts/handles` section (open tabs, sandbox/Notebook/App handles,
   edited files, key URLs). This is peerd-specific and load-bearing:
   handles that don't survive compaction strand the agent.
4. **Handoff framing** — reframe the enrichment prompt from "you are a
   summariser" to "write a handoff for the LLM that will resume this task"
   (the Codex/Hermes lesson). Pure prompt change.

Everything below expands these.

---

## 2. What Hermes does (behavioral summary)

Hermes treats compression as a **transcript-rewrite with invariants**, not
"summarize when long":

- **Two independent layers, token-budget triggered.**
  - *Agent `ContextCompressor`* — fires at **~50%** of context window; the
    normal, proactive management path.
  - *Gateway "Session Hygiene"* — fires at **~85%**; a safety net for when
    a single turn balloons past the proactive layer.
- **Head / middle / tail partitioning.** Keep the system prompt and the
  **first few turns** intact (task framing), protect the **recent tail**,
  and **summarize the middle** — the most compressible region.
- **Cheap model summarizer.** A small/fast model (Gemini Flash) produces
  the summary; the result is injected with a `[CONTEXT SUMMARY]:` marker.
- **Structured, incremental template.** The summary is structured —
  **Goal / Progress / Decisions / Files / Next Steps** — and each
  subsequent compaction **updates the prior summary** rather than starting
  over.
- **Prompt caching** to amortize the cost of the repeated (stable) prefix.

**Direction of travel** (public issue #499, "compaction quality overhaul,"
Codex-CLI-inspired):

- **Handoff-oriented prompt** — frame summarization as "a handoff summary
  for another LLM that will resume the task" (progress, constraints, next
  steps, critical data) instead of generic summarization.
- **Semantic preservation of user messages** — keep *all* user messages up
  to a token budget (~20K) instead of positional "first 3 / last 4."
- **System-context refresh** — rebuild the system prompt fresh instead of
  appending notes; add degradation warnings after repeated compactions;
  detect model switches and pre-compact.

A separate community plugin, `hermes-lcm`, takes the lossless extreme: a
**DAG-based** context engine that never drops a message and can restore
specific branches.

---

## 3. What peerd already does

| Concern | peerd today |
|---|---|
| Trigger | **Message count**: `planTrim` is a no-op until `messages.length > softCap` (60); keeps `keepRecent` (20) newest verbatim (`trim.js`). |
| Partitioning | **Tail-only**: keep the newest N, collapse everything older into ONE synthesized summary message. No explicit head preservation. |
| Tool-boundary safety | Snaps the cut backward so the kept window never opens on an orphaned `tool_result` (provider 400 guard) — a correctness invariant Hermes write-ups don't mention. |
| Summary content | **Two layers** (`rolling-summary.js`): a deterministic *mechanical fold* (message/tool counts, per-tool tallies) always present, plus an *optional model enrichment* adding `facts` / `decisions` / `threads`. |
| Incremental | **Rolling**: state persists on `session.trimSummary`; each trim folds new drops onto the prior state; enrichment **replaces** structured sections so stale threads age out. Drift-anchored (`coveredLastId`) with refold-from-scratch on mismatch. |
| Never blocks | Enrichment is queue-then-drain **after** the turn, fire-and-forget; failure degrades to the mechanical summary (`summary-enrichment.js`). |
| Losslessness | **Lossless at rest** — full history stays in session storage; only what's *sent* is trimmed. `/undo` and the session view see the real thing. |
| Summary placement | Injected as a tagged **synthetic user message** (`<conversation_trim_summary>`), not appended to the system prompt. |

So peerd's spine — rolling, incremental, structured, cheap-model-enriched,
non-blocking — already matches Hermes's spine. The differences are in the
*trigger*, the *partition*, and the *template*.

---

## 4. Gap analysis & recommendations

Ordered by value ÷ effort.

### 4.1 Trigger on token budget, not message count  ★ do this first
peerd's own `trim.js` comment says the point is sessions "long enough that
the cached prefix outgrows the context window or rate-limit budget" — yet
it measures **messages**. One `get`/page-snapshot tool result can be tens
of thousands of tokens; sixty "ok"s are nothing. The proxy is wrong in
both directions.

- **Recommendation:** trigger `planTrim` when the estimated prompt tokens
  exceed a fraction of the active model's context window (Hermes's ~50%),
  with the message-count `softCap` kept only as a coarse floor. peerd
  already meters tokens per turn (CostChip / cost telemetry) and knows the
  model — reuse that estimate; no new dependency.
- **Hysteresis matters (cache cost):** every trim **busts the prompt
  cache** (the cached prefix changes), so the next turn is a full cache
  miss. Trim should fire *infrequently* — when it fires, cut down to a
  budget well below the trigger (the existing `keepRecent`≪`softCap` gap is
  the right instinct; preserve it in token terms) so it doesn't re-fire
  every subsequent turn.
- **Dual layer is optional.** Hermes's 85% safety net exists for runaway
  single turns. peerd already targets that case more surgically with
  `redactToolResult` + `stripAttachments` (shrinking the *bulk*, not the
  *history*). Keep those as the first line; a single token-based trigger is
  probably enough without porting Hermes's second layer.

### 4.2 Pin the task and recent user intent verbatim  ★ high value
peerd folds **all** old turns — including message[0], the original task —
into counts plus whatever the model enrichment happened to capture. If
enrichment was skipped (spend limit), failed, or parsed badly, the task
statement itself can vanish into "47 user messages elided." Hermes keeps
head turns intact and is explicitly moving to preserve user messages by
token budget because **user intent is the highest-signal content**.

- **Recommendation A (deterministic, cheap):** in `planTrim`, always keep
  the **first user message** verbatim (head preservation), independent of
  the rolling summary. The task framing should never be lossy.
- **Recommendation B:** when folding, carry **dropped user-message text**
  (bounded by a token budget) into the rendered summary, not just the
  count. `digestMessages` already extracts this for the enrichment call —
  surface a trimmed version in `renderSummaryText` so user intent survives
  even when enrichment doesn't run. Keeps the "lossy-older" trade for
  *tool* bulk while making *user turns* near-lossless.

### 4.3 Richer, peerd-native summary template  ★ high value
peerd captures `facts / decisions / threads`. Hermes adds **Goal** and
**Files**. For a browser+sandbox agent the "Files" slot is the important
one, and it's broader than files:

- **Add `goal`** — a single durable line for the task objective (pairs with
  4.2A). Gives the model an anchor every turn instead of inferring it.
- **Add `artifacts` / `handles`** — the live references the agent must not
  lose across a compaction: **open tab ids, WebVM / Notebook / App sandbox
  handles, edited file paths, key URLs**. peerd is *more* exposed here than
  Hermes: a stranded sandbox handle isn't just lost context, it's a broken
  capability. This is the single most peerd-specific addition.
- Mechanics already support it: extend `TrimSummaryState`, `cleanList`
  handling, the enrichment JSON schema, and `renderSummaryText`'s sections.
  Same caps/aging apply.

### 4.4 Handoff framing for the enrichment prompt  ★ cheap win
`buildSummarizationTask` opens with "You are a conversation summariser."
The Codex/Hermes finding is that **handoff framing** measurably improves
resume quality: "Produce a handoff for another agent that will resume this
task — what's the goal, what's done, what's decided, what's pending, and
exactly what it needs to continue." Pure prompt change in
`rolling-summary.js`; no structural risk.

### 4.5 Lower-priority / explicitly skip
- **Summary placement** — Hermes appends `[CONTEXT SUMMARY]:` to the
  *system prompt*; peerd injects a tagged synthetic *user* message. peerd's
  choice is **better for prompt caching** (the system block stays stable).
  Keep peerd's approach.
- **System-prompt rebuild / model-switch pre-compaction** — interesting but
  premature; peerd's system prompt is generated cleanly per turn already. A
  small "compacted N×" degradation hint in the summary is a cheap nod to
  Hermes's degradation warning if quality regressions show up.
- **`hermes-lcm` DAG / lossless** — peerd is *already* lossless at rest
  (full history in session storage), so the DAG's headline property is
  covered. The genuinely interesting future angle is a side-panel
  "expand this elided section" affordance, which maps to peerd's existing
  checkpoints / `diffSince` rather than a new engine.

---

## 5. The peerd-only angle: compress *along lineage*

The ROADMAP item is "**lineage**-based context compression," and that's a
lever Hermes doesn't have. peerd's six-gate dispatcher attaches full
lineage (`persona → exposure → origin → confirmation → egress → audit`) to
every tool result. That gives a *structured axis* to compress along that's
better than head/middle/tail:

- **Tool-result bodies are the bulk and the most compressible** — the
  lineage/audit spine (what tool ran, on what origin, with what outcome)
  can be retained while the verbose body is dropped or pointer-ized, keyed
  by audit id. The agent keeps a faithful record of *what happened* and can
  re-fetch a body if it genuinely needs it.
- This composes with §4: trigger on tokens (§4.1), keep user turns +
  goal + handles (§4.2/4.3), and within the elided middle, **collapse by
  lineage** rather than by position. That's the spike's north star and
  cleanly extends the existing `foldDropped` mechanical layer.

---

## 6. Suggested sequencing

1. **Token-budget trigger + hysteresis** (§4.1) — biggest correctness win,
   contained change to `planTrim`'s gate; reuses existing token metering.
2. **Pin task + carry user-message text** (§4.2) — deterministic, no model
   dependency; makes the lossy path safe.
3. **`goal` + `artifacts/handles` template fields** (§4.3) + **handoff
   prompt** (§4.4) — one coherent change to the enrichment schema/prompt.
4. **Lineage-aware folding of tool bodies** (§5) — the larger, peerd-native
   design. **Shipped** as `peerd-runtime/loop/lineage-compaction.js`,
   running ahead of `planTrim`; design record in
   [`DESIGN-LINEAGE-COMPRESSION.md`](./DESIGN-LINEAGE-COMPRESSION.md).

All four stay inside the existing functional core (`trim.js` /
`rolling-summary.js` pure; IO injected in `summary-enrichment.js`) and the
"never block the turn" guarantee. None requires a build step or new vendor.

---

## 7. Sources

- [Context Compression — NousResearch/hermes-agent (DeepWiki)](https://deepwiki.com/NousResearch/hermes-agent/10.1-context-compression)
- [Context Compression and Caching — Hermes Agent docs](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)
- [Issue #499 — Context Compaction Quality Overhaul (Codex-inspired)](https://github.com/NousResearch/hermes-agent/issues/499)
- [Chapter 6: Context Management at Scale (Claude Code vs. Hermes)](https://kenhuangus.substack.com/p/chapter-6-context-management-at-scale)
- [Context Compression in AI Agents: Hermes vs. Claude Code (mem0)](https://mem0.ai/blog/how-hermes-and-claude-handle-context-compression-in-real-production-agents-(and-what-you-should-extract))
- [Designing Context Compression for Production Agents: Hermes deep dive](https://akjamie.github.io/post/2026-05-24-context-compressor-deep-dive/)
- [stephenschoettler/hermes-lcm — Lossless (DAG) Context Management](https://github.com/stephenschoettler/hermes-lcm)
