// Prompt-token estimation heuristic — char/4 + per-message overhead.

import { describe, test, expect } from 'bun:test';
import {
  estimateTextTokens, estimateMessageTokens, estimateMessagesTokens, CHARS_PER_TOKEN,
} from '../../../extension/peerd-runtime/loop/estimate.js';

describe('estimateTextTokens', () => {
  test('roughly chars / CHARS_PER_TOKEN', () => {
    expect(estimateTextTokens('x'.repeat(40))).toBe(Math.ceil(40 / CHARS_PER_TOKEN));
  });
  test('empty / non-string → 0', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens(undefined as any)).toBe(0);
    expect(estimateTextTokens(123 as any)).toBe(0);
  });
});

describe('estimateMessageTokens', () => {
  test('counts string content plus a small overhead', () => {
    const t = estimateMessageTokens({ role: 'user', content: 'x'.repeat(40), id: 'u', when: 0 } as any);
    expect(t).toBeGreaterThanOrEqual(Math.ceil(40 / CHARS_PER_TOKEN));
  });

  test('counts tool-result bodies (this is the page-bulk that drives trimming)', () => {
    const small = estimateMessageTokens({ role: 'user', content: '', id: 'a', when: 0, toolResults: [] } as any);
    const big = estimateMessageTokens({
      role: 'user', content: '', id: 'b', when: 0,
      toolResults: [{ tool_use_id: 't', content: 'y'.repeat(4000) }],
    } as any);
    expect(big).toBeGreaterThan(small + 900);
  });

  test('counts tool-use input JSON', () => {
    const t = estimateMessageTokens({
      role: 'assistant', content: '', id: 'a', when: 0,
      toolUses: [{ id: 't', name: 'navigate', input: { url: 'https://example.com/' + 'a'.repeat(200) } }],
    } as any);
    expect(t).toBeGreaterThan(40);
  });

  test('unserializable tool input never throws', () => {
    const circular: any = {}; circular.self = circular;
    expect(() => estimateMessageTokens({
      role: 'assistant', content: '', id: 'a', when: 0,
      toolUses: [{ id: 't', name: 'x', input: circular }],
    } as any)).not.toThrow();
  });

  test('null message → 0', () => {
    expect(estimateMessageTokens(undefined as any)).toBe(0);
  });

  test('counts tool_use input in block-form content (imported/converted histories)', () => {
    const withInput = estimateMessageTokens({
      role: 'assistant', content: [{ type: 'tool_use', name: 'navigate', input: { url: 'x'.repeat(400) } }],
    } as any);
    const withoutInput = estimateMessageTokens({
      role: 'assistant', content: [{ type: 'tool_use', name: 'navigate' }],
    } as any);
    // The 400-char input JSON is real prompt weight — must be counted.
    expect(withInput).toBeGreaterThan(withoutInput + 80);
  });
});

describe('estimateMessagesTokens', () => {
  test('is additive: system + sum of per-message estimates', () => {
    const msgs = [
      { role: 'user', content: 'a'.repeat(40), id: 'u0', when: 0 },
      { role: 'assistant', content: 'b'.repeat(80), id: 'a1', when: 1 },
    ] as any;
    const system = 's'.repeat(20);
    const total = estimateMessagesTokens(msgs, system);
    const expected = estimateTextTokens(system)
      + estimateMessageTokens(msgs[0]) + estimateMessageTokens(msgs[1]);
    expect(total).toBe(expected);
  });

  test('tolerates non-array input', () => {
    expect(estimateMessagesTokens(null as any, 'sys')).toBe(estimateTextTokens('sys'));
  });
});
