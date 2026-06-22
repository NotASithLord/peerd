import { describe, test, expect } from 'bun:test';
import { toOpenAiBody, _toOpenAiMessagesForTests } from '../../extension/peerd-provider/format/to-openai.js';
import { fromOpenAiStream } from '../../extension/peerd-provider/format/from-openai.js';

// why: to-openai.js declares its returns loosely (`object[]` / `object`)
// and exports no wire-shape typedef, so the assertions below cast to the
// OpenAI message shape its header comment documents.
type OpenAiMsg = {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
};

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
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
};

describe('to-openai message mapping', () => {
  test('system prompt becomes a system message', () => {
    const msgs = _toOpenAiMessagesForTests('SYS', [
      { role: 'user', content: 'hi', id: '1', when: 0 },
    ]);
    expect(msgs[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'hi' });
  });

  test('assistant tool_uses become tool_calls with stringified args', () => {
    const msgs = _toOpenAiMessagesForTests('', [
      {
        role: 'assistant', content: 'ok', id: '1', when: 0,
        toolUses: [{ id: 'call_1', name: 'click', input: { selector: '#go' } }],
      },
      {
        role: 'user', content: '', id: '2', when: 0,
        toolResults: [{ tool_use_id: 'call_1', content: '{"ok":true}' }],
      },
    ]) as OpenAiMsg[];
    const asst = msgs.find((m) => m.role === 'assistant');
    if (!asst?.tool_calls) throw new Error('expected assistant message with tool_calls');
    expect(asst.tool_calls[0].id).toBe('call_1');
    expect(asst.tool_calls[0].function.name).toBe('click');
    expect(asst.tool_calls[0].function.arguments).toBe('{"selector":"#go"}');
    const tool = msgs.find((m) => m.role === 'tool');
    if (!tool) throw new Error('expected tool message');
    expect(tool.tool_call_id).toBe('call_1');
  });

  test('orphan tool_calls get a synthesized tool message', () => {
    const msgs = _toOpenAiMessagesForTests('', [
      {
        role: 'assistant', content: '', id: '1', when: 0,
        toolUses: [{ id: 'call_x', name: 'navigate', input: {} }],
      },
      // No tool result follows (interrupted turn).
    ]) as OpenAiMsg[];
    const tool = msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'call_x');
    expect(tool).toBeTruthy();
    if (!tool) throw new Error('expected synthesized tool message');
    expect(tool.content).toContain('did not complete');
  });

  test('toOpenAiBody emits tools + tool_choice when tools provided', () => {
    const body = toOpenAiBody({
      model: 'm', system: 'S', messages: [],
      tools: [{ name: 'click', description: 'd', schema: { type: 'object' } }],
    }) as Record<string, any>;
    expect(body.stream).toBe(true);
    expect(body.tools[0].type).toBe('function');
    expect(body.tools[0].function.name).toBe('click');
    expect(body.tool_choice).toBe('auto');
  });
});

describe('from-openai stream parsing', () => {
  test('text deltas and end_turn stop', async () => {
    const evs = await drain(fromOpenAiStream(streamOf([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ])));
    const text = evs.filter((e) => e.type === 'text-delta').map((e) => e.text).join('');
    expect(text).toBe('Hello');
    const stop = evs.find((e) => e.type === 'message-stop');
    expect(stop.stopReason).toBe('end_turn');
  });

  test('tool call streams start/delta/stop and tool_use stop reason', async () => {
    const evs = await drain(fromOpenAiStream(streamOf([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"click","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"selector\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"#go\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ])));
    const start = evs.find((e) => e.type === 'tool-use-start');
    expect(start).toEqual({ type: 'tool-use-start', id: 'call_1', name: 'click' });
    const args = evs.filter((e) => e.type === 'tool-use-delta').map((e) => e.partialJson).join('');
    expect(args).toBe('{"selector":"#go"}');
    expect(evs.some((e) => e.type === 'tool-use-stop' && e.id === 'call_1')).toBe(true);
    const stop = evs.find((e) => e.type === 'message-stop');
    expect(stop.stopReason).toBe('tool_use');
  });

  test('argument fragments arriving BEFORE id+name are buffered, not dropped', async () => {
    // Some OpenAI-compatible providers stream argument fragments for an
    // index before the chunk that carries its id and function name. The
    // pre-start fragments must be flushed once the call starts —
    // otherwise the parsed tool input is truncated at the head.
    const evs = await drain(fromOpenAiStream(streamOf([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"sel"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ector\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"click"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"#go\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ])));
    const start = evs.find((e) => e.type === 'tool-use-start');
    expect(start).toEqual({ type: 'tool-use-start', id: 'call_9', name: 'click' });
    // The buffered fragments flush immediately after the start event,
    // before any post-start delta.
    const args = evs.filter((e) => e.type === 'tool-use-delta').map((e) => e.partialJson).join('');
    expect(args).toBe('{"selector":"#go"}');
    expect(evs.indexOf(start)).toBeLessThan(evs.findIndex((e) => e.type === 'tool-use-delta'));
    expect(evs.some((e) => e.type === 'tool-use-stop' && e.id === 'call_9')).toBe(true);
  });

  test('error payload surfaces an error event', async () => {
    const evs = await drain(fromOpenAiStream(streamOf([
      'data: {"error":{"message":"bad model"}}\n\n',
      'data: [DONE]\n\n',
    ])));
    expect(evs.some((e) => e.type === 'error' && /bad model/.test(e.error))).toBe(true);
  });

  test('stream that ends without finish_reason reports incomplete', async () => {
    const evs = await drain(fromOpenAiStream(streamOf([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    ])));
    const stop = evs.find((e) => e.type === 'message-stop');
    expect(stop.stopReason).toBe('incomplete');
  });
});
