# Design 5 — make it measurable: tool errors + wasted turns in the scorecard

## Why this lands FIRST

Hermes's method was mine → fix → A/B eval. peerd **cannot currently measure the
thing this whole batch improves**: the eval engine is blind to tool outcomes,
so nothing here can be proven rather than asserted. This design is
eval-harness-only (no runtime risk) and unblocks the before/after story for
designs 1–4 and 6.

## The gaps (audited)

- `eval-engine.js` port listener (`:86-165`) has **no `turn/tool-result`
  case** — the event IS emitted (`loop/turn-driver.js:633`) and IS consumed in
  the standalone `runner.js:139`, just never in the engine.
- `State` (`eval/tasks.js:21`) = `{tabUrl, tabTitle, tabText, answer, steps,
  tools[], tokens, durationMs, error}`. `tools[]` is a flat array of tool
  NAMES — it cannot tell a call that succeeded from one that failed. `steps`
  is just `tools.length`.
- `score.aggregate` (`score.js:44-80`) tracks pass/tokens/cost/steps/duration.
  `score.compare` (`:103-122`) diffs the same. **No tool-error metric, no
  wasted-turn metric anywhere.**

## The additions

### 5a. Capture tool outcomes in `State`

- Add `case 'turn/tool-result'` to the engine's port listener (mirror
  `runner.js:139`). Each event carries `{ tool_use_id, ok/is_error }` (confirm
  the exact shape emitted at `turn-driver.js:633`).
- Extend `State` with `toolResults: Array<{ name, ok }>` (correlate the
  result's `tool_use_id` back to the `turn/tool-use` that named the tool).
  Keep `tools[]` for back-compat.
- Derive and store on the per-task row: `toolErrors` (count of `ok===false`),
  and `toolErrorsByName` (`Record<name, count>`), plus `toolCalls`
  (= `tools.length`).

### 5b. A wasted-turn signal

"Wasted turn" needs a definition that's computable from the transcript without
a human. Ship a conservative, documented heuristic (name it, don't overclaim):

- **repeated-identical-call**: the same `{tool, args-hash}` issued more than
  once in a task (a retry that changed nothing) — count the extras.
- **error-then-retry**: a tool error immediately followed by the same tool on
  the next step (the model reacting to a bad error) — count the pairs.
- **truncation-forced-reread**: a read tool called again on the same target
  after a truncated result with no paging in between (needs 4's paged marker;
  until then approximate by "same read tool + same primary arg twice").

Compute these in a pure `wastedTurns(stateOrTranscript)` helper (Bun-testable),
emit `wastedTurns` (a count) + `wastedByKind` on the task row. Document each
heuristic's blind spots in the code — this is a PROXY, and the doc must say so
(no silent caps; if a heuristic can't see a class, `log`/comment it).

### 5c. Surface them in aggregate + compare

- `score.aggregate` gains `avgToolErrors`, `toolErrorRate`
  (errors / total calls), `avgWastedTurns`, and a `toolErrorsByName` rollup.
- `score.compare` gains `toolErrorsDelta`, `wastedTurnsDelta`,
  `toolErrorRateDelta` — so a bench run before/after a fix shows the drop, and
  `run-eval-bench.mjs`'s exit-1-on-regression logic can guard tool-error
  regressions too (opt-in: don't fail an existing bench on the new axis
  without a flag).
- The bench scorecard record (`run-eval-bench.mjs`) already serializes
  `results`; the new fields ride along for free. Add them to the headline
  print.

### 5d. (Optional, same PR if cheap) the local analyzer seam

The audit found the mining substrate already exists: `sessions.list()` walks
every session read-only; `collectFailures` (`observability/debug-bundle.js:73`)
+ `classifyFailure` are pure exported functions that already yield
`{scope, kind, toolUseId, when, error}` per session — nobody has aggregated
them across sessions. A tiny pure `aggregateFailures(sessions)` →
`Record<{tool,kind}, count>` (over `flatMap(collectFailures)`) is the
local-first, no-telemetry "wasted turn / error class" analyzer Hermes built
from a production DB. Ship the pure aggregator + a Bun test; wiring it to a UI
tab or the debug bundle is a follow-up (note it). This is the on-brand
(no-backend) version of "mine 250k conversations."

## Touch points

| File | Change |
|---|---|
| `extension/eval/eval-engine.js` | `turn/tool-result` case; carry outcomes into `State` (`:303-307`) |
| `extension/eval/tasks.js` | extend the `State` typedef (`:21`) |
| `extension/eval/score.js` | `aggregate` + `compare` gain the tool-error / wasted-turn fields; a pure `wastedTurns()` helper |
| `scripts/cdp/run-eval-bench.mjs` | headline print + scorecard fields + opt-in regression guard |
| `extension/peerd-runtime/observability/` (5d) | pure `aggregateFailures(sessions)` over the existing `collectFailures` |

## Tests (Bun-heavy — most of this is pure)

- `wastedTurns()` over synthetic transcripts hits each heuristic and its blind
  spots (documented false-negatives asserted as such).
- `aggregate`/`compare` over synthetic result rows produce the new fields;
  `compare` deltas are signed correctly.
- 5d `aggregateFailures` over synthetic sessions groups by `{tool,kind}`.
- A round-trip: a fake `turn/tool-result` event flows through the engine's
  listener into `State.toolResults` (may need a light harness around the
  listener; the standalone `runner.js` already proves the event shape).

## Non-goals / honesty

- This does not add per-turn token accounting (only session-level is
  persisted); wasted-turn cost is approximated by turn count, not tokens.
- The heuristics are proxies. The doc and the code say so. The eval suite's
  end-state checks remain the ground truth for correctness; these metrics are
  for EFFICIENCY regressions, reported alongside pass-rate, never replacing it.

## Open questions

1. Wasted-turn definition — ship all three heuristics or start with
   repeated-identical-call (the least ambiguous)? Recommend all three, each
   behind a named key so a noisy one can be ignored.
2. 5d analyzer in this PR or follow-up? Recommend: ship the pure aggregator +
   test now (cheap, unblocks a future UI), defer the UI.
