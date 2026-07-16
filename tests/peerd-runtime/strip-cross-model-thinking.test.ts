// stripCrossModelThinking (extension/peerd-runtime/loop/agent-loop.js) — the
// hot-path guard that runs on EVERY turn's replayed history. Pins: it strips
// ONLY assistant messages whose author model differs from the model about to
// be called, keeps the visible `thinking` text, is a strict no-op for a
// same-model session, and never mutates the input.

import { describe, test, expect } from 'bun:test';
import { stripCrossModelThinking } from '../../extension/peerd-runtime/loop/agent-loop.js';

const asst = (over: Record<string, unknown> = {}) => ({
  role: 'assistant',
  model: 'claude-opus-4-8',
  thinking: 'visible reasoning',
  thinkingBlocks: [{ type: 'thinking', thinking: 'x', signature: 'sig' }],
  ...over,
});

describe('stripCrossModelThinking', () => {
  test('strips thinkingBlocks from a DIFFERENT-model assistant message; keeps visible thinking', () => {
    const out = stripCrossModelThinking([asst()], 'claude-haiku-4-5');
    expect(out[0].thinkingBlocks).toBeUndefined();
    expect(out[0].thinking).toBe('visible reasoning'); // transcript text retained
  });

  test('strict no-op when the author model matches the model about to be called', () => {
    const msgs = [asst()];
    const out = stripCrossModelThinking(msgs, 'claude-opus-4-8');
    expect(out[0].thinkingBlocks).toHaveLength(1);
    expect(out[0]).toBe(msgs[0]); // same reference — not even shallow-copied
  });

  test('never touches non-assistant messages, even with foreign thinkingBlocks', () => {
    const user = { role: 'user', model: 'other', thinkingBlocks: [{ type: 'thinking' }] };
    const out = stripCrossModelThinking([user], 'claude-haiku-4-5');
    expect(out[0]).toBe(user);
  });

  test('leaves messages with absent/empty model or no thinkingBlocks alone', () => {
    const noModel = { role: 'assistant', thinkingBlocks: [{ type: 'thinking' }] };
    const emptyModel = { role: 'assistant', model: '', thinkingBlocks: [{ type: 'thinking' }] };
    const noBlocks = { role: 'assistant', model: 'other', thinking: 't' };
    const out = stripCrossModelThinking([noModel, emptyModel, noBlocks], 'claude-haiku-4-5');
    expect(out[0]).toBe(noModel);   // msg.model falsy → guard skips
    expect(out[1]).toBe(emptyModel);
    expect(out[2]).toBe(noBlocks);
  });

  test('does not mutate the input array or its messages', () => {
    const msgs = [asst(), asst({ role: 'user' })];
    const snapshot = JSON.parse(JSON.stringify(msgs));
    stripCrossModelThinking(msgs, 'claude-haiku-4-5');
    expect(msgs).toEqual(snapshot); // originals intact; strip is on copies
  });

  test('mixed history: only the cross-model assistant blocks go', () => {
    const same = asst({ id: 'a' });
    const cross = asst({ id: 'b', model: 'claude-sonnet-5' });
    const out = stripCrossModelThinking([same, cross], 'claude-opus-4-8');
    expect(out[0].thinkingBlocks).toHaveLength(1); // same model → kept
    expect(out[1].thinkingBlocks).toBeUndefined(); // cross model → stripped
  });
});
