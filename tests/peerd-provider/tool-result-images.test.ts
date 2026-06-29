// Wire shape for tool results that carry vision blocks (the `view` screenshot
// tool sets ToolResultBlock.images). Anthropic renders them as image blocks
// INSIDE the tool_result content; OpenAI's tool role takes string content only,
// so the pixels ride a follow-on user message AFTER every tool message (the
// tool replies to a tool_calls turn must stay contiguous).

import { describe, test, expect } from 'bun:test';
import { toAnthropicMessages } from '../../extension/peerd-provider/format/to-anthropic.js';
import { _toOpenAiMessagesForTests } from '../../extension/peerd-provider/format/to-openai.js';
import type { InternalMessage } from '../../extension/peerd-provider/types.js';

const img = { mediaType: 'image/png', data: 'aW1n' };

// An assistant turn that called `view`, then the tool-result carrying the image.
const seq = (images?: any[]): InternalMessage[] => [
  { role: 'assistant', content: '', id: 'a1', when: 0, toolUses: [{ id: 't1', name: 'view', input: {} }] },
  {
    role: 'user', content: '', id: 'u1', when: 1,
    toolResults: [{ tool_use_id: 't1', content: '{"captured":true}', ...(images ? { images } : {}) }],
  },
];

const trBlock = (wire: any[]) =>
  wire.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b: any) => b.type === 'tool_result');

describe('tool-result images — Anthropic', () => {
  test('a tool result with images renders tool_result content as [text, image] blocks', () => {
    const tr = trBlock(toAnthropicMessages(seq([img])));
    expect(tr).toBeTruthy();
    expect(Array.isArray(tr.content)).toBe(true);
    expect(tr.content[0]).toMatchObject({ type: 'text', text: '{"captured":true}' });
    expect(tr.content[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aW1n' },
    });
  });

  test('without images, tool_result content stays a string (unchanged)', () => {
    expect(trBlock(toAnthropicMessages(seq())).content).toBe('{"captured":true}');
  });

  test('images with empty content emit image blocks only (no empty text block)', () => {
    const wire = toAnthropicMessages([
      { role: 'assistant', content: '', id: 'a1', when: 0, toolUses: [{ id: 't1', name: 'view', input: {} }] },
      { role: 'user', content: '', id: 'u1', when: 1, toolResults: [{ tool_use_id: 't1', content: '', images: [img] }] },
    ]);
    expect(trBlock(wire).content.map((b: any) => b.type)).toEqual(['image']);
  });
});

describe('tool-result images — OpenAI', () => {
  test('a tool result with images emits a string tool message then a follow-on user image message', () => {
    const wire = _toOpenAiMessagesForTests('s', seq([img]));
    const toolIdx = wire.findIndex((m: any) => m.role === 'tool' && m.tool_call_id === 't1');
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(typeof wire[toolIdx].content).toBe('string');
    const userImg = wire.slice(toolIdx + 1).find((m: any) => m.role === 'user' && Array.isArray(m.content));
    expect(userImg).toBeTruthy();
    expect((userImg as any).content.some(
      (p: any) => p.type === 'image_url' && p.image_url.url === 'data:image/png;base64,aW1n',
    )).toBe(true);
  });

  test('without images, no extra user message is emitted', () => {
    const wire = _toOpenAiMessagesForTests('s', seq());
    expect(wire.filter((m: any) => m.role === 'user' && Array.isArray(m.content)).length).toBe(0);
  });

  test('tool messages stay contiguous: both precede the follow-on image user message', () => {
    const wire = _toOpenAiMessagesForTests('s', [
      {
        role: 'assistant', content: '', id: 'a1', when: 0,
        toolUses: [{ id: 't1', name: 'view', input: {} }, { id: 't2', name: 'read_page', input: {} }],
      },
      {
        role: 'user', content: '', id: 'u1', when: 1,
        toolResults: [
          { tool_use_id: 't1', content: '{"captured":true}', images: [img] },
          { tool_use_id: 't2', content: 'page text' },
        ],
      },
    ]);
    const t1 = wire.findIndex((m: any) => m.role === 'tool' && m.tool_call_id === 't1');
    const t2 = wire.findIndex((m: any) => m.role === 'tool' && m.tool_call_id === 't2');
    const userImg = wire.findIndex((m: any) => m.role === 'user' && Array.isArray(m.content));
    expect(t1).toBeGreaterThanOrEqual(0);
    expect(t2).toBeGreaterThan(t1);
    expect(userImg).toBeGreaterThan(t2);
  });
});
