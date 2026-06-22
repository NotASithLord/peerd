// @ts-check
// Internal → Anthropic body shape tests.

import { describe, it, expect } from '../../framework.js';
import {
  toAnthropicBody,
  toAnthropicMessages,
  usesAdaptiveThinking,
} from '/peerd-provider/format/to-anthropic.js';

/** @typedef {import('/peerd-provider/types.js').InternalMessage} InternalMessage */
/** @typedef {import('/peerd-provider/types.js').UserMessage} UserMessage */
/** @typedef {import('/peerd-provider/types.js').AssistantMessage} AssistantMessage */
/** @typedef {import('/peerd-provider/format/to-anthropic.js').AnthropicMessage} AnthropicMessage */
/** @typedef {import('/peerd-provider/format/to-anthropic.js').AnthropicBlock} AnthropicBlock */

/** @param {string} content @returns {UserMessage} */
const userMsg = (content) => ({ role: 'user', content, id: 'u', when: 0 });
/** @param {string} content @returns {AssistantMessage} */
const asstMsg = (content) => ({ role: 'assistant', content, id: 'a', when: 0 });

describe('to-anthropic', () => {
  describe('toAnthropicMessages', () => {
    it('preserves alternating user/assistant order', () => {
      const out = toAnthropicMessages([
        userMsg('hi'), asstMsg('hello'), userMsg('how are you'),
      ]);
      expect(out).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'how are you' },
      ]);
    });

    it('collapses adjacent same-role messages defensively', () => {
      const out = toAnthropicMessages([
        userMsg('first'), userMsg('second'),
      ]);
      expect(out).toEqual([{ role: 'user', content: 'first\n\nsecond' }]);
    });

    it('drops non-string content', () => {
      const out = toAnthropicMessages([
        userMsg('ok'),
        // Deliberately-malformed: non-string content is dropped by the
        // converter. Cast via unknown past the InternalMessage contract
        // (the shapes don't overlap) to exercise the defensive path.
        /** @type {InternalMessage} */ (/** @type {unknown} */ ({ role: 'user', content: { type: 'image' }, id: 'x', when: 0 })),
      ]);
      expect(out).toEqual([{ role: 'user', content: 'ok' }]);
    });
  });

  describe('toAnthropicBody', () => {
    it('builds the streaming body with the right top-level fields', () => {
      const body = toAnthropicBody({
        model: 'claude-sonnet-4-6',
        system: 'sys',
        messages: [userMsg('hi')],
      });
      expect(body).toEqual({
        model: 'claude-sonnet-4-6',
        max_tokens: 64000,
        // System is a single-block array with cache_control so the
        // system prompt is prompt-cached across turns.
        system: [
          { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
        ],
        // The last message gets its content wrapped into a text-block
        // array carrying cache_control so the entire prior conversation
        // is cached across turns. With only one message that means the
        // wrap converts 'hi' to a single text block with the breakpoint.
        messages: [{
          role: 'user',
          content: [{
            type: 'text',
            text: 'hi',
            cache_control: { type: 'ephemeral' },
          }],
        }],
        stream: true,
      });
    });

    it('includes tools in input_schema shape; caches the last tool', () => {
      const body = toAnthropicBody({
        model: 'm', system: 's', messages: [userMsg('hi')],
        tools: [
          { name: 't1', description: 'one', schema: { type: 'object' } },
          { name: 't2', description: 'two', schema: { type: 'object' } },
        ],
      });
      expect(body.tools).toEqual([
        { name: 't1', description: 'one', input_schema: { type: 'object' } },
        // Last tool gets the cache breakpoint, which Anthropic
        // interprets as "cache everything in this section up to here".
        { name: 't2', description: 'two', input_schema: { type: 'object' },
          cache_control: { type: 'ephemeral' } },
      ]);
    });

    it('omits tools field when no tools provided', () => {
      const body = toAnthropicBody({ model: 'm', system: 's', messages: [userMsg('hi')] });
      expect(body.tools).toBe(undefined);
    });

    it('puts a cache breakpoint on the last message of a multi-turn convo', () => {
      // Three turns of plain text. Earlier messages stay untouched;
      // only the last one carries cache_control.
      const body = toAnthropicBody({
        model: 'm', system: 's',
        messages: [
          userMsg('first'),
          { role: 'assistant', content: 'reply', id: 'a', when: 0 },
          userMsg('second'),
        ],
      });
      const msgs = body.messages;
      expect(msgs.length).toBe(3);
      // First two messages keep their plain-string content.
      expect(msgs[0].content).toBe('first');
      expect(msgs[1].content).toBe('reply');
      // Last message's content was wrapped into a block array so the
      // breakpoint can attach.
      expect(Array.isArray(msgs[2].content)).toBe(true);
      expect(msgs[2].content[0].cache_control).toEqual({ type: 'ephemeral' });
      expect(msgs[2].content[0].text).toBe('second');
    });

    it('omits the system field entirely when the system string is empty', () => {
      // why: Anthropic rejects empty text blocks, so system:'' must
      // drop the field (and its cache breakpoint) rather than emit
      // an empty block. The SW's 1-token provider key check sends
      // system:'' and 400s otherwise.
      const body = toAnthropicBody({ model: 'm', system: '', messages: [userMsg('hi')] });
      expect('system' in body).toBe(false);
    });

    it('omits the system field when the system string is whitespace-only', () => {
      const body = toAnthropicBody({ model: 'm', system: '  \n\t', messages: [userMsg('hi')] });
      expect('system' in body).toBe(false);
    });

    it('never emits an empty text block anywhere in the body', () => {
      const body = toAnthropicBody({ model: 'm', system: '', messages: [userMsg('hi')] });
      /** @type {AnthropicMessage[]} */
      const wireMessages = body.messages;
      const blocks = [
        ...(body.system ?? []),
        ...wireMessages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
      ];
      expect(blocks.some((b) => b?.type === 'text' && b.text === '')).toBe(false);
    });

    it('attaches the breakpoint to the last block of an array-content message', () => {
      // Last message carries tool_result blocks — already array shape,
      // breakpoint should land on the last block in place rather than
      // re-wrapping the message.
      const body = toAnthropicBody({
        model: 'm', system: 's',
        messages: [
          {
            role: 'user', content: '',
            toolResults: [
              { tool_use_id: 'a', content: 'first result' },
              { tool_use_id: 'b', content: 'second result' },
            ],
            id: 'u', when: 0,
          },
        ],
      });
      const last = body.messages[body.messages.length - 1];
      expect(Array.isArray(last.content)).toBe(true);
      expect(last.content.length).toBe(2);
      // Only the LAST tool_result block carries the breakpoint.
      expect(last.content[0].cache_control).toBe(undefined);
      expect(last.content[1].cache_control).toEqual({ type: 'ephemeral' });
    });
  });

  describe('reasoning (thinking) request shape', () => {
    const reasoning = { enabled: true, budgetTokens: 2048 };

    it('emits no thinking param when reasoning is off', () => {
      const body = toAnthropicBody({
        model: 'claude-sonnet-4-6', system: 's', messages: [userMsg('hi')],
      });
      expect(body.thinking).toBe(undefined);
    });

    it('uses the adaptive shape on 4.6+ models (enabled+budget 400s there)', () => {
      // Every current-generation Anthropic catalog entry that takes
      // adaptive — enabled+budget_tokens returns HTTP 400 on these.
      for (const model of ['claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-4-6']) {
        const body = toAnthropicBody({
          model, system: 's', messages: [userMsg('hi')], reasoning,
        });
        expect(body.thinking).toEqual({ type: 'adaptive' });
      }
    });

    it('keeps enabled+budget_tokens on pre-4.6 models', () => {
      // Haiku 4.5 (the dated catalog id) never learned the adaptive
      // shape — it still requires the legacy enabled+budget form.
      const body = toAnthropicBody({
        model: 'claude-haiku-4-5-20251001', system: 's', messages: [userMsg('hi')], reasoning,
      });
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    });

    it('lifts max_tokens for thinking headroom on both shapes', () => {
      for (const model of ['claude-opus-4-8', 'claude-haiku-4-5-20251001']) {
        const body = toAnthropicBody({
          model, system: 's', messages: [userMsg('hi')], maxTokens: 1024, reasoning,
        });
        // budget (2048) + 4096 answer headroom.
        expect(body.max_tokens).toBe(6144);
      }
    });

    it('usesAdaptiveThinking keys off version digits, ignoring date stamps', () => {
      expect(usesAdaptiveThinking('claude-opus-4-8')).toBe(true);
      expect(usesAdaptiveThinking('claude-sonnet-4-6')).toBe(true);
      expect(usesAdaptiveThinking('claude-fable-5')).toBe(true);
      expect(usesAdaptiveThinking('claude-haiku-4-5-20251001')).toBe(false);
      expect(usesAdaptiveThinking('claude-sonnet-4-5-20250929')).toBe(false);
      expect(usesAdaptiveThinking('claude-3-5-haiku')).toBe(false);
    });
  });

  describe('tool_use / tool_result block encoding', () => {
    it('assistant with toolUses encodes as block content', () => {
      const out = toAnthropicMessages([{
        role: 'assistant', content: 'I will check', id: 'a', when: 0,
        toolUses: [{ id: 'toolu_X', name: 'inspect_storage', input: { prefix: 'vault' } }],
      }]);
      // The tool_use is unpaired (no following tool_result), so the
      // orphan repair appends a synthetic error result — see the
      // "orphan tool_use repair" suite below for the dedicated tests.
      expect(out).toEqual([{
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will check' },
          { type: 'tool_use', id: 'toolu_X', name: 'inspect_storage', input: { prefix: 'vault' } },
        ],
      }, {
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: 'toolu_X',
          content: 'tool dispatch did not complete', is_error: true,
        }],
      }]);
    });

    it('assistant with only tool_use and no text uses block content', () => {
      const out = toAnthropicMessages([{
        role: 'assistant', content: '', id: 'a', when: 0,
        toolUses: [{ id: 't1', name: 'foo', input: {} }],
      }]);
      expect(out).toEqual([{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'foo', input: {} }],
      }, {
        // Synthesized by the orphan tool_use repair (unpaired at tail).
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: 't1',
          content: 'tool dispatch did not complete', is_error: true,
        }],
      }]);
    });

    it('user with toolResults encodes as tool_result blocks', () => {
      const out = toAnthropicMessages([{
        role: 'user', content: '', id: 'u', when: 0,
        toolResults: [
          { tool_use_id: 'toolu_X', content: '{"foo":1}' },
          { tool_use_id: 'toolu_Y', content: 'failed', is_error: true },
        ],
      }]);
      expect(out).toEqual([{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_X', content: '{"foo":1}' },
          { type: 'tool_result', tool_use_id: 'toolu_Y', content: 'failed', is_error: true },
        ],
      }]);
    });

    it('does NOT collapse block-content messages with adjacent plain-text', () => {
      const out = toAnthropicMessages([
        userMsg('first'),
        {
          role: 'user', content: '', id: 'u2', when: 0,
          toolResults: [{ tool_use_id: 't', content: 'r' }],
        },
        userMsg('second'),
      ]);
      // Three distinct messages — collapse only happens between plain strings.
      expect(out.length).toBe(3);
      expect(typeof out[0].content).toBe('string');
      expect(Array.isArray(out[1].content)).toBe(true);
      expect(typeof out[2].content).toBe('string');
    });
  });

  describe('orphan tool_use repair', () => {
    it('synthesizes a tool_result when an assistant tool_use is unpaired at the tail', () => {
      const out = toAnthropicMessages([
        userMsg('go'),
        {
          role: 'assistant', content: 'working', id: 'a1', when: 0,
          toolUses: [{ id: 'toolu_X', name: 'vm_boot', input: { cmd: 'ls' } }],
        },
        // no user follow-up — the orphan case
      ]);
      expect(out.length).toBe(3);
      expect(out[2].role).toBe('user');
      const blocks = /** @type {AnthropicBlock[]} */ (out[2].content);
      expect(Array.isArray(blocks)).toBe(true);
      expect(blocks[0].type).toBe('tool_result');
      expect(blocks[0].tool_use_id).toBe('toolu_X');
      expect(blocks[0].is_error).toBe(true);
    });

    it('merges synthetic results into an existing partial user message', () => {
      // Assistant called TWO tools; only one returned before the turn died.
      const out = toAnthropicMessages([
        {
          role: 'assistant', content: '', id: 'a1', when: 0,
          toolUses: [
            { id: 'toolu_A', name: 'vm_boot', input: {} },
            { id: 'toolu_B', name: 'vm_boot', input: {} },
          ],
        },
        {
          role: 'user', content: '', id: 'u1', when: 0,
          toolResults: [{ tool_use_id: 'toolu_A', content: 'ok' }],
        },
      ]);
      // Two messages out — the partial user message gets the orphan B repair
      // prepended to its real A result.
      expect(out.length).toBe(2);
      const blocks = /** @type {AnthropicBlock[]} */ (out[1].content);
      expect(blocks.length).toBe(2);
      expect(blocks[0].type).toBe('tool_result');
      expect(blocks[0].tool_use_id).toBe('toolu_B');
      expect(blocks[0].is_error).toBe(true);
      expect(blocks[1].tool_use_id).toBe('toolu_A');
    });

    it('is a no-op when every tool_use has a matching tool_result', () => {
      const out = toAnthropicMessages([
        {
          role: 'assistant', content: '', id: 'a1', when: 0,
          toolUses: [{ id: 'toolu_A', name: 'vm_boot', input: {} }],
        },
        {
          role: 'user', content: '', id: 'u1', when: 0,
          toolResults: [{ tool_use_id: 'toolu_A', content: 'ok' }],
        },
      ]);
      expect(out.length).toBe(2);
      const blocks = /** @type {AnthropicBlock[]} */ (out[1].content);
      expect(blocks.length).toBe(1);
      expect(blocks[0].is_error).toBe(undefined);
    });

    it('inserts a synthetic user message when the next message is the wrong role', () => {
      // Pathological: two assistant messages in a row, the first with an
      // orphan tool_use. We splice a repair between them so the API
      // stays happy.
      const out = toAnthropicMessages([
        {
          role: 'assistant', content: '', id: 'a1', when: 0,
          toolUses: [{ id: 'toolu_X', name: 'vm_boot', input: {} }],
        },
        { role: 'assistant', content: 'huh', id: 'a2', when: 0 },
      ]);
      expect(out.length).toBe(3);
      expect(out[0].role).toBe('assistant');
      expect(out[1].role).toBe('user');
      const blocks = /** @type {AnthropicBlock[]} */ (out[1].content);
      expect(blocks[0].tool_use_id).toBe('toolu_X');
      expect(out[2].role).toBe('assistant');
    });
  });
});
