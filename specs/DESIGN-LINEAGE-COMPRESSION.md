# DESIGN — lineage-based context compression

> **Status:** IMPLEMENTED on this branch (phases 1–4 of §11). Dispatcher
> stamps `meta.sideEffect` + `meta.origins`; the pure core is
> `peerd-runtime/loop/lineage-compaction.js` (`renderLineageLine`,
> `defaultClassify`, `planBodyCompaction`); wired in `agent-loop.js` before
> `planTrim`. No body store, no re-expansion tool (see §8). Fleshes out §5 of
> `specs/RESEARCH-HERMES-COMPRESSION.md` — the peerd-native compression axis
> that Hermes/Claude-Code don't have. Companion to the dynamic-trigger work
> already shipped on this branch. Feeds the `ROADMAP.md` item *"lineage-based
> context compression for very long sessions."*

---

## 1. The idea in one paragraph

In a long agentic session, the **bulk** of the prompt is **tool-result
bodies** — page snapshots, command stdout, search results. Hermes and Claude
Code compress by *position* (keep head + tail, summarize the middle) or by
*summarization* (a model rewrites the middle into prose). peerd has a third
axis nothing else has: every tool result already carries its **dispatcher
lineage** — what tool ran, on what primitive, touching what origins, through
which gates, with what outcome. So instead of dropping or summarizing old
results, peerd **replaces each verbose body with its lineage spine**. The
result is *deterministic* (no model call, no hallucination),
*structure-preserving* (the tool_use/tool_result pairing stays intact), and
*lossy only in-context* — the full body still lives in at-rest session
history (`/undo`, the transcript view), so nothing is destroyed; it's just
no longer re-shipped to the model on every turn.

```
BEFORE (resident every turn):
  user[tool_result tool_use_id=tu_42]:
    "<full read_page of example.com/pricing — 7,900 chars of DOM text …>"

AFTER lineage compaction:
  user[tool_result tool_use_id=tu_42]:
    "‹elided› read_page · tab/example.com · ok · 7.9k chars"
```

The agent still knows *exactly what it did and where*. If it needs the
detail back, it **re-runs the tool** — which for stale web content is more
correct than expanding an old snapshot anyway. (An earlier draft added a
`get_tool_output` re-expansion tool + a body store; both were cut — see
§8. The classifier (§6) protects the results that are genuinely costly to
re-run.)

> **Scope (revised 2026-06-20):** 4 phases, **no body store, no new tool.**
> Compaction is a pure transform; recovery is "re-run the tool," with the
> classifier keeping costly/decision-bearing results uncompacted longest.

---

## 2. What already exists (so we build, not rebuild)

Three pieces are already in place — this design composes them, it doesn't
replace them:

| Piece | Where | What it gives us |
|---|---|---|
| **Lineage on every result** | `tools/dispatcher.js` attaches `meta` = `{ toolName, primitive, dispatch, gates[], hooks[], durationMs }` to every `ToolResult`. | The spine. `gates[]` is the six-gate chain (`persona → exposure → origin → confirmation → egress → audit`), each `{ name, allowed, reason }`. |
| **Lineage persisted on the block** | `agent-loop.js` builds each tool-result block as `{ tool_use_id, content, is_error, meta }` and stores it on `message.toolResults`. The format converter drops `meta` before the wire. | The lineage is **already in storage at zero token cost** — it just isn't *used* for compression yet. |
| **Destructive body redaction** | `loop/redact.js` (`redactToolResult`) strips `data:image` base64 → sentinel and truncates bodies to ~8000 chars *at persist time*. | Bodies are already bounded (~2k tokens each). Lineage compaction takes that 2k → ~30 tokens. |

