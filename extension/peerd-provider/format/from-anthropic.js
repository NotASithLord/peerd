// @ts-check
// Anthropic SSE event stream → internal provider event stream.
//
// Anthropic emits a sequence of named SSE events during streaming. We
// translate them into a small internal union the agent loop consumes.
// The internal union (V1):
//
//   { type: 'text-delta', text: string }
//   { type: 'reasoning-delta', text: string }
//   { type: 'reasoning-stop', text?, signature?, data?, redacted? }
//   { type: 'tool-use-start', id: string, name: string }
//   { type: 'tool-use-delta', id: string, partialJson: string }
//   { type: 'tool-use-stop',  id: string }
//   { type: 'usage',          usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } }
//   { type: 'message-stop',   stopReason?: string }
//   { type: 'error',          error: string }
//
// Reasoning (Anthropic "extended thinking"): when the request enables
// thinking, the model streams a `thinking` content block BEFORE its text
// / tool_use. It arrives as content_block_start(type:'thinking') →
// thinking_delta(s) → signature_delta → content_block_stop. We surface
// the running text as `reasoning-delta` (for live UI render) and emit a
// single `reasoning-stop` carrying the complete block + signature when
// the block closes. The signature is opaque but MUST be preserved and
// replayed on subsequent tool-use turns (see to-anthropic.js), so the
// loop captures it off the reasoning-stop event. `redacted_thinking`
// blocks (encrypted, no plaintext) are forwarded as a reasoning-stop
// with { redacted: true, data }.
//
// Why a separate translator and not "just yield the SSE events": the
// agent loop should not know which provider is on the other end of the
// wire. The translator is the seam where Anthropic specifics live and
// die. OpenAI / Ollama adapters will have their own translator yielding
// the same internal union.
//
// Reference (Anthropic streaming):
//   message_start             — session metadata
//   content_block_start       — a new block began (text OR tool_use)
//   content_block_delta       — text_delta OR input_json_delta
//   content_block_stop        — block ended
//   message_delta             — overall message metadata (stop_reason)
//   message_stop              — entire response complete
//   ping                      — keepalive; ignored
//   error                     — server-side error event
//
// Usage / token accounting (cost telemetry, feature 06): Anthropic splits
// usage across two events. `message_start` carries the prompt-side counts
// — input_tokens, cache_creation_input_tokens (cache WRITE), and
// cache_read_input_tokens (cache READ) — plus an initial output_tokens.
// `message_delta` carries the *final cumulative* output_tokens. We capture
// the prompt-side numbers at message_start, overwrite output_tokens from
// the last message_delta, and emit ONE `usage` event right before
// message-stop. Cost is computed downstream (peerd-provider/pricing.js)
// from a LOCAL pricing table — usage counts never leave the browser.

import { parseSSE } from './sse-parser.js';

/** @typedef {{ type: 'text-delta', text: string }
 *          | { type: 'reasoning-delta', text: string }
 *          | { type: 'reasoning-stop', text?: string, signature?: string, data?: string, redacted?: boolean }
 *          | { type: 'tool-use-start', id: string, name: string }
 *          | { type: 'tool-use-delta', id: string, partialJson: string }
 *          | { type: 'tool-use-stop',  id: string }
 *          | { type: 'usage',          usage: TokenUsage }
 *          | { type: 'message-stop',   stopReason?: string }
 *          | { type: 'error',          error: string }
 *          | { type: 'rate-limit-pause', retryAfterMs: number, attempt: number }} ProviderEvent
 *
 * Note: `rate-limit-pause` is emitted by the *adapter* (not this
 * translator) when a 429 / 529 response triggers a retry. It's in the
 * union because everything downstream of the adapter (agent loop,
 * side panel) consumes a single ProviderEvent stream regardless of
 * whether the event came from the SSE body or from the HTTP layer.
 *
 * @typedef {{ inputTokens: number, outputTokens: number,
 *             cacheReadTokens: number, cacheWriteTokens: number }} TokenUsage
 *   Normalized token counts, provider-agnostic. Cache fields are 0 for
 *   providers that don't report prompt caching. Dollar cost is NOT here —
 *   it's computed downstream from a local pricing table so the wire
 *   translators stay pure token-counters with no pricing knowledge.
 */

/**
 * Translate an Anthropic SSE body into our internal event stream.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<ProviderEvent>}
 */
