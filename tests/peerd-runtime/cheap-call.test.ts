// makeCheapCall — the shared cheap one-shot helper: spend-limit
// preflight, tools:[] clean-context spawn, and the cost fold into the
// parent session's persisted tally (the tracker must see these calls).

import { describe, test, expect } from 'bun:test';
import { makeCheapCall } from '../../extension/peerd-runtime/subagent/cheap-call.js';

const makeSessions = (record: any) => {
  const costWrites: any[] = [];
  return {
    costWrites,
    record,
    async get(id: string) { return id === record?.sessionId ? record : null; },
    async setCost(_id: string, tally: any) {
      costWrites.push(tally);
      record.cost = tally;
    },
  };
};

const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe('makeCheapCall', () => {
  test('happy path: tools:[] spawn, text returned, cost folded into the session tally', async () => {
    const record = { sessionId: 's1', model: 'claude-sonnet-4-6', depth: 0, cost: { cost: 0.10, turns: 3 } };
    const sessions = makeSessions(record);
    const spawns: any[] = [];
    const call = makeCheapCall({
      spawnSubagent: async (req: any) => {
        spawns.push(req);
        return { result: 'the answer', sessionId: 'child-1', usage };
      },
      sessions: sessions as any,
      costOf: () => ({ cost: 0.02 }),
      getSpendLimitUsd: () => 5,
    });
    const res = await call({ sessionId: 's1', task: 'summarise', label: 'trim-summary' });
    expect(res.ok).toBe(true);
    expect(res.text).toBe('the answer');
    // Clean-context spawn shape: no tools, ephemeral, no panel events.
    expect(spawns[0].tools).toEqual([]);
    expect(spawns[0].persistDeltas).toBe(false);
    expect(spawns[0].parentSessionId).toBe('s1');
    // Cost folded onto the persisted tally — visible to the tracker.
    expect(sessions.costWrites.length).toBe(1);
    expect(sessions.costWrites[0].cost).toBeCloseTo(0.12);
    expect(sessions.costWrites[0].inputTokens).toBe(100);
    expect(sessions.costWrites[0].turns).toBe(3); // a cheap call is NOT a user turn
  });

  test('spend-limit preflight: a capped session never spawns', async () => {
    const record = { sessionId: 's1', cost: { cost: 6, turns: 1 } };
    const sessions = makeSessions(record);
    const audits: any[] = [];
    let spawned = false;
    const call = makeCheapCall({
      // sessionId completes the spawnSubagent return contract (never called here)
      spawnSubagent: async () => { spawned = true; return { result: 'x', sessionId: null }; },
      sessions: sessions as any,
      costOf: () => ({ cost: 0 }),
      getSpendLimitUsd: () => 5,
      appendAudit: async (e: any) => { audits.push(e); },
    });
    const res = await call({ sessionId: 's1', task: 't', label: 'auto-memory' });
    expect(res).toEqual({ ok: false, skipped: true, reason: 'spend-limit' });
    expect(spawned).toBe(false);
    expect(audits[0].type).toBe('cheap_call_skipped');
    expect(audits[0].details.label).toBe('auto-memory');
  });

  test('no limit set (0) → never blocked by the preflight', async () => {
    const record = { sessionId: 's1', cost: { cost: 999, turns: 1 } };
    const call = makeCheapCall({
      spawnSubagent: async () => ({ result: 'ok', sessionId: null, usage }),
      sessions: makeSessions(record) as any,
      costOf: () => ({ cost: 0.01 }),
      getSpendLimitUsd: () => 0,
    });
    expect((await call({ sessionId: 's1', task: 't' })).ok).toBe(true);
  });

  test('missing session → skipped, never a spawn', async () => {
    const call = makeCheapCall({
      spawnSubagent: async () => { throw new Error('no'); },
      sessions: makeSessions(null) as any,
      costOf: () => ({ cost: 0 }),
    });
    expect(await call({ sessionId: 'ghost', task: 't' }))
      .toEqual({ ok: false, skipped: true, reason: 'no-session' });
  });

  test('a refused spawn surfaces the refusal reason without a cost write', async () => {
    const record = { sessionId: 's1', cost: { cost: 0, turns: 0 } };
    const sessions = makeSessions(record);
    const call = makeCheapCall({
      spawnSubagent: async () => ({ result: 'subagent refused: max depth', sessionId: null, refused: true }),
      sessions: sessions as any,
      costOf: () => ({ cost: 0 }),
    });
    const res = await call({ sessionId: 's1', task: 't' });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('refused');
    expect(sessions.costWrites.length).toBe(0);
  });

  test('a throwing costOf still returns the text (cost folds as zero)', async () => {
    const record = { sessionId: 's1', model: 'm', cost: { cost: 0.5, turns: 1 } };
    const sessions = makeSessions(record);
    const call = makeCheapCall({
      spawnSubagent: async () => ({ result: 'fine', sessionId: null, usage }),
      sessions: sessions as any,
      costOf: () => { throw new Error('no rate card'); },
    });
    const res = await call({ sessionId: 's1', task: 't' });
    expect(res.ok).toBe(true);
    expect(sessions.costWrites[0].cost).toBeCloseTo(0.5);
    expect(sessions.costWrites[0].inputTokens).toBe(100); // tokens still counted
  });
});
