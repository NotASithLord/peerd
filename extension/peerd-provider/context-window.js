// @ts-check
// Per-model context-window table + resolver (long-session compression).
//
// The trim/compression layer (peerd-runtime/loop/trim.js) decides WHEN to
// collapse old turns by comparing the estimated prompt size to a fraction
// of the active model's context window. That threshold must be DYNAMIC:
// a 200K Anthropic model should trim far later than a 128K GPT-4o, and a
// 1M-context model later still. This file is where "what's this model's
// window?" is answered.
//
// CRITICAL — NO TELEMETRY, same posture as pricing.js: a static data table
// plus pure resolution. Nothing here phones home or fetches a remote
// catalog at module load. The numbers are a SNAPSHOT and WILL drift, so
// the table is user-overridable AND accepts a LIVE value when a provider
// can report its own window (OpenRouter `/models` context_length, Ollama
// `num_ctx`) — resolution order is override > live > table > fallback.
//
// Windows are TOTAL context (prompt + completion) in tokens, the unit
// every vendor publishes. The trim layer leaves headroom for the
// completion + tools by triggering at a fraction (default 0.75), so this
// table holds the raw window, not a pre-discounted budget.

/**
 * @typedef {{ window: number, known: boolean }} ContextWindow
 *   `known` is false when neither the table, an override, nor a live value
 *   had an entry — the caller treats an unknown window as "don't apply the
 *   token trigger" (fall back to the message-count backstop) rather than
 *   guessing a number that could be wildly wrong for a small local model.
 */

// Conservative fallback for an unknown model id. Only used when a caller
// explicitly asks for a number regardless of `known`; the trim layer
// instead keys off `known` and skips the token trigger when it's false.
export const DEFAULT_CONTEXT_WINDOW = 128_000;

// Built-in defaults. Keyed by the exact model id the adapters send on the
// wire — Anthropic short ids, OpenRouter `vendor/model` ids, Ollama tags.
// Frozen so a stray write can't corrupt the shared table.
//
// Sources (2026-06 snapshot, total context tokens):
//   Anthropic   — the Models API reports max_input_tokens per id. Current
//                 Opus 4.6/4.7/4.8 and Sonnet 4.6 are 1M BY DEFAULT (same
//                 id, no beta header); Haiku 4.5 is 200K. (The historical
//                 `context-1m-2025-08-07` beta — same id, 200K default,
//                 1M only when the header is sent — applied to the older
//                 Sonnet 4/4.5, which peerd neither ships nor opts into.)
//                 The live Models API value (resolveContextWindow's `live`)
//                 is authoritative and overrides this snapshot.
//   OpenRouter  — openrouter.ai/models (context_length)
//   Ollama      — model cards; the EFFECTIVE window is the user's num_ctx,
//                 so these are nominal maxima — a live value wins.
//   Local WebGPU — the on-device runner. The canonical value lives in
//                 MODEL_SPECS (local-model-capability.js); the entry here is
//                 the cold-start fallback and is kept in sync by a parity
//                 test. Like Ollama, it's a nominal max — device memory
//                 bounds the usable window, and a live engine value wins.
/** @type {Readonly<Record<string, number>>} */
export const DEFAULT_CONTEXT_WINDOWS = Object.freeze({
  // ---- Anthropic (native adapter) — 1M default on the 4.6+ Opus/Sonnet line ----
  'claude-opus-4-8':            1_000_000,
  'claude-opus-4-7':            1_000_000,
  'claude-opus-4-6':            1_000_000,
  'claude-sonnet-4-6':          1_000_000,
  'claude-haiku-4-5-20251001':    200_000,
  'claude-haiku-4-5':             200_000,

  // ---- OpenRouter (`vendor/model`) ----
  'openai/gpt-4o':                      128_000,
  'openai/gpt-4o-mini':                 128_000,
  'anthropic/claude-sonnet-4-6':      1_000_000,
  'anthropic/claude-haiku-4.5':         200_000,
  'google/gemini-2.0-flash':          1_048_576,
  'meta-llama/llama-3.3-70b-instruct':  131_072,

  // ---- Ollama (local; nominal maxima — live num_ctx wins) ----
  'qwen3:32b': 32_768,
  'qwen3:14b': 32_768,
  'qwen3:8b':  32_768,
  'qwen3:4b':  32_768,

  // ---- Local WebGPU (on-device; canonical value in MODEL_SPECS) ----
  'gemma-4-e2b': 32_768,
});

/**
 * Resolve the context window for a model id. Resolution order, first hit
 * wins: user override → live value (provider-reported) → built-in table.
 * Returns `{ window, known: false }` (window = DEFAULT_CONTEXT_WINDOW) when
 * nothing matched, so the caller can choose to skip the token trigger.
 *
 * @param {string} model
 * @param {Object} [opts]
 * @param {Record<string, number>} [opts.overrides]
 *   User-supplied windows keyed by model id (Settings, persisted locally).
 *   The escape hatch for table drift and for non-default Ollama num_ctx.
 * @param {number} [opts.live]
 *   A window the provider reported for THIS model (OpenRouter
 *   context_length / Ollama num_ctx), if the caller fetched one. Wins over
 *   the static table but not over an explicit user override.
 * @returns {ContextWindow}
 */
export const resolveContextWindow = (model, opts = {}) => {
  const { overrides, live } = opts;
  const ovr = overrides?.[model];
  if (typeof ovr === 'number' && Number.isFinite(ovr) && ovr > 0) {
    return { window: Math.floor(ovr), known: true };
  }
  if (typeof live === 'number' && Number.isFinite(live) && live > 0) {
    return { window: Math.floor(live), known: true };
  }
  const base = DEFAULT_CONTEXT_WINDOWS[model];
  if (typeof base === 'number') return { window: base, known: true };
  return { window: DEFAULT_CONTEXT_WINDOW, known: false };
};

/**
 * Convenience: the resolved window number, or null when unknown.
 * @param {string} model
 * @param {{ overrides?: Record<string, number>, live?: number }} [opts]
 * @returns {number | null}
 */
export const contextWindowFor = (model, opts) => {
  const { window, known } = resolveContextWindow(model, opts);
  return known ? window : null;
};
