// Cost telemetry (feature 06) — usage parsed off the provider SSE streams.
//
// Covers BOTH translators emitting a normalized `usage` event:
//   - from-anthropic.js: input/cache at message_start, output at
//     message_delta, one usage event before message-stop.
//   - from-openai.js: usage in the final (choice-less) chunk, emitted
//     before message-stop; cached_tokens subtracted out of inputTokens.
// Plus the cost math against the local pricing table.

import { describe, test, expect } from 'bun:test';
import { fromAnthropicStream } from '../../extension/peerd-provider/format/from-anthropic.js';
import { fromOpenAiStream } from '../../extension/peerd-provider/format/from-openai.js';
import { costOf, resolvePricing, DEFAULT_PRICING } from '../../extension/peerd-provider/pricing.js';

const streamOf = (chunks: string[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
};

const drain = async (gen: AsyncGenerator<any>) => {
  const out: any[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};

// Build a named Anthropic SSE event chunk.
const sse = (event: string, data: object) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('from-anthropic usage extraction', () => {
  test('emits a usage event with input, output, and cache tokens before message-stop', async () => {
    const events = await drain(fromAnthropicStream(streamOf([
      sse('message_start', {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 1200,
            output_tokens: 3,
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 200,
          },
        },
      }),
      sse('content_block_start', { index: 0, content_block: { type: 'text' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hello' } }),
      sse('content_block_stop', { index: 0 }),
      // message_delta carries the FINAL cumulative output_tokens.
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 57 } }),
      sse('message_stop', { type: 'message_stop' }),
    ])));

    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toBeTruthy();
    expect(usage.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 57,           // overwritten by message_delta, not added
      cacheReadTokens: 800,
      cacheWriteTokens: 200,
    });

    // Ordering contract: usage MUST land before message-stop so the loop
    // can attribute it to the message it's about to finalize.
    const usageIdx = events.findIndex((e) => e.type === 'usage');
    const stopIdx = events.findIndex((e) => e.type === 'message-stop');
    expect(usageIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(usageIdx);
  });

  test('truncated stream (no message_stop) still reports captured usage', async () => {
    const events = await drain(fromAnthropicStream(streamOf([
      sse('message_start', { message: { usage: { input_tokens: 500, output_tokens: 0 } } }),
      sse('message_delta', { delta: {}, usage: { output_tokens: 12 } }),
      // stream ends here — no message_stop
    ])));
    const usage = events.find((e) => e.type === 'usage');
    expect(usage.usage.inputTokens).toBe(500);
    expect(usage.usage.outputTokens).toBe(12);
    // synthesized incomplete stop still fires, after usage
    const stop = events.find((e) => e.type === 'message-stop');
    expect(stop.stopReason).toBe('incomplete');
  });

  test('mid-stream error after message_start still reports the usage already billed', async () => {
    // Anthropic billed the prompt at message_start; a mid-stream `error` event
    // must flush that captured usage before the error so the cost meter records
    // it (mirrors the message_stop + truncated-stream paths). Without the flush,
    // a turn that errors after a large cached prompt silently undercounts.
    const events = await drain(fromAnthropicStream(streamOf([
      sse('message_start', {
        type: 'message_start',
        message: { usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 40000 } },
      }),
      sse('error', { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }),
    ])));

    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toBeTruthy();
    expect(usage.usage.inputTokens).toBe(12);
    expect(usage.usage.cacheReadTokens).toBe(40000);

    // usage MUST precede the error so it is attributed before the turn ends.
    const usageIdx = events.findIndex((e) => e.type === 'usage');
    const errIdx = events.findIndex((e) => e.type === 'error');
    expect(usageIdx).toBeGreaterThan(-1);
    expect(errIdx).toBeGreaterThan(usageIdx);
    expect(events[errIdx].error).toBe('overloaded');
  });
});

describe('from-openai/openrouter usage extraction', () => {
  test('emits a usage event from the final usage chunk, cached subtracted from input', async () => {
    const events = await drain(fromOpenAiStream(streamOf([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      // include_usage final chunk — choice-less, carries usage.
      `data: ${JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 250,
          total_tokens: 1250,
          prompt_tokens_details: { cached_tokens: 400 },
        },
      })}\n\n`,
      'data: [DONE]\n\n',
    ])));

    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toBeTruthy();
    expect(usage.usage).toEqual({
      inputTokens: 600,        // 1000 prompt - 400 cached
      outputTokens: 250,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,     // OpenAI/OpenRouter report no cache-write line
    });

    // usage before message-stop here too.
    const usageIdx = events.findIndex((e) => e.type === 'usage');
    const stopIdx = events.findIndex((e) => e.type === 'message-stop');
    expect(stopIdx).toBeGreaterThan(usageIdx);
  });

  test('usage chunk arriving AFTER finish_reason is still emitted before stop', async () => {
    // Real providers send finish_reason in one chunk and usage in the
    // NEXT. The translator must defer message-stop so usage leads it.
    const events = await drain(fromOpenAiStream(streamOf([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
      'data: [DONE]\n\n',
    ])));
    const types = events.map((e) => e.type);
    expect(types.indexOf('usage')).toBeLessThan(types.indexOf('message-stop'));
    const usage = events.find((e) => e.type === 'usage');
    expect(usage.usage.inputTokens).toBe(10);
    expect(usage.usage.outputTokens).toBe(5);
  });
});

describe('cost computed from the local pricing table', () => {
  test('prices a known Anthropic model across all four buckets', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    // sonnet-4-6: input 3, output 15, cacheRead 0.3, cacheWrite 3.75 per 1M
    const { cost, estimated } = costOf('claude-sonnet-4-6', usage);
    expect(estimated).toBe(true);
    expect(cost).toBeCloseTo(3 + 15 + 0.3 + 3.75, 6);
  });

  test('sub-cent precision on a cheap OpenRouter model', () => {
    // gpt-4o-mini: input 0.15/1M → 1000 input tokens = $0.00015
    const { cost } = costOf('openai/gpt-4o-mini', {
      inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(0.00015, 8);
  });

  test('unknown model returns estimated:false with zero cost (no misleading $0)', () => {
    const { cost, estimated } = costOf('some/unknown-model', {
      inputTokens: 5000, outputTokens: 5000, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    expect(cost).toBe(0);
    expect(estimated).toBe(false);
  });

  test('user override wins over the built-in rate', () => {
    const overrides = { 'claude-sonnet-4-6': { input: 99 } };
    const { rates, known } = resolvePricing('claude-sonnet-4-6', overrides);
    expect(known).toBe(true);
    expect(rates.input).toBe(99);                 // overridden
    expect(rates.output).toBe(DEFAULT_PRICING['claude-sonnet-4-6'].output); // default kept
    const { cost } = costOf('claude-sonnet-4-6', {
      inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }, overrides);
    expect(cost).toBeCloseTo(99, 6);
  });
});