**Implication:** my earlier framing ("the message shape doesn't carry
lineage") was too strong. It carries *most* of it. The real gaps are
narrow (next section).

---

## 3. The gaps (the actual "real schema change")

1. **Origin isn't on `meta`.** The dispatcher computes touched origins
   (`safeOrigins`) for the origin gate and the confirm prompt, but doesn't
   record them in `meta`. Origin is the most load-bearing spine field for a
   browser agent ("which site did this touch?"), so it must be captured.
   *One line in the dispatcher.*

That's the whole schema delta: **`meta.origins`.** Everything else is a
pure transform over the existing block shape. (No body store and no
re-expansion tool — those were considered and cut; see §8. The full body
already persists in at-rest session history, which is all the recovery the
human/UI path needs.)

---

## 4. Schema additions

### 4.1 `meta.origins`
```js
// dispatcher.js, in the `enriched`/blocked meta objects:
meta: {
  toolName, primitive, dispatch,
  origins: safeOrigins(tool, args, ctx),  // NEW — already computed nearby
  gates, hooks, durationMs,
}
```
Pure, additive, and it makes the persisted spine self-describing.

### 4.2 The block's compacted form
When a body is compacted, only its `content` changes — to the spine string
(§5); `tool_use_id`, `is_error`, and `meta` are untouched. No converter
change: `content` is still a string. Idempotence is detected by the
`‹elided›` content prefix (`isSpine`), so there is **no** `compacted`
marker field — an asymmetric flag on some result blocks but not others
would be forward-fragile for any future block-equality / cache-key logic.

**Note — no body store.** This rewrites the block that's *sent* to the
model; the unredacted/redacted body still lives in the at-rest session
record (the trim path already only changes what's sent, never what's
stored). So `/undo` and the transcript view are unaffected. There is
deliberately **no** side cache and **no** `get_tool_output` tool — recovery
into context is "re-run the tool" (see §8 for the why), and §6 keeps the
results that are costly to re-run uncompacted longest.

---

## 5. The pure core

Two pure functions, colocated with the trim core (`loop/`), IO injected —
same functional-core/imperative-shell split as `trim.js` / `rolling-summary.js`.

### 5.1 `renderLineageLine(block)` — deterministic spine
```
‹elided› {toolName} · {primitive}/{origin?} · {ok|error} · {bytes} chars
```
Examples:
```
‹elided› read_page · tab/example.com · ok · 7.9k chars
‹elided› call_api · web/api.stripe.com · error · 312 chars
‹elided› vm_exec · webvm · ok · 4.1k chars
```
Pure: block in, string out. No model. No network. (The agent recovers a
body, when it must, by re-running the named tool — so the line names the
tool and origin, not a fetch handle.)

### 5.2 `planBodyCompaction(messages, opts)` — the transform
```js
planBodyCompaction(messages, {
  keepBodiesRecent = 6,   // never touch the last N messages' bodies
  minBytes = 400,         // don't bother compacting tiny bodies
  classify,               // (block) => priority; lineage-ordered (§6)
  budgetTokens,           // optional: stop once estimate is under target
  estimateTokens,         // injected (estimate.js)
})
```
Walks tool-result blocks older than `keepBodiesRecent`. For each eligible
block (not already `compacted`, body ≥ `minBytes`), in **lineage-priority
order** (§6), replace `content` with `renderLineageLine(block)` and set
`compacted: true` — until `budgetTokens` is met (or all eligible are done).

Properties:
- **Structure-preserving** — never *drops* a block, only shrinks its
  content. The tool_use/tool_result pairing the provider 400s on is
  preserved *by construction* — no boundary-snap logic needed (unlike the
  summary collapse).
- **Monotonic / idempotent** — a `compacted` block is skipped; re-running is
  a no-op. One cache-invalidating transition per block, ever.
- **Pure** — returns new messages + a count of what it compacted (for audit
  / metrics). No side effects, no store.

---

## 6. "Lineage" is also the compaction *order*

The novel part isn't just *what spine we keep* — it's *what order we compact
in*, keyed by the dispatcher's `sideEffect` class and outcome:

| Class (from `meta` / tool) | Compact priority | Why |
|---|---|---|
| `read`, `ok`, **cheap** (low `durationMs`, re-fetchable origin) | **first** | A page snapshot the agent already acted on — re-running is fast and gets *fresher* data. |
| `read`, `error` | later | The *cause* of a failure is often needed to recover. |
| `read`, `ok`, **expensive** (high `durationMs`, e.g. a long `vm_exec` / `notebook` compute) | later | Cheap to *re-run* it isn't — this is the case that would otherwise hurt without a recovery tool, so the classifier protects it here instead. |
| `write` | later | Records a state change the agent may reference. |
| `mutate_external` / `destructive` | **last** (or never) | These bodies carry *decisions and receipts* (the form that was submitted, the file that was deleted) — the highest-value provenance, and often non-idempotent to re-run. |

So under pressure peerd elides the cheapest, most-recoverable bulk first and
protects the decision-bearing (and the expensive-to-re-run) results longest.
Because recovery is "re-run the tool," **`durationMs` is a first-class
signal** — it's already on `meta`, so the classifier reads it for free. This
is what lets us drop the re-expansion tool (§8): the only results worth a
recovery affordance are exactly the ones the classifier keeps verbatim.
Position-based schemes (head/middle/tail) can't make any of these
distinctions; summarization throws them away. This is the ROADMAP's
"lineage-based" in its strongest sense: **compress along the provenance
axis, not the time axis.**

---

## 7. How it composes with the shipped trigger

Three layers, cheapest-and-most-faithful first:

1. **Redaction** (`redact.js`, shipped) — bounds each body to ~8k chars at
   persist time. First line of defense against single-turn blowups.
2. **Lineage body compaction** (this design) — shrinks *old* tool-result
   bodies (older than `keepBodiesRecent`) to their spine. Deterministic,
   structure-safe, lossy only in-context (full body stays at rest). Runs
   *before* the summary.
3. **Rolling sliding-window summary** (`trim.js` + `rolling-summary.js`,
   shipped) — the deep backstop: once even the spine-compacted history
   exceeds the token trigger, collapse the oldest turns into the rolling
   summary.

Wiring in the loop (one extra step before `planTrim`):
```
estimate = estimateMessagesTokens(history, system)
if estimate > TRIGGER × contextWindow:
    history = planBodyCompaction(history, { budgetTokens: TARGET × contextWindow, … })
    re-estimate
if still > TRIGGER × contextWindow:
    plan = planTrim(history, { contextWindow, system, … })   // existing
```
Because bodies are the bulk, step 2 usually brings the estimate under target
on its own, so the lossy summary collapse (step 3) fires far less often —
which also means **fewer full-prefix cache busts**, since a compaction is a
one-time monotonic transition per block rather than a repeated re-summarize.

The token estimator (`estimate.js`) already counts tool-result bodies, so
after compaction the estimate drops automatically — no estimator change.

---

## 8. Recovery: re-run, not re-expand (why no `get_tool_output`)

An earlier draft added a read-only `get_tool_output(tool_use_id)` tool
backed by a per-session body store, to pull a compacted body back into
context. **Both were cut.** The reasoning:

- **A tool is a permanent context tax for an occasional benefit.** Every
  tool definition costs tokens on *every* turn and widens the model's
  decision surface. peerd already exposes a large set; paying that
  continuously to serve a rare recovery case is a bad trade.
- **A compacted body is stale by definition** — it aged out of the recent
  window. For web content especially, **re-running the tool gets fresher,
  more correct data** than expanding an old snapshot of a page that may
  have changed. The spine names the tool + origin, so "re-run it" is an
  obvious, clean path.
- **Dropping the reader drops the store.** The store existed only to feed
  re-expansion. No reader ⇒ no store ⇒ no IDB cache, cap, prune, or
  session-cleanup. The full body still lives in the **at-rest session
  record** (the trim path only ever changes what's *sent*), so `/undo` and
  the transcript view are unaffected — the human/UI recovery path is intact.
- **The expensive-to-re-run case is handled by the classifier, not a tool.**
  The only results genuinely costly to re-run are the decision-bearing
  (writes/mutations) and the expensive computes — and §6 keeps exactly
  those uncompacted longest, keyed off `sideEffect` + `durationMs`. So the
  set "would benefit from re-expansion" and the set "we never compacted
  anyway" largely coincide.

Net: the scheme is **lossy in-context, lossless at rest, recoverable by
re-run.** Still strictly better than today's rolling summary, which
discards tool bodies entirely and keeps only a model-written paraphrase.
It's the peerd-native analog of Anthropic's server-side context-editing
(`clear_tool_uses`) — except peerd keeps the *provenance spine* inline
instead of clearing opaquely.

---

## 9. Invariants & safety

- **Pairing is never broken.** Bodies shrink; blocks never move or drop. No
  orphaned `tool_result`, no provider 400 — structurally guaranteed.
- **Monotonic.** `compacted: true` is a latch; a block is rendered to its
  spine exactly once. No thrash, one cache transition per block.
- **Never the live turn.** `keepBodiesRecent` protects the most recent
  rounds (the agent's working set) verbatim.
- **Fail-open, never block the turn.** The transform is pure and total — a
  block it can't classify is simply left verbatim, never an exception.
- **No new wire surface.** `compacted`/`meta` stay off the wire; the model
  sees a normal `tool_result` whose `content` is the spine string.
- **Audit honesty.** The spine is *derived from* the same lineage the audit
  log records — compaction can't misrepresent what happened, because it's
  rendering the recorded gate chain, not a model's paraphrase.

---

## 9a. Durable handles survive elision (the spine carries the id)

A specific worry: if the agent **creates an App / Notebook / WebVM**, the
instance's id is first surfaced only in the *create-tool result*. If that
result is later compacted, would the id be lost?

No — the instance itself persists in its **engine registry** (`appRegistry`
/ `jsRegistry` / `vmRegistry`) with a stable id, so it's never *gone*; the
only question is whether the agent still *knows the id*. So `renderLineageLine`
**carries the handle in the spine**: for engine-instance results (primitive
∈ `app` / `notebook` / `webvm`) it pulls the `id` (and `name`) out of the
body before eliding it, e.g.

```
‹elided› app_create · app · ok · id=app-abc "Calculator" · 1.2k chars
```

So even a heavily compacted session still reads "created app-abc" in its own
history and can reopen/act on it (the registry has it) instead of recreating
it. This is deliberately lean — no standing per-turn block, no extra context;
the id rides for free in a spine that only exists once a result is compacted
(and create results, being small + `write`-class, are usually compacted last
or not at all).

**The deeper case — the create turn fully collapsed into the rolling
summary — is covered too, deterministically.** When `planTrim` folds elided
messages, `foldDropped` (rolling-summary.js) *mechanically harvests* the same
engine-instance handles (via the shared `instance-handle.js` extractor, which
reads BOTH the raw create body AND an already-rendered spine) into a dedicated
`state.handles` list. That list:

- renders under **`Artifacts / handles:`** in the trim summary, so the id is
  present in what the model actually sees post-trim;
- is **append-only and capped**, deduped by id+name;
- is **never destroyed by the optional model enrichment.** The enrichment is,
  by the module's own doctrine, quality-only and strictly optional — and it
  can't even see the id (the enrichment digest strips tool-result bodies). So
  handle retention must not depend on it. `handles` is a separate field from
  the model's prose `artifacts`; `mergeEnrichment` replaces `artifacts` but
  never touches `handles`, and the over-budget render-drop loop drops prose
  artifacts before it would ever drop a handle (it doesn't).

So the handle is carried by two independent, deterministic carriers across the
two elision mechanisms: the **spine** (compaction) and the **`handles` harvest**
(trim). The `*_list` tools + engine registry remain the ultimate backstop, but
the agent no longer has to fall back to them to *know* an instance exists.

## 10. Risks & tradeoffs

- **In-context loss.** A compacted body can't be pulled back into the
  prompt — recovery is re-running the tool. Mitigated by §6 (keep the
  costly/decision-bearing ones verbatim) and by the body still being in
  at-rest history for the human/UI.
- **Marginal win on chat-heavy sessions.** Lineage compaction targets
  *tool-bulk*; a conversation with few tool results sees little benefit —
  but that's exactly the case the rolling summary already handles. The two
  layers cover disjoint workload shapes.
- **Cache cost of the transition.** Real but one-time per block and
  batched at the same drift-anchored watermark as the trim, so it's
  amortized, not per-turn.
- **Classifier needs tuning.** The read/write/cost ordering is a policy that
  wants real session traces (§11 phase 4) — but the floor behavior (compact
  read+ok+cheap first) is safe from day one.

---

## 11. Phased implementation (revised — 4 phases, no store, no tool)

1. **Foundation (small, low-risk):** add `meta.origins` in the dispatcher +
   a couple of bun tests. Lands independently; makes the spine complete.
2. **Render core (pure):** `renderLineageLine` + `planBodyCompaction`,
   fully bun-tested. No store, no IO — values in, values out.
3. **Wire into the loop:** the pre-`planTrim` compaction step (§7), gated
   behind the same `contextWindow` signal; pure plan, imperative apply.
4. **Lineage/cost classifier (§6):** start with read+ok+cheap-first; bring
   in `durationMs` and `sideEffect` to keep writes/mutations/expensive
   computes longest; tune with real session traces.

Phases 1–2 are pure and land without touching the hot path. (The cut
`get_tool_output` tool + body store are gone entirely — see §8.)

---

## 12. Why this beats the alternatives (summary)

| | Head/middle/tail (Hermes) | Summarize the middle | **Lineage compaction (this)** |
|---|---|---|---|
| Determinism | positional, exact | model-written, lossy | **deterministic, exact** |
| Model call | no | **yes** (cost + latency + hallucination risk) | **no** |
| Loss profile | drops the middle | paraphrases (lossy) | **keeps the spine; full body at rest; recover by re-run** |
| Structure-safe | needs care | needs care | **safe by construction** |
| Provenance kept | no | no | **yes (the spine IS the audit lineage)** |
| Compaction order | by time | by time | **by side-effect class + cost** |

It's the same instinct as the dynamic trigger work: a **mechanical,
deterministic, never-blocks-the-turn** core that does most of the job, with
the model-driven path (the rolling summary) reserved as the deep backstop.
