# Feature 06 — BYOK cost / usage telemetry — DESIGN

Live token-count + dollar-cost per turn, a running per-session total, and an
optional **hard spend limit** that HALTS the agent when crossed. Surfaced
continuously in the side panel; per-session totals persisted for later review.

Reference points: Cline's spend UI, OpenCode's cost display.

**The whole feature is LOCAL.** Token counts ride the SSE stream peerd already
consumes; the dollar math is pure arithmetic against an in-code pricing table.
Nothing phones home — no price feed fetch, no usage upload, no telemetry beacon.
That is the non-negotiable constraint and it shapes every decision below.

---

## 1. Where usage is extracted from each provider stream

Both wire→internal translators already yield a `ProviderEvent` union the agent
loop consumes. We add ONE new member: `{ type: 'usage', usage: TokenUsage }`,
emitted exactly once per model call, **immediately before** `message-stop`.

`TokenUsage` is provider-agnostic (counts only, no dollars):

```
{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
```

`inputTokens` is **non-cached** prompt tokens (cache reads/writes are their own
buckets), so a single pricing formula works for both providers.

### Anthropic — `peerd-provider/format/from-anthropic.js`

Anthropic splits usage across two SSE events:

- `message_start` → `message.usage`: `input_tokens`,
  `cache_read_input_tokens` (cache READ), `cache_creation_input_tokens`
  (cache WRITE), and an initial `output_tokens`.
- `message_delta` → `usage.output_tokens`: the **final cumulative** output
  count (overwrite, not add).

We capture the prompt-side counts at `message_start`, overwrite output at each
`message_delta`, and emit one `usage` event right before `message_stop`. A
truncated stream (no `message_stop`) still emits whatever was captured before
the synthesized incomplete-stop — it was billed for its input.

### OpenAI / OpenRouter — `peerd-provider/format/from-openai.js`

Requires opting in: `to-openai.js` now sets `stream_options:{include_usage:true}`.
Without it these streams carry **no** token counts at all.

The provider then emits a FINAL chunk (usually `choices:[]`) carrying top-level
`usage`: `prompt_tokens`, `completion_tokens`,
`prompt_tokens_details.cached_tokens`. That chunk arrives AFTER the
`finish_reason` chunk, so the translator **defers** its `message-stop` to stream
end and flushes `usage` first — preserving the "usage before stop" ordering the
loop relies on. `cached_tokens` is subtracted out of `inputTokens` (OpenAI
reports it *inside* `prompt_tokens`) and mapped to `cacheReadTokens`; these
providers bill no separate cache-write line, so `cacheWriteTokens = 0`.

---

## 2. The accumulation model

`peerd-runtime/cost/accumulator.js` — the functional core. Pure folds, no IO,
no clock. The SW owns the imperative shell (read → fold → persist → push →
enforce).

A `CostTally` = the four token buckets + `cost` (USD) + `turns` (count).

- **Turn tally** — reset at the start of each user turn (`bumpTurn(emptyTally())`).
  Each `usage` event folds in via `addUsage(tally, usage, cost)`. Drives the
  meter's live "+$0.00x this turn" readout.
- **Session tally** — seeded from the session record's persisted `cost`
  (`normalizeTally(session.cost)`), counted once per user turn, folded the same
  way. Persisted back via `sessions.setCost(...)` after every fold so /chats
  review and SW restarts both see accurate lifetime spend.

A multi-step tool-using turn emits one `usage` per model call; `addUsage` sums
them, so the turn tally correctly reflects all calls in the turn.

`normalizeTally` coerces missing/garbage stored values into a zeroed tally — a
pre-feature session (no `cost` field) or a corrupt write degrades to $0, never
NaN.

---

## 3. The pricing table

`peerd-provider/pricing.js` — static data + pure arithmetic. USD per 1,000,000
tokens, four rate slots per model (`input`, `output`, `cacheRead`, `cacheWrite`).

- `DEFAULT_PRICING` — frozen built-in table (Anthropic Opus/Sonnet/Haiku +
  several OpenRouter `vendor/model` ids; 2026-06 snapshot).
