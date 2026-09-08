// makeTurnCostTracker — the per-turn imperative shell around the pure
// accumulator (feature 06), extracted from the SW's runAgentTurn. Verifies
// the fold → persist → push ordering, the one-shot hard-limit latch, and
// the snapshot semantics the SW relies on.

import { describe, test, expect } from 'bun:test';
import { makeTurnCostTracker } from '../../extension/peerd-runtime/cost/turn-tracker.js';

const usageEv = (
  inputTokens: number,
  outputTokens: number,
  sessionId = 's1',
  cost = inputTokens + 2 * outputTokens,
  estimated = true,
) => ({
  sessionId,
  usage: { inputTokens, outputTokens },
  price: { cost, estimated },
});

describe('makeTurnCostTracker', () => {
  test('accumulates both tallies and persists/pushes per event', async () => {
    const persisted: any[] = [];
    const pushed: any[] = [];
    const t = makeTurnCostTracker({
      limitUsd: 0,
      initialSessionCost: { cost: 10, inputTokens: 5, outputTokens: 0, turns: 3 },
      persistCost: async (tally: any) => { persisted.push(tally); },
      onCost: (info: any) => { pushed.push(info); },
    });

    await t.onUsage(usageEv(100, 10));   // cost 120
    await t.onUsage(usageEv(50, 0));     // cost 50

    expect(t.turn().cost).toBe(170);
    expect(t.session().cost).toBe(180);          // 10 persisted + 170 new
    expect(t.turn().turns).toBe(1);              // this user turn counted once
    expect(t.session().turns).toBe(4);           // 3 prior + this one
    expect(persisted.length).toBe(2);            // persist per fold
    expect(persisted[1].cost).toBe(180);
    expect(pushed.length).toBe(2);
    expect(pushed[1]).toMatchObject({ sessionId: 's1', limitUsd: 0 });
    expect(pushed[1].session.cost).toBe(180);
    expect(pushed[1].turn.cost).toBe(170);
  });

  test('hard limit fires onLimitExceeded exactly once and keeps reporting true', async () => {
    let fired = 0;
    const t = makeTurnCostTracker({
      limitUsd: 100,
      initialSessionCost: null,
      persistCost: async () => {},
      onLimitExceeded: () => { fired += 1; },
    });

    await t.onUsage(usageEv(50, 0));
    expect(t.maybeHalt(usageEv(0, 0))).toBe(false);
    await t.onUsage(usageEv(60, 0));               // total 110 > 100
    expect(t.maybeHalt(usageEv(0, 0))).toBe(true);
    expect(t.maybeHalt(usageEv(0, 0))).toBe(true); // still exceeded…
    expect(fired).toBe(1);                          // …but latched once
  });

  test('zero / absent limit never halts', async () => {
    let fired = 0;
    const t = makeTurnCostTracker({
      limitUsd: 0,
      initialSessionCost: null,
      persistCost: async () => {},
      onLimitExceeded: () => { fired += 1; },
    });
    await t.onUsage(usageEv(1_000_000, 1_000_000));
    expect(t.maybeHalt(usageEv(0, 0))).toBe(false);
    expect(fired).toBe(0);
  });

  test('folds the controller-projected price; persist failure never throws', async () => {
    const t = makeTurnCostTracker({
      limitUsd: 0,
      initialSessionCost: null,
      persistCost: async () => { throw new Error('idb gone'); },
    });
    await t.onUsage(usageEv(10, 0, 's1', 20));
    expect(t.turn().cost).toBe(20);
  });

  test('rejects a missing or malformed controller price projection', async () => {
    const t = makeTurnCostTracker({
      limitUsd: 0,
      initialSessionCost: null,
      persistCost: async () => {},
    });
    await expect(t.onUsage({ sessionId: 's1', usage: { inputTokens: 1 } } as any))
      .rejects.toThrow('turn usage price projection invalid');
    await expect(t.onUsage({
      sessionId: 's1', usage: { inputTokens: 1 }, price: { cost: -1, estimated: true },
    } as any)).rejects.toThrow('turn usage price projection invalid');
  });

  test('corrupt persisted tally is normalized, not propagated', async () => {
    const t = makeTurnCostTracker({
      limitUsd: 0,
      initialSessionCost: { cost: 'NaN-garbage', turns: -3 } as any,
      persistCost: async () => {},
    });
    await t.onUsage(usageEv(1, 0));
    expect(Number.isFinite(t.session().cost)).toBe(true);
  });
});
