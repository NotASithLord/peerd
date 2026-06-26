// from-anthropic robustness: a (prompt-injected/adversarial) model can emit a
// tool_use content block with a valid id but a missing/non-string name. The
// block must still START so the loop tracks the id — otherwise its later
// deltas/stop reference a call the loop never saw and the tool call VANISHES
// silently on a tool_use stop. With a start emitted (sentinel name), dispatch
// surfaces it as an unknown-tool error instead of a lost action.

import { describe, test, expect } from 'bun:test';
import { fromAnthropicStream } from '../../extension/peerd-provider/format/from-anthropic.js';

const enc = new TextEncoder();
const sse = (events: Array<{ event: string; data: any }>) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('')));
      c.close();
    },
  });

const collect = async (gen: AsyncGenerator<any>) => {
  const out: any[] = [];
  for await (const e of gen) out.push(e);
  return out;
};

describe('from-anthropic — malformed tool_use name', () => {
  test('a tool_use block with a non-string name still STARTS (so the call surfaces, not vanishes)', async () => {
    const stream = sse([
      { event: 'message_start', data: { type: 'message_start', message: { role: 'assistant' } } },
      // tool_use with an id but NO name
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);

    const events = await collect(fromAnthropicStream(stream));

    const start = events.find((e) => e.type === 'tool-use-start' && e.id === 'toolu_1');
    expect(start).toBeTruthy();
    expect(start.name).toBe('__malformed_tool_name__');
    // the id is fully tracked (delta + stop both reference a STARTED call).
    expect(events.some((e) => e.type === 'tool-use-stop' && e.id === 'toolu_1')).toBe(true);
  });

  test('a well-formed tool_use still starts with its real name', async () => {
    const stream = sse([
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_2', name: 'get' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const events = await collect(fromAnthropicStream(stream));
    expect(events.find((e) => e.type === 'tool-use-start' && e.id === 'toolu_2')?.name).toBe('get');
  });
});