export async function* fromAnthropicStream(body) {
  /** @type {string | undefined} */
  let stopReason;
  // Running token usage for this message. Prompt-side counts (input +
  // cache read/write) land once at message_start; output_tokens is
  // overwritten by the cumulative value from each message_delta. We emit
  // a single `usage` event right before message-stop. `usageSeen` guards
  // the emit so a stream with no usage block (shouldn't happen, but be
  // safe) doesn't push a meaningless all-zeros event.
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let usageSeen = false;
  // why: hoist the emit so both the real message_stop path and the
  // synthesized-stop fallback (truncated stream) report whatever usage we
  // managed to capture. A truncated stream still billed for its input.
  /** @returns {ProviderEvent | null} */
  const emitUsage = () => (usageSeen ? { type: 'usage', usage: { ...usage } } : null);
  // Track active content blocks by `index` so we know whether a delta
  // is text, tool input, or thinking. Thinking blocks accumulate their
  // text + signature here until content_block_stop flushes them as a
  // single reasoning-stop. Cleared on content_block_stop.
  /** @type {Map<number, { type: string, id?: string, name?: string, thinkingBuf?: string, signature?: string, data?: string }>} */
  const blocks = new Map();

  for await (const sse of parseSSE(body)) {
    let payload;
    try { payload = sse.data ? JSON.parse(sse.data) : null; }
    catch (e) {
      // why: JSON.parse only ever throws a SyntaxError (an Error), so reading
      // .message off the caught value is safe — the cast just tells TS that.
      yield { type: 'error', error: `malformed SSE payload: ${/** @type {Error} */ (e).message}` };
      return;
    }
    if (!payload) continue;

    switch (sse.event) {
      case 'content_block_start': {
        const cb = payload.content_block;
        if (cb && typeof payload.index === 'number') {
          blocks.set(payload.index, {
            type: cb.type,
            id: cb.id,
            name: cb.name,
            // why: redacted_thinking arrives whole (no deltas) — capture
            // its opaque `data` now so content_block_stop can flush it.
            ...(cb.type === 'redacted_thinking' ? { data: cb.data } : {}),
            ...(cb.type === 'thinking' ? { thinkingBuf: '', signature: '' } : {}),
          });
          if (cb.type === 'tool_use' && typeof cb.id === 'string' && typeof cb.name === 'string') {
            yield { type: 'tool-use-start', id: cb.id, name: cb.name };
          }
        }
        break;
      }
      case 'content_block_delta': {
        const block = blocks.get(payload.index);
        const delta = payload.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'text-delta', text: delta.text };
        } else if (delta?.type === 'thinking_delta' && block?.type === 'thinking') {
          const text = typeof delta.thinking === 'string' ? delta.thinking : '';
          block.thinkingBuf = (block.thinkingBuf ?? '') + text;
          if (text) yield { type: 'reasoning-delta', text };
        } else if (delta?.type === 'signature_delta' && block?.type === 'thinking') {
          // Accumulate the opaque signature; flushed on block stop.
          block.signature = (block.signature ?? '') + (typeof delta.signature === 'string' ? delta.signature : '');
        } else if (
          delta?.type === 'input_json_delta'
          && block?.type === 'tool_use'
          && typeof block.id === 'string'
        ) {
          yield {
            type: 'tool-use-delta',
            id: block.id,
            partialJson: typeof delta.partial_json === 'string' ? delta.partial_json : '',
          };
        }
        break;
      }
      case 'content_block_stop': {
        const block = blocks.get(payload.index);
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          yield { type: 'tool-use-stop', id: block.id };
        } else if (block?.type === 'thinking') {
          yield {
            type: 'reasoning-stop',
            text: block.thinkingBuf ?? '',
            signature: block.signature ?? '',
          };
        } else if (block?.type === 'redacted_thinking') {
          yield { type: 'reasoning-stop', redacted: true, data: block.data ?? '' };
        }
        blocks.delete(payload.index);
        break;
      }
      case 'message_delta': {
        const sr = payload.delta?.stop_reason;
        if (typeof sr === 'string') stopReason = sr;
        // why: message_delta carries the FINAL cumulative output_tokens.
        // Overwrite (not add) — it's a running total, not an increment.
        const u = payload.usage;
        if (u && typeof u.output_tokens === 'number') {
          usage.outputTokens = u.output_tokens;
          usageSeen = true;
        }
        break;
      }
      case 'message_stop': {
        const ue = emitUsage();
        if (ue) yield ue;
        yield { type: 'message-stop', stopReason };
        return;
      }
      case 'error': {
        const message = payload.error?.message ?? 'unknown server error';
        yield { type: 'error', error: message };
        return;
      }
      case 'message_start': {
        // Prompt-side token counts arrive here, once. cache_creation =
        // cache WRITE (you paid to populate the cache this turn);
        // cache_read = cache READ (served cheaply from a prior turn's
        // cached prefix). input_tokens is the NON-cached prompt tokens.
        const u = payload.message?.usage;
        if (u) {
          if (typeof u.input_tokens === 'number') usage.inputTokens = u.input_tokens;
          if (typeof u.cache_read_input_tokens === 'number') usage.cacheReadTokens = u.cache_read_input_tokens;
          if (typeof u.cache_creation_input_tokens === 'number') usage.cacheWriteTokens = u.cache_creation_input_tokens;
          if (typeof u.output_tokens === 'number') usage.outputTokens = u.output_tokens;
          usageSeen = true;
        }
        break;
      }
      case 'ping':
      default:
        // Nothing useful to surface. Forward-compatible with new event
        // types Anthropic may add.
        break;
    }
  }

  // Stream ended without a message_stop. Synthesize one so the loop
  // doesn't wait forever; mark stop reason as 'incomplete'. Still report
  // whatever usage we captured — a truncated stream was billed for input.
  const ue = emitUsage();
  if (ue) yield ue;
  yield { type: 'message-stop', stopReason: stopReason ?? 'incomplete' };
}
