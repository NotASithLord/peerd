// @ts-check
// Local per-model pricing table + cost math (cost telemetry, feature 06).
//
// CRITICAL — NO TELEMETRY: the dollar math is 100% client-side. This file
// is a static data table plus pure arithmetic. Nothing here phones home,
// fetches a remote price feed, or reports usage anywhere. Token counts
// come off the provider SSE stream (peerd-provider/format/*), get
// multiplied by the rates below, and the result is rendered in the side
// panel and persisted locally. That's the whole loop.
//
// Prices are USD per 1,000,000 tokens, the unit both Anthropic and
// OpenRouter publish in. Four rate slots per model, matching our
// normalized TokenUsage:
//   input  — non-cached prompt tokens
//   output — completion tokens
//   cacheRead  — tokens served from a cached prefix (≈10% of input on
//                Anthropic; varies on OpenRouter)
//   cacheWrite — tokens written into the cache this turn (Anthropic bills
//                a one-time 25% premium; OpenRouter/OpenAI report no
//                separate cache-write line, so 0)
//
// This table is a SNAPSHOT and WILL drift — vendors change prices. That's
// exactly why it's user-overridable (see resolvePricing): the user can
// paste corrected rates in Settings without waiting on an extension
// update, and an unknown model id degrades gracefully to a $0 estimate
// with an explicit `estimated:false` flag rather than a wrong number.

/** @typedef {import('./format/from-anthropic.js').TokenUsage} TokenUsage */

/**
 * @typedef {{ input: number, output: number, cacheRead: number, cacheWrite: number }} ModelRates
 *   USD per 1,000,000 tokens.
 */

// why: per-million is the published unit; dividing once here keeps the
// cost formula readable (rate * tokens / PER_MILLION).
const PER_MILLION = 1_000_000;

/** Zero rates — local inference, and the fallback for unknown ids. */
const ZERO_RATES = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

// Built-in defaults. Keyed by the exact model id the adapters send on the
// wire (Anthropic short ids; OpenRouter `vendor/model` ids). Frozen so a
// stray write can't corrupt the shared table.
//
// Sources (2026-06 snapshot, USD / 1M tokens):
//   Anthropic   — anthropic.com/pricing
//   OpenRouter  — openrouter.ai/models
/** @type {Readonly<Record<string, ModelRates>>} */
export const DEFAULT_PRICING = Object.freeze({
  // ---- Anthropic (native adapter) ----
  // why: keys must cover every id in the SW's MODEL_CATALOG (the picker
  // sends these exact strings on the wire) — tests/peerd-provider/
  // pricing.test.ts enforces the parity so the tables can't drift.
  // cacheRead = 0.1x input, cacheWrite = 1.25x input (the 5-minute
  // ephemeral TTL premium; peerd only uses the default TTL).
  'claude-opus-4-8':            Object.freeze({ input: 5,   output: 25,  cacheRead: 0.5,   cacheWrite: 6.25  }),
  'claude-opus-4-6':            Object.freeze({ input: 5,   output: 25,  cacheRead: 0.5,   cacheWrite: 6.25  }),
  'claude-sonnet-4-6':          Object.freeze({ input: 3,   output: 15,  cacheRead: 0.3,   cacheWrite: 3.75  }),
  'claude-haiku-4-5-20251001':  Object.freeze({ input: 1,   output: 5,   cacheRead: 0.1,   cacheWrite: 1.25  }),
  // Bare alias for the same model — covers custom Settings entries that
  // use the undated id.
  'claude-haiku-4-5':           Object.freeze({ input: 1,   output: 5,   cacheRead: 0.1,   cacheWrite: 1.25  }),

  // ---- OpenRouter (`vendor/model`) ----
  'openai/gpt-4o-mini': Object.freeze({ input: 0.15, output: 0.6,  cacheRead: 0.075, cacheWrite: 0 }),
  'openai/gpt-4o':      Object.freeze({ input: 2.5,  output: 10,   cacheRead: 1.25,  cacheWrite: 0 }),
  'anthropic/claude-sonnet-4-6': Object.freeze({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }),
  'google/gemini-2.0-flash':     Object.freeze({ input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0 }),
  'meta-llama/llama-3.3-70b-instruct': Object.freeze({ input: 0.12, output: 0.3, cacheRead: 0.12, cacheWrite: 0 }),

  // ---- Ollama (local inference — $0 by construction) ----
  // why: the CostChip prices by model id; without entries the curated
  // local models would read "unknown" instead of the truthful $0. Keys
  // mirror OLLAMA_MODEL_TIERS (ollama-recommend.js) — a bun test pins
  // the parity. Arbitrary other pulled models are covered by the
  // localProvider fallback in resolvePricing below.
  'qwen3:32b': ZERO_RATES,
  'qwen3:14b': ZERO_RATES,
  'qwen3:8b':  ZERO_RATES,
  'qwen3:4b':  ZERO_RATES,
});

/**
 * Resolve the rate card for a model id, applying user overrides on top of
 * the built-in table. Overrides win — that's the escape hatch for vendor
 * price changes between extension updates.
 *
 * @param {string} model
 * @param {Record<string, Partial<ModelRates>>} [overrides]
 *   User-supplied rates keyed by model id (from Settings, persisted
 *   locally). A partial override merges over the default for that model.
 * @param {{ localProvider?: boolean }} [opts]
 *   `localProvider: true` = the model runs on the user's own hardware
 *   (keyless provider, e.g. Ollama). An UNKNOWN local model id still
 *   genuinely costs $0, so it resolves to a KNOWN zero card instead of
 *   "estimate unavailable" — that's the honest reading, not a guess.
 * @returns {{ rates: ModelRates, known: boolean }}
 *   `known` is false when neither the table nor the overrides have an
 *   entry — the caller surfaces that as an explicit "estimate unavailable"
 *   instead of silently showing $0.00 as if it were real.
 */
export const resolvePricing = (model, overrides, { localProvider = false } = {}) => {
  const base = DEFAULT_PRICING[model];
  const ovr = overrides?.[model];
  if (!base && !ovr) return { rates: ZERO_RATES, known: localProvider };
  return {
    rates: { ...ZERO_RATES, ...(base ?? {}), ...(ovr ?? {}) },
    known: true,
  };
};

/**
 * Compute the USD cost of one TokenUsage tally for a given model. Pure.
 *
 * @param {string} model
 * @param {TokenUsage} usage
 * @param {Record<string, Partial<ModelRates>>} [overrides]
 * @param {{ localProvider?: boolean }} [opts]  see resolvePricing
 * @returns {{ cost: number, estimated: boolean }}
 *   `cost` in USD. `estimated` is true when the model id had a rate card
 *   (built-in or override); false means we had no rates and `cost` is 0 —
 *   the UI shows "—" rather than a misleading $0.00.
 */
export const costOf = (model, usage, overrides, opts) => {
  const { rates, known } = resolvePricing(model, overrides, opts);
  if (!known || !usage) return { cost: 0, estimated: false };
  const cost =
      (rates.input      * (usage.inputTokens      || 0)
     + rates.output     * (usage.outputTokens     || 0)
     + rates.cacheRead  * (usage.cacheReadTokens  || 0)
     + rates.cacheWrite * (usage.cacheWriteTokens || 0)) / PER_MILLION;
  return { cost, estimated: true };
};

/**
 * True if we have a rate card for this model (built-in or override).
 * @param {string} model
 * @param {Record<string, Partial<ModelRates>>} [overrides]
 * @returns {boolean}
 */
export const hasPricing = (model, overrides) => resolvePricing(model, overrides).known;
