// Design 5 — the pure core of peerd.provider.call. Pins the TEXT-ONLY refusal
// matrix (tools/streaming can never erode in one silently-ignored key), the
// per-run quota arithmetic, and the provider-event fold — all browserless.

import { describe, test, expect } from 'bun:test';
import {
  validateProviderCallArgs, providerQuotaError, foldProviderEvents,
  ProviderCallError, ProviderQuotaError,
  PROVIDER_RUN_MAX_CALLS, PROVIDER_RUN_MAX_OUTPUT_TOKENS,
  PROVIDER_CALL_MAX_TOKENS, PROVIDER_CALL_DEFAULT_MAX_TOKENS,
  PROVIDER_CALL_MAX_INPUT_CHARS,
} from '../../extension/peerd-runtime/actor/provider-call-api.js';

describe('validateProviderCallArgs — the text-only surface', () => {
  test('prompt normalizes to a one-message user turn with the default maxTokens', () => {
    expect(validateProviderCallArgs({ prompt: 'classify this' })).toEqual({
      messages: [{ role: 'user', content: 'classify this' }],
      maxTokens: PROVIDER_CALL_DEFAULT_MAX_TOKENS,
    });
  });

  test('messages pass through validated; system and model ride along', () => {
    const out = validateProviderCallArgs({
      system: 'be terse',
      messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }],
      model: 'some-model', maxTokens: 99,
    });
    expect(out.system).toBe('be terse');
    expect(out.model).toBe('some-model');
    expect(out.maxTokens).toBe(99);
    expect(out.messages.length).toBe(3);
  });

  test('exactly one of prompt/messages — both or neither refuse', () => {
    expect(() => validateProviderCallArgs({})).toThrow(ProviderCallError);
    expect(() => validateProviderCallArgs({ prompt: 'x', messages: [{ role: 'user', content: 'y' }] })).toThrow(ProviderCallError);
  });

  test('tools/stream/thinking — any unknown key — is refused BY NAME', () => {
    for (const bad of [{ tools: [] }, { stream: true }, { thinking: { budget: 1 } }, { tool_choice: 'auto' }]) {
      const key = Object.keys(bad)[0];
      expect(() => validateProviderCallArgs({ prompt: 'x', ...bad })).toThrow(key);
    }
  });

  test('non-string message content (block arrays = tool_result/image lane) is refused', () => {
    expect(() => validateProviderCallArgs({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }))
      .toThrow(ProviderCallError);
    expect(() => validateProviderCallArgs({ messages: [{ role: 'tool', content: 'x' }] })).toThrow(ProviderCallError);
    expect(() => validateProviderCallArgs({ messages: [] })).toThrow(ProviderCallError);
  });

  test('maxTokens clamps to the per-call cap; bad values refuse', () => {
    expect(validateProviderCallArgs({ prompt: 'x', maxTokens: 10_000_000 }).maxTokens).toBe(PROVIDER_CALL_MAX_TOKENS);
    expect(() => validateProviderCallArgs({ prompt: 'x', maxTokens: 0 })).toThrow(ProviderCallError);
    expect(() => validateProviderCallArgs({ prompt: 'x', maxTokens: '5' })).toThrow(ProviderCallError);
  });

  test('non-object args refuse', () => {
    for (const bad of [null, undefined, 'hi', 7, ['x']]) {
      expect(() => validateProviderCallArgs(bad)).toThrow(ProviderCallError);
    }
  });

  test('oversized input (system + messages) is refused — input spend is bounded too', () => {
    const big = 'x'.repeat(PROVIDER_CALL_MAX_INPUT_CHARS + 1);
    expect(() => validateProviderCallArgs({ prompt: big })).toThrow(ProviderCallError);
    expect(() => validateProviderCallArgs({ system: big, prompt: 'y' })).toThrow('input too large');
    // at the cap exactly → accepted
    expect(validateProviderCallArgs({ prompt: 'x'.repeat(PROVIDER_CALL_MAX_INPUT_CHARS) }).messages.length).toBe(1);
  });
});

describe('providerQuotaError — per-run ceilings', () => {
  test('under both ceilings → null (the run may call again)', () => {
    expect(providerQuotaError({ calls: 0, outputTokens: 0 })).toBe(null);
    expect(providerQuotaError({ calls: PROVIDER_RUN_MAX_CALLS - 1, outputTokens: PROVIDER_RUN_MAX_OUTPUT_TOKENS - 1 })).toBe(null);
    expect(providerQuotaError(undefined)).toBe(null);
  });

  test('at the call ceiling → a catchable ProviderQuotaError, message says which', () => {
    const err = providerQuotaError({ calls: PROVIDER_RUN_MAX_CALLS, outputTokens: 0 });
    expect(err).toBeInstanceOf(ProviderQuotaError);
    expect(err?.message).toContain('provider quota exceeded');
    expect(err?.message).toContain(String(PROVIDER_RUN_MAX_CALLS));
  });

  test('at the token ceiling → refused with the token message', () => {
    const err = providerQuotaError({ calls: 1, outputTokens: PROVIDER_RUN_MAX_OUTPUT_TOKENS });
    expect(err).toBeInstanceOf(ProviderQuotaError);
    expect(err?.message).toContain(String(PROVIDER_RUN_MAX_OUTPUT_TOKENS));
  });
});

describe('foldProviderEvents — text/usage/error out of a drained stream', () => {
  test('text deltas concatenate; usage events SUM; stopReason surfaces', () => {
    const folded = foldProviderEvents([
      { type: 'text-delta', text: 'hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } },
      { type: 'message-stop', stopReason: 'end_turn' },
    ]);
    expect(folded.text).toBe('hello');
    expect(folded.usage).toEqual({ inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 4 });
    expect(folded.stopReason).toBe('end_turn');
    expect(folded.error).toBeUndefined();
  });

  test('the FIRST error wins and rides alongside any billed usage', () => {
    const folded = foldProviderEvents([
      { type: 'usage', usage: { inputTokens: 9, outputTokens: 1 } },
      { type: 'error', error: 'overloaded' },
      { type: 'error', error: 'later noise' },
    ]);
    expect(folded.error).toBe('overloaded');
    expect(folded.usage?.inputTokens).toBe(9);
  });

  test('reasoning/tool events are ignored (a text-only call never trusts them)', () => {
    const folded = foldProviderEvents([
      { type: 'reasoning-delta', text: 'hmm' },
      { type: 'tool-use-start' } as any,
      { type: 'text-delta', text: 'answer' },
    ]);
    expect(folded.text).toBe('answer');
    expect(folded.usage).toBe(null);
  });
});
