// @ts-check
// Anthropic SSE → internal ProviderEvent translator tests.
//
// Coverage:
//   - text-delta extraction from content_block_delta
//   - message-stop with stop reason from message_delta + message_stop
//   - error events
//   - graceful synthesis of message-stop when stream ends cleanly
//     without one

import { describe, it, expect } from '../../framework.js';
import { fromAnthropicStream } from '/peerd-provider/format/from-anthropic.js';

/** @typedef {import('/peerd-provider/format/from-anthropic.js').ProviderEvent} ProviderEvent */

const enc = new TextEncoder();

/** @param {ReadonlyArray<string>} chunks */
const streamOf = (chunks) => new ReadableStream({
  start(controller) {
    for (const c of chunks) controller.enqueue(enc.encode(c));
    controller.close();
  },
});

/**
 * @param {string} event
 * @param {unknown} data
 */
const sse = (event, data) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** @param {AsyncGenerator<ProviderEvent>} gen */
const collect = async (gen) => {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
};

describe('from-anthropic', () => {
  it('yields text-delta events from content_block_delta', async () => {
    const body = streamOf([
      sse('message_start', { type: 'message_start' }),
      sse('content_block_start', { type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'Hello' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: ', world!' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('message_delta', { type: 'message_delta',
        delta: { stop_reason: 'end_turn' } }),
      sse('message_stop', { type: 'message_stop' }),
    ]);
    const events = await collect(fromAnthropicStream(body));
    expect(events).toEqual([
      { type: 'text-delta', text: 'Hello' },
      { type: 'text-delta', text: ', world!' },
      { type: 'message-stop', stopReason: 'end_turn' },
    ]);
  });

  it('translates an error event mid-stream', async () => {
    const body = streamOf([
      sse('message_start', { type: 'message_start' }),
      sse('error', { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }),
    ]);
    const events = await collect(fromAnthropicStream(body));
    expect(events).toEqual([{ type: 'error', error: 'overloaded' }]);
  });

  it('drops ping and unknown events silently', async () => {
    const body = streamOf([
      sse('ping', { type: 'ping' }),
      sse('content_block_delta', { type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hi' } }),
      sse('something_new_anthropic_added', { type: 'something_new' }),
      sse('message_stop', { type: 'message_stop' }),
    ]);
    const events = await collect(fromAnthropicStream(body));
    expect(events).toEqual([
      { type: 'text-delta', text: 'hi' },
      { type: 'message-stop', stopReason: undefined },
    ]);
  });

  it('synthesizes a message-stop when stream ends without one', async () => {
    const body = streamOf([
      sse('content_block_delta', { type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'partial' } }),
      // No message_stop — stream just closes.
    ]);
    const events = await collect(fromAnthropicStream(body));
    expect(events).toEqual([
      { type: 'text-delta', text: 'partial' },
      { type: 'message-stop', stopReason: 'incomplete' },
    ]);
  });

  describe('tool_use parsing', () => {
    it('emits tool-use-start, tool-use-delta(s), tool-use-stop', async () => {
      const body = streamOf([
        sse('message_start', { type: 'message_start' }),
        sse('content_block_start', { type: 'content_block_start', index: 0,
          content_block: { type: 'tool_use', id: 'toolu_X', name: 'inspect_storage', input: {} } }),
        sse('content_block_delta', { type: 'content_block_delta', index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"prefix":' } }),
        sse('content_block_delta', { type: 'content_block_delta', index: 0,
          delta: { type: 'input_json_delta', partial_json: ' "vault"}' } }),
        sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
        sse('message_stop', { type: 'message_stop' }),
      ]);
      const events = await collect(fromAnthropicStream(body));
      expect(events).toEqual([
        { type: 'tool-use-start', id: 'toolu_X', name: 'inspect_storage' },
        { type: 'tool-use-delta', id: 'toolu_X', partialJson: '{"prefix":' },
        { type: 'tool-use-delta', id: 'toolu_X', partialJson: ' "vault"}' },
        { type: 'tool-use-stop', id: 'toolu_X' },
        { type: 'message-stop', stopReason: 'tool_use' },
      ]);
    });

    it('interleaves text deltas and tool_use blocks correctly', async () => {
      const body = streamOf([
        sse('content_block_start', { type: 'content_block_start', index: 0,
          content_block: { type: 'text', text: '' } }),
        sse('content_block_delta', { type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: 'Checking' } }),
        sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
        sse('content_block_start', { type: 'content_block_start', index: 1,
          content_block: { type: 'tool_use', id: 't1', name: 'foo', input: {} } }),
        sse('content_block_delta', { type: 'content_block_delta', index: 1,
          delta: { type: 'input_json_delta', partial_json: '{}' } }),
        sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
        sse('message_stop', { type: 'message_stop' }),
      ]);
      const events = await collect(fromAnthropicStream(body));
      expect(events.map((e) => e.type)).toEqual([
        'text-delta', 'tool-use-start', 'tool-use-delta', 'tool-use-stop', 'message-stop',
      ]);
    });

    it('does NOT emit tool-use-delta for input_json_delta on a text block', async () => {
      // Defensive: if Anthropic ever sends a malformed event mixing
      // input_json_delta with a text block index, we shouldn't emit a
      // bogus tool-use-delta. The block-type check guards this.
      const body = streamOf([
        sse('content_block_start', { type: 'content_block_start', index: 0,
          content_block: { type: 'text', text: '' } }),
        sse('content_block_delta', { type: 'content_block_delta', index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' } }),
        sse('message_stop', { type: 'message_stop' }),
      ]);
      const events = await collect(fromAnthropicStream(body));
      expect(events.some((e) => e.type === 'tool-use-delta')).toBe(false);
    });
  });
});
