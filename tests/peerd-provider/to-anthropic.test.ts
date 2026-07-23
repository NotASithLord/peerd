// Pure-logic coverage for the Anthropic body builder: the model-keyed
// thinking shape and the empty-system omission. The in-browser suite
// (extension/tests/unit/peerd-provider/to-anthropic.test.js) carries
// the same expectations; this file makes them terminal-runnable.

import { describe, test, expect } from 'bun:test';
import {
  toAnthropicBody,
  toAnthropicMessages,
  usesAdaptiveThinking,
} from '../../extension/peerd-provider/format/to-anthropic.js';
import type { InternalMessage } from '../../extension/peerd-provider/types.js';

const userMsg = (content: string): InternalMessage => ({ role: 'user', content, id: 'u', when: 0 });

describe('usesAdaptiveThinking — model-keyed thinking shape', () => {
  test('4.6+ era models take the adaptive shape', () => {
    // why: enabled+budget_tokens returns HTTP 400 on Opus 4.7+ and is
    // deprecated on the 4.6 family — adaptive is the only safe on-mode.
    expect(usesAdaptiveThinking('claude-opus-4-8')).toBe(true);
    expect(usesAdaptiveThinking('claude-opus-4-7')).toBe(true);
    expect(usesAdaptiveThinking('claude-opus-4-6')).toBe(true);
    expect(usesAdaptiveThinking('claude-sonnet-4-6')).toBe(true);
    expect(usesAdaptiveThinking('claude-fable-5')).toBe(true);
  });

  test('pre-4.6 models keep the legacy enabled+budget shape', () => {
    expect(usesAdaptiveThinking('claude-haiku-4-5-20251001')).toBe(false);
    expect(usesAdaptiveThinking('claude-haiku-4-5')).toBe(false);
    expect(usesAdaptiveThinking('claude-sonnet-4-5-20250929')).toBe(false);
    expect(usesAdaptiveThinking('claude-opus-4-1')).toBe(false);
    expect(usesAdaptiveThinking('claude-3-5-haiku')).toBe(false);
  });

  test('date stamps are not mistaken for minor versions', () => {
    // claude-haiku-4-5-20251001 → digits [4, 5, 20251001]; the date
    // group must not promote the model into the adaptive era.
    expect(usesAdaptiveThinking('claude-haiku-4-5-20251001')).toBe(false);
    expect(usesAdaptiveThinking('claude-sonnet-4-6-20260101')).toBe(true);
  });

  test('ids without parseable digits default to the modern shape', () => {
    expect(usesAdaptiveThinking('some-custom-model')).toBe(true);
  });
});

