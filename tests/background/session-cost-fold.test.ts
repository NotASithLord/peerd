import { describe, expect, test } from 'bun:test';
import { makeSessionCostFolder } from '../../extension/background/session-cost-fold.js';

describe('session cost fold', () => {
  test('serializes concurrent read-modify-writes for one session', async () => {
    let persisted = { inputTokens: 0, outputTokens: 0, cost: 0 };
    const fold = makeSessionCostFolder({
      sessions: {
        get: async () => ({ cost: { ...persisted } }),
        setCost: async (_id, next) => { await Promise.resolve(); persisted = next; },
      },
      normalizeTally: (value) => value,
      addUsage: (current, usage, cost) => ({
        inputTokens: current.inputTokens + usage.inputTokens,
        outputTokens: current.outputTokens + usage.outputTokens,
        cost: current.cost + cost,
      }),
    });

    await Promise.all([
      fold('chat', { inputTokens: 2, outputTokens: 3 }, 0.1),
      fold('chat', { inputTokens: 5, outputTokens: 7 }, 0.2),
    ]);

    expect(persisted).toEqual({ inputTokens: 7, outputTokens: 10, cost: 0.30000000000000004 });
  });

  test('contains a persistence failure and permits a later fold', async () => {
    let attempts = 0;
    const fold = makeSessionCostFolder({
      sessions: {
        get: async () => ({ cost: 0 }),
        setCost: async () => { if (++attempts === 1) throw new Error('quota'); },
      },
      normalizeTally: (value) => value,
      addUsage: () => 1,
    });

    await expect(fold('chat', {}, 0)).resolves.toBeUndefined();
    await expect(fold('chat', {}, 0)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