- **User-overridable** — `resolvePricing(model, overrides)` merges a
  user-supplied partial rate card over the default for that model id. Overrides
  win; that's the escape hatch when a vendor changes prices between extension
  updates. Stored under `settings.pricingOverrides` (local), edited in Settings.
- **Graceful unknowns** — `costOf` returns `{cost:0, estimated:false}` for a
  model with no rate card (built-in OR override). The UI shows "—" instead of a
  misleading `$0.00`.

```
costOf(model, usage, overrides) → { cost, estimated }
```

Pure multiply-and-sum, divided by 1e6. The SW prices against the **session's**
model (the one that produced the usage), not the current Settings selection.

---

## 4. The limit / halt mechanism

`limitExceeded(sessionCost, limit)` — pure predicate. `limit` of 0/null/NaN/≤0
means "no limit". Strict `>`: a session landing exactly on the cap is allowed;
only spend that pushes PAST it halts.

In the SW's turn driver (`runAgentTurn`), after every `usage` fold:

1. price → `addUsage` into turn + session tallies → `sessions.setCost`.
2. push `turn/cost` to the side panel (live meter update).
3. if `limitExceeded(sessionTally.cost, limitUsd)`:
   - push `turn/spend-limit-reached`,
   - append a `spend_limit_reached` audit entry,
   - **`abortController.abort()`** — the SAME `activeAbortController` the Stop
     button and steer-live path use. The agent loop unwinds through its existing
     clean-abort branch (persists the partial, yields `stopReason:'aborted'`).

Reusing the existing AbortController is the browser-native tie-in the mandate
calls for: no new cancellation path, no torn state — the halt is exactly a
programmatic Stop.

The usage handling runs **before** the `if (!sidePanelPort) continue` guard, so
the persisted total and the halt stay correct even with the panel closed (long
agentic turns run hidden).

---

## 5. Browser-native angle

The meter is an always-visible side-panel surface (`sidepanel/components/
cost-meter.js`), mounted directly under the top bar in every view. The user is
watching the agent work in their browser, so spend ticks up live as `turn/cost`
events land — a compact `$total · Ntok` line, a `+$x this turn` delta that
pulses while streaming, and (when a limit is set) a budget bar that fills toward
the cap and escalates ok→warn→danger. On halt it becomes a clear "spend limit
reached — agent halted" banner.

---

## 6. Cross-cutting checklist

- **NO TELEMETRY (load-bearing).** `pricing.js` is data + arithmetic; no fetch,
  no remote feed, no upload. Usage never leaves the browser. The dollar math is
  100% client-side. Verified: no network call anywhere in the cost path.
- **MV3 30s SW lifetime.** Session totals persist on the session record in IDB
  via `sessions.setCost` after every fold — a SW kill mid-session loses nothing;
  the next turn reseeds from the persisted tally.
- **Single-threaded writes.** `setCost` is its own store method, separate from
  message writes, so a cost update never races a streaming-message patch on the
  same record's `messages` array.
- **Reversibility.** Pure-data tally on the session; clearing it is a no-op
  overwrite. Settings are whitelisted + sanitized in `settings/update`.
- **a11y / reduced-motion.** Meter has `role="status" aria-live="polite"`, a
  descriptive `aria-label`, and a `role="progressbar"` budget bar with
  valuemin/max/now. The live-delta pulse + bar transition are disabled under
  `prefers-reduced-motion`.
- **Lethal-trifecta / egress.** Adds no new egress; `include_usage` is a body
  flag on an already-allowlisted endpoint.
- **Lean memory.** No memory-file growth; this is runtime state, not agent
  memory.

---

## 7. V1.x gaps (see DEV-NOTES.md)

- Subagent turns don't yet roll their cost up into the parent session tally.
- Pricing table is a manual snapshot; no auto-refresh (by design — no network).
- No per-model breakdown in the meter (session aggregate only); the data is
  there if a later view wants it.