describe('toAnthropicBody — thinking param', () => {
  const reasoning = { enabled: true, budgetTokens: 2048 };

  test('adaptive shape for every current Anthropic catalog model that supports it', () => {
    for (const model of ['claude-opus-4-8', 'claude-sonnet-4-6']) {
      const body = toAnthropicBody({
        model, system: 's', messages: [userMsg('hi')], reasoning,
      });
      expect(body.thinking).toEqual({ type: 'adaptive' });
    }
  });

  test('enabled+budget retained for Haiku 4.5 (catalog dated id)', () => {
    const body = toAnthropicBody({
      model: 'claude-haiku-4-5-20251001', system: 's', messages: [userMsg('hi')], reasoning,
    });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  test('no thinking param when reasoning is off', () => {
    const body = toAnthropicBody({
      model: 'claude-opus-4-8', system: 's', messages: [userMsg('hi')],
    });
    expect(body.thinking).toBeUndefined();
  });

  test('max_tokens is lifted for thinking headroom on both shapes', () => {
    for (const model of ['claude-opus-4-8', 'claude-haiku-4-5-20251001']) {
      const body = toAnthropicBody({
        model, system: 's', messages: [userMsg('hi')], maxTokens: 1024, reasoning,
      });
      expect(body.max_tokens).toBe(2048 + 4096);
    }
  });
});

describe('toAnthropicBody — output ceiling + effort', () => {
  test('default max_tokens is 64000 — streaming-safe, thinking-proof', () => {
    // why this matters: peerd always streams, and adaptive thinking
    // draws from max_tokens with no budget knob. The old 4096 default
    // let hard prompts burn the whole ceiling on reasoning and stop at
    // max_tokens before any tool_use — the field 'silent timeout'.
    const body = toAnthropicBody({ model: 'claude-opus-4-8', system: 's', messages: [userMsg('hi')] });
    expect(body.max_tokens).toBe(64000);
  });

  test('explicit maxTokens still wins (the actor output cap path)', () => {
    const body = toAnthropicBody({
      model: 'claude-opus-4-8', system: 's', messages: [userMsg('hi')], maxTokens: 2000,
    });
    expect(body.max_tokens).toBe(2000);
  });

  test('reasoning.effort passes through as output_config.effort (adaptive models)', () => {
    const body = toAnthropicBody({
      model: 'claude-opus-4-8', system: 's', messages: [userMsg('hi')],
      reasoning: { enabled: true, effort: 'medium' },
    });
    expect(body.output_config).toEqual({ effort: 'medium' });
  });

  test('effort is OMITTED on pre-4.6 models — they 400 on output_config.effort', () => {
    // Regression: peerd sent output_config.effort to EVERY model, and Haiku 4.5
    // (pre-4.6) rejects it ("This model does not support the effort parameter"),
    // which failed every request with the default reasoningEffort='medium'. The
    // effort knob rides ONLY the adaptive shape (usesAdaptiveThinking).
    for (const model of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-3-5-sonnet']) {
      const body = toAnthropicBody({
        model, system: 's', messages: [userMsg('hi')],
        reasoning: { enabled: true, effort: 'medium' },
      });
      expect('output_config' in body).toBe(false);
      // ...and it still gets the legacy enabled+budget thinking shape.
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    }
  });

  test('no output_config when effort is absent (platform default = high)', () => {
    const body = toAnthropicBody({ model: 'claude-opus-4-8', system: 's', messages: [userMsg('hi')] });
    expect('output_config' in body).toBe(false);
  });
});

describe('toAnthropicMessages — orphan tool_result demotion', () => {
  // The field 400: "unexpected `tool_use_id` found in `tool_result` blocks.
  // Each `tool_result` block must have a corresponding `tool_use` block in
  // the previous message." A steer-live supersede let the old turn append
  // its tool results AFTER the new turn's messages; every later call then
  // replays the broken history and the session bricks. The wire repair must
  // demote the stranded result to text (payload preserved) so the request
  // stays structurally valid.
  const asst = (id: string, toolId: string): InternalMessage => ({
    role: 'assistant', content: '', id, when: 0,
    toolUses: [{ id: toolId, name: 'vm_boot', input: {} }],
  });

  const noOrphanResults = (out: Array<{ role: string, content: unknown }>) => {
    for (let i = 0; i < out.length; i++) {
      const content = out[i].content;
      if (!Array.isArray(content)) continue;
      const prev = out[i - 1] as any;
      const usable = new Set(
        prev?.role === 'assistant' && Array.isArray(prev.content)
          ? prev.content.filter((b: any) => b.type === 'tool_use').map((b: any) => b.id)
          : []);
      for (const b of content as any[]) {
        if (b.type === 'tool_result') expect(usable.has(b.tool_use_id)).toBe(true);
      }
    }
  };

  test('a tool_result stranded behind an interleaved user message is demoted to text', () => {
    const out = toAnthropicMessages([
      asst('a1', 'toolu_B'),
      userMsg('actually, do something else'),
      {
        role: 'user', content: '', id: 'u2', when: 0,
        toolResults: [{ tool_use_id: 'toolu_B', content: 'boot ok' }],
      },
    ]);
    noOrphanResults(out);
    const last = out[out.length - 1].content as any[];
    expect(last.some((b) => b.type === 'text' && /boot ok/.test(b.text))).toBe(true);
    expect(last.some((b) => b.type === 'tool_result')).toBe(false);
  });

  test('matched results survive; only the stale sibling is demoted, behind the lead results', () => {
    // assistant#1(B) → steer → assistant#2(A) → user(results B): the
    // tool_use repair prepends a synthetic result for A; the stale B
    // becomes trailing text. This is the exact "messages.N.content.1"
    // shape from the field report.
    const out = toAnthropicMessages([
      asst('a1', 'toolu_B'),
      userMsg('steer'),
      asst('a2', 'toolu_A'),
      {
        role: 'user', content: '', id: 'u2', when: 0,
        toolResults: [{ tool_use_id: 'toolu_B', content: 'late result' }],
      },
    ]);
    noOrphanResults(out);
    const last = out[out.length - 1].content as any[];
    const results = last.filter((b) => b.type === 'tool_result');
    expect(results.length).toBe(1);
    expect(results[0].tool_use_id).toBe('toolu_A');
    expect(last.indexOf(results[0])).toBe(0);
    expect(last.some((b) => b.type === 'text' && /late result/.test(b.text))).toBe(true);
  });

  test('a valid tool round is untouched', () => {
    const out = toAnthropicMessages([
      asst('a1', 'toolu_A'),
      {
        role: 'user', content: '', id: 'u1', when: 0,
        toolResults: [{ tool_use_id: 'toolu_A', content: 'ok' }],
      },
    ]);
    const last = out[out.length - 1].content as any[];
    expect(last).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_A', content: 'ok' }]);
  });
});

describe('toAnthropicBody — system prompt omission', () => {
  test('system:"" omits the field entirely (no empty text block)', () => {
    // why: Anthropic rejects empty text blocks; the SW provider key
    // check sends system:'' and must produce a body without `system`.
    const body = toAnthropicBody({ model: 'm', system: '', messages: [userMsg('hi')] });
    expect('system' in body).toBe(false);
  });

  test('whitespace-only system is treated as empty', () => {
    const body = toAnthropicBody({ model: 'm', system: ' \n\t ', messages: [userMsg('hi')] });
    expect('system' in body).toBe(false);
  });

  test('non-empty system keeps the cached single-block array form', () => {
    const body = toAnthropicBody({ model: 'm', system: 'sys', messages: [userMsg('hi')] });
    expect(body.system).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
  });

  test('no empty text block is ever emitted anywhere in the body', () => {
    const body = toAnthropicBody({ model: 'm', system: '', messages: [userMsg('hi')] });
    const blocks = [
      ...(body.system ?? []),
      ...body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])),
    ];
    expect(blocks.some((b: any) => b?.type === 'text' && b.text === '')).toBe(false);
  });
});
