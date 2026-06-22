// @ts-check
// OpenAI-compatible SSE stream → internal provider event stream.
//
// Yields the SAME ProviderEvent union as from-anthropic.js, so the agent
// loop is identical regardless of which provider is on the wire. Used by
// the OpenRouter adapter.
//
// OpenAI /chat/completions streaming shape (one JSON object per `data:`):
//   { choices: [{ delta: { content?: string,
//                          tool_calls?: [{ index, id?, type?,
//                                          function: { name?, arguments? } }] },
//                 finish_reason?: 'stop'|'tool_calls'|'length'|null }] }
// terminated by a literal `data: [DONE]` line.
//
// Tool calls stream incrementally and are keyed by `index` (NOT id — the
// id only appears in the first fragment for that index). We track each
// index, emit tool-use-start once id+name are known, tool-use-delta for
// argument fragments (fragments arriving BEFORE id+name are buffered and
// flushed on start, so argument bytes are never dropped), and
// tool-use-stop when the stream finishes.
//
// Usage / token accounting (cost telemetry, feature 06): with
// `stream_options.include_usage:true` (set in to-openai.js), the provider
// emits a FINAL chunk carrying a top-level `usage` object —
// { prompt_tokens, completion_tokens, total_tokens,
//   prompt_tokens_details:{ cached_tokens } }. That chunk's `choices` is
// usually empty, so we read usage independently of the choice loop and
// emit one normalized `usage` event before message-stop. cached_tokens
// (OpenRouter/OpenAI prompt caching) maps to cacheReadTokens; these
// providers don't separately bill a cache WRITE, so cacheWriteTokens=0.

import { parseSSE } from './sse-parser.js';

/** @typedef {import('./from-anthropic.js').ProviderEvent} ProviderEvent */
/** @typedef {import('./from-anthropic.js').TokenUsage} TokenUsage */

/**
 * Normalize an OpenAI-shaped `usage` object into our provider-agnostic
 * TokenUsage. cached_tokens (prompt caching) is REPORTED as part of
 * prompt_tokens by OpenAI, so we subtract it out to keep inputTokens =
 * "non-cached prompt tokens" — matching the Anthropic convention, so a
 * single pricing formula works for both providers.
 *
 * @param {any} u
 * @returns {TokenUsage}
 */
const normalizeUsage = (u) => {
  const cached = Number(u?.prompt_tokens_details?.cached_tokens) || 0;
  const prompt = Number(u?.prompt_tokens) || 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: Number(u?.completion_tokens) || 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
};

// Map OpenAI finish_reason to our internal stopReason vocabulary (the
// same strings from-anthropic emits, which the agent loop branches on).
/**
 * @param {string | null | undefined} finish
 * @returns {string | undefined}
 */
const mapStopReason = (finish) => {
  if (finish === 'tool_calls') return 'tool_use';
  if (finish === 'stop') return 'end_turn';
  if (finish === 'length') return 'max_tokens';
  return finish ?? undefined;
};

/**
 * Translate an OpenAI-compatible SSE body into our internal event stream.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {{ provider?: string }} [opts]
 *   `provider` labels in-stream error events so the UI names the right
 *   source (this parser is shared by OpenRouter AND Ollama).
 * @returns {AsyncGenerator<ProviderEvent>}
 */
export async function* fromOpenAiStream(body, { provider = 'openrouter' } = {}) {
  /** index → { id, name, started, pending } */
  const toolCalls = new Map();
  /** @type {string | undefined} */
  let stopReason;
  let finished = false;
  // why: defer the message-stop emit to stream end. With include_usage,
  // the provider sends the `usage` chunk AFTER the finish_reason chunk
  // (and before [DONE]). To emit `usage` before `message-stop` — the
  // order the agent loop expects so it can attribute usage to the message
  // it's about to finalize — we record finish_reason here and flush both
  // events once after the loop, rather than emitting stop inline.
  /** @type {TokenUsage | null} */
  let pendingUsage = null;

  for await (const sse of parseSSE(body)) {
    const data = sse.data?.trim();
    if (!data) continue;
    if (data === '[DONE]') break;

    let payload;
    try { payload = JSON.parse(data); }
    catch { continue; }  // keepalive / non-JSON noise

    if (payload.error) {
      const msg = payload.error?.message ?? JSON.stringify(payload.error);
      yield { type: 'error', error: `${provider}: ${msg}` };
      continue;
    }

    // Usage rides its own (usually choice-less) chunk near the end. Read
    // it independently of the choice loop below.
    if (payload.usage) pendingUsage = normalizeUsage(payload.usage);

    const choice = payload.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      yield { type: 'text-delta', text: delta.content };
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = toolCalls.get(idx);
        if (!entry) {
          entry = { id: tc.id ?? null, name: tc.function?.name ?? '', started: false, pending: '' };
          toolCalls.set(idx, entry);
        }
        // Backfill id / name if they only showed up after the first frag.
        if (!entry.id && tc.id) entry.id = tc.id;
        if (!entry.name && tc.function?.name) entry.name = tc.function.name;
        if (!entry.started && entry.id && entry.name) {
          entry.started = true;
          yield { type: 'tool-use-start', id: entry.id, name: entry.name };
          // why: some providers stream argument fragments BEFORE the
          // chunk that carries id+name for that index. Those landed in
          // `pending` below (a tool-use-delta can't be emitted without
          // an id to attribute it to); flush them now so no argument
          // bytes are lost.
          if (entry.pending) {
            yield { type: 'tool-use-delta', id: entry.id, partialJson: entry.pending };
            entry.pending = '';
          }
        }
        const frag = tc.function?.arguments;
        if (typeof frag === 'string' && frag.length > 0) {
          if (entry.started) {
            yield { type: 'tool-use-delta', id: entry.id, partialJson: frag };
          } else {
            entry.pending += frag;
          }
        }
      }
    }

    if (choice.finish_reason) {
      stopReason = mapStopReason(choice.finish_reason);
      // Close out any started tool calls before the message stop. The
      // message-stop itself is deferred (see pendingUsage) so the usage
      // chunk that follows finish_reason lands first.
      for (const entry of toolCalls.values()) {
        if (entry.started && entry.id) yield { type: 'tool-use-stop', id: entry.id };
      }
      finished = true;
    }
  }

  // Flush usage before the stop, in both the clean-finish and the
  // synthesized-fallback paths below. A truncated stream still billed for
  // its input, so report whatever usage we captured.
  if (finished) {
    if (pendingUsage) yield { type: 'usage', usage: pendingUsage };
    yield { type: 'message-stop', stopReason };
    return;
  }

  // why: if the stream closed without a finish_reason (dropped
  // connection / provider hiccup mid-tool-call), surface it as
  // 'incomplete' so the loop tags it the same way it does for a
  // truncated Anthropic stream and the next turn can repair/retry.
  for (const entry of toolCalls.values()) {
    if (entry.started && entry.id) yield { type: 'tool-use-stop', id: entry.id };
  }
  if (pendingUsage) yield { type: 'usage', usage: pendingUsage };
  yield { type: 'message-stop', stopReason: stopReason ?? 'incomplete' };
}
