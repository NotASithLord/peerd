// Pure-logic coverage for the Anthropic body builder: the model-keyed
// thinking shape and the empty-system omission. The in-browser suite
// (extension/tests/unit/peerd-provider/to-anthropic.test.js) carries
// the same expectations; this file makes them terminal-runnable.

import { describe, test, expect } from 'bun:test';
import {
  toAnthropicBody,
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

  test('explicit maxTokens still wins (the subagent output cap path)', () => {
    const body = toAnthropicBody({
      model: 'claude-opus-4-8', system: 's', messages: [userMsg('hi')], maxTokens: 2000,
    });
    expect(body.max_tokens).toBe(2000);
  });

  test('reasoning.effort passes through as output_config.effort', () => {
    const body = toAnthropicBody({
      model: 'claude-opus-4-8', system: 's', messages: [userMsg('hi')],
      reasoning: { enabled: true, effort: 'medium' },
    });
    expect(body.output_config).toEqual({ effort: 'medium' });
  });

  test('no output_config when effort is absent (platform default = high)', () => {
    const body = toAnthropicBody({ model: 'claude-opus-4-8', system: 's', messages: [userMsg('hi')] });
    expect('output_config' in body).toBe(false);
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
