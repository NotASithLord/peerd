# Feature 06 — cost/usage telemetry — DEV-NOTES

Integrator-facing map of what landed, the keys, the wiring, and the gaps.

## Entry points

| Concern | File | Symbol |
|---|---|---|
| Usage off Anthropic SSE | `peerd-provider/format/from-anthropic.js` | `usage` ProviderEvent (message_start + message_delta) |
| Usage off OpenAI/OpenRouter SSE | `peerd-provider/format/from-openai.js` | `usage` ProviderEvent (final usage chunk) |
| Opt into OpenAI usage chunk | `peerd-provider/format/to-openai.js` | `stream_options:{include_usage:true}` |
| Pricing table + cost math | `peerd-provider/pricing.js` | `DEFAULT_PRICING`, `costOf`, `resolvePricing`, `hasPricing` |
| Accumulation (functional core) | `peerd-runtime/cost/accumulator.js` | `emptyTally`, `normalizeTally`, `addUsage`, `bumpTurn`, `totalTokens`, `limitExceeded` |
| Loop event passthrough | `peerd-runtime/loop/agent-loop.js` | `case 'usage'` → yields `{type:'usage',...}` LoopEvent |
| SW accumulate + persist + halt | `background/service-worker.js` | `runAgentTurn` `if (ev.type==='usage')` block |
| Session persistence | `peerd-runtime/sessions/store.js` | `setCost(sessionId, tally)`; `Session.cost` |
| Side-panel meter | `sidepanel/components/cost-meter.js` | `CostMeter` |
| Meter mount | `sidepanel/components/app.js` | under TopBar, every unlocked view |
| Settings UI | `sidepanel/components/settings-view.js` | "Spend limit" + `PricingOverrides` |
| Port reducers | `sidepanel/sidepanel.js` | `turn/cost`, `turn/spend-limit-reached`, `state.cost` |

Public surfaces: `costOf`/`DEFAULT_PRICING`/`resolvePricing`/`hasPricing` from
`peerd-provider`; accumulator helpers from `peerd-runtime`.

## Settings / storage keys

In `settings.v1` (chrome.storage.local via egress `kv`):

- `spendLimitUsd: number` — USD session hard cap. `0` = no limit. Clamped
  `0 < v ≤ 100000` in `settings/update`; garbage → 0.
- `pricingOverrides: { [modelId]: { input?, output?, cacheRead?, cacheWrite? } }`
  — USD per 1M tokens. Sanitized to finite ≥0 leaves; bad keys dropped.

On the session record (IDB `sessions` store): `cost: CostTally` — persisted
lifetime spend/usage for the conversation. Absent on pre-feature sessions;
`normalizeTally` defaults it at read time.

## Provider-format changes

- New ProviderEvent: `{ type:'usage', usage:{ inputTokens, outputTokens,
  cacheReadTokens, cacheWriteTokens } }`, emitted ONCE per model call,
  immediately before `message-stop`. `inputTokens` = non-cached prompt tokens.
- Anthropic: read `message.usage` at `message_start` (input + cache read/write),
  overwrite output from `message_delta.usage.output_tokens`.
- OpenAI/OpenRouter: read top-level `usage` from the final chunk; `message-stop`
  is now deferred to stream end so usage leads it. `cached_tokens` subtracted
  from `inputTokens`. Requires `include_usage` (added to `to-openai.js`).
- Backward-compatible: a stream with no usage data emits no `usage` event, so
  existing exact-sequence tests are unaffected.

## The abort hook (hard limit)

The halt reuses `activeAbortController` in `runAgentTurn` — the same controller
the Stop button (`agent/stop`) and steer-live mid-turn send use. On
`limitExceeded(sessionTally.cost, limitUsd)` the SW calls
`abortController.abort()`. The agent loop catches it at TWO points, both
persisting the partial message as `stopReason:'aborted'`: the mid-stream
AbortError branch (abort while the stream is still open) AND an explicit
pre-dispatch check after the stream ends, before the tool-dispatch waves. The
pre-dispatch check is load-bearing for the SPEND limit specifically: adapters
emit `usage` (where the limit fires) one event before `message-stop`, so the
abort lands in the stream-end→dispatch gap — which the AbortError branch alone
would miss, running the already-emitted `tool_use` blocks before the next
loop-top check caught it.

The side panel surfaces it via `turn/spend-limit-reached` → `cost.limitReached`
→ the meter's halt banner + a `spend-limit-reached` entry in the error mapper.
An audit entry `spend_limit_reached` is appended.

## Integrator wiring (already done in the SW)

`runAgentTurn` handles `ev.type === 'usage'` BEFORE the `if (!sidePanelPort)
continue` guard so persistence + halt work with the panel closed:

```
const { cost } = costOf(costModel, ev.usage, overrides);   // session's model
turnTally    = addUsage(turnTally, ev.usage, cost);
sessionTally = addUsage(sessionTally, ev.usage, cost);
await sessions.setCost(sessionId, sessionTally);
// push turn/cost; if limitExceeded → push turn/spend-limit-reached + abort
```

`pushState` includes `session.cost` (normalized) so the meter shows lifetime
spend on load / session switch.

## Tests (Bun, green)

- `tests/peerd-provider/usage-stream.test.ts` — usage parsed from sample
  Anthropic + OpenAI/OpenRouter streams (incl. usage-after-finish_reason and
  truncated stream), usage-before-stop ordering, cost from the pricing table,
  override-wins, unknown-model `estimated:false`.
- `tests/peerd-runtime/cost-accumulator.test.ts` — fold immutability, multi-fold
  summation, `bumpTurn`, `normalizeTally` coercion, and the exact
  `limitExceeded` crossing boundary (under / on-cap / over).

Run: `bun test ./tests`.

## V1.x gaps

- **Subagent cost roll-up.** Subagent turns accumulate their own session tally
  but don't roll up into the parent's. Wire `spawn.js` to fold the child's
  `session.cost` into the parent after the child completes.
- **Per-model breakdown.** Meter shows the session aggregate only. The tally has
  the token buckets; a future expandable view could break down by model/turn.
- **Pricing freshness.** Built-in table is a manual snapshot. No auto-refresh by
  design (no telemetry / no network). Overrides are the user's lever.
- **Limit granularity.** One global session cap. No per-profile or per-day cap
  (profiles land V1.2; revisit then).
- **Estimate signalling in the meter.** `costOf` returns `estimated:false` for
  unknown models; the SW currently folds it as $0. A later pass could surface an
  "estimate unavailable for <model>" hint in the meter when `estimated` is false
  but tokens were spent.
