import { describe, expect, test } from 'bun:test';
import { reasoningForTurn } from '../../../extension/peerd-runtime/loop/agent-loop.js';

describe('controller-owned reasoning policy', () => {
  test('normalizes the raw authority settings snapshot', () => {
    expect(reasoningForTurn({ reasoningEnabled: true, reasoningEffort: 'high' })).toEqual({
      enabled: true,
      budgetTokens: 2048,
      effort: 'high',
    });
    expect(reasoningForTurn({ reasoningEnabled: 'yes', reasoningEffort: 'unbounded' })).toEqual({
      enabled: false,
      budgetTokens: 2048,
      effort: 'medium',
    });
  });
});
