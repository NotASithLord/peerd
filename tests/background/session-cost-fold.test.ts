import { describe, expect, test } from 'bun:test';
import {
  makeSessionCostFolder,
} from '../../extension/background/kernel-turn-authority-adapter.js';

const normalize = (value: any) => ({
  inputTokens: Number(value?.inputTokens ?? 0),
  outputTokens: Number(value?.outputTokens ?? 0),
  cacheReadTokens: Number(value?.cacheReadTokens ?? 0),
  cacheWriteTokens: Number(value?.cacheWriteTokens ?? 0),
  cost: Number(value?.cost ?? 0),
});

describe('session cost fold', () => {
  test('serializes concurrent read-modify-writes for one session', async () => {
    let persisted: any = { inputTokens: 0, outputTokens: 0, cost: 0 };
    const fold = makeSessionCostFolder({
      sessions: {
        get: async () => ({ cost: { ...persisted } }),
        update: async (_id, patch) => {
          await Promise.resolve();
          persisted = patch.cost;
        },
      },
      normalize,
    });

    await Promise.all([
      fold('chat', { inputTokens: 2, outputTokens: 3 }, 0.1),
      fold('chat', { inputTokens: 5, outputTokens: 7 }, 0.2),
    ]);

    expect(persisted).toEqual({
      inputTokens: 7, outputTokens: 10,
      cacheReadTokens: 0, cacheWriteTokens: 0,
      cost: 0.30000000000000004,
    });
  });

  test('a persistence failure does not poison a later fold', async () => {
    let attempts = 0;
    const fold = makeSessionCostFolder({
      sessions: {
        get: async () => ({ cost: 0 }),
        update: async () => { if (++attempts === 1) throw new Error('quota'); },
      },
      normalize,
    });

    await expect(fold('chat', {}, 0)).rejects.toThrow('quota');
    await expect(fold('chat', {}, 0)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
