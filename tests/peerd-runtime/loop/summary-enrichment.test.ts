// makeTrimEnricher — the queue-then-drain shell. Latest-wins queueing,
// the cheap call + parse + merge + persist happy path, and every
// failure mode degrading to the mechanical summary (no throws, no
// writes).

import { describe, test, expect } from 'bun:test';
import { makeTrimEnricher } from '../../../extension/peerd-runtime/loop/summary-enrichment.js';
import { foldDropped, emptySummaryState } from '../../../extension/peerd-runtime/loop/rolling-summary.js';

const userMsg = (i: number) => ({ role: 'user', content: `u${i}`, id: `u${i}`, when: i });

const makeSessions = (record: any) => {
  const writes: any[] = [];
  return {
    writes,
    async get() { return record; },
    async setTrimSummary(_id: string, state: any) {
      writes.push(state);
      record.trimSummary = state;
      return record;
    },
  };
};

const stateFor = (msgs: any[]) => foldDropped(emptySummaryState(), msgs);

describe('makeTrimEnricher', () => {
  test('happy path: call → parse → merge onto the freshest state → persist + audit', async () => {
    const dropped = [userMsg(0), userMsg(1)];
    const state = stateFor(dropped);
    const record = { sessionId: 's1', trimSummary: state };
    const sessions = makeSessions(record);
    const calls: any[] = [];
    const audits: any[] = [];
    const enricher = makeTrimEnricher({
      cheapCall: async (req: any) => {
        calls.push(req);
        return { ok: true, text: '{"facts":["user works at hydra"],"decisions":[],"threads":["flight unbooked"]}' };
      },
      sessions: sessions as any,
      appendAudit: async (e: any) => { audits.push(e); },
    });

    enricher.queue({ sessionId: 's1', state, newlyDropped: dropped });
    const res = await enricher.drain('s1');
    expect(res.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].label).toBe('trim-summary');
    expect(calls[0].task).toContain('User: u0');
    expect(sessions.writes.length).toBe(1);
    expect(sessions.writes[0].facts).toEqual(['user works at hydra']);
    expect(sessions.writes[0].threads).toEqual(['flight unbooked']);
    // Mechanical counts preserved through the merge.
    expect(sessions.writes[0].users).toBe(2);
    expect(audits[0].type).toBe('trim_summary_enriched');
  });

  test('latest-wins queue: two trims in one turn → one call with the final state', async () => {
    const record = { sessionId: 's1', trimSummary: stateFor([userMsg(0)]) };
    const sessions = makeSessions(record);
    const calls: any[] = [];
    const enricher = makeTrimEnricher({
      cheapCall: async (req: any) => { calls.push(req); return { ok: true, text: '{"facts":[]}' }; },
      sessions: sessions as any,
    });
    enricher.queue({ sessionId: 's1', state: stateFor([userMsg(0)]), newlyDropped: [userMsg(0)] });
    enricher.queue({ sessionId: 's1', state: stateFor([userMsg(0), userMsg(1)]), newlyDropped: [userMsg(1)] });
    expect(enricher.pendingCount()).toBe(1);
    await enricher.drain('s1');
    expect(calls.length).toBe(1);
    expect(calls[0].task).toContain('u1');
  });

  test('drain with nothing queued is a cheap no-op', async () => {
    const enricher = makeTrimEnricher({
      cheapCall: async () => { throw new Error('should not be called'); },
      sessions: makeSessions({}) as any,
    });
    const res = await enricher.drain('s1');
    expect(res).toEqual({ ok: true, skipped: 'nothing-pending' });
  });

  test('failed or capped call → no write, mechanical summary stands', async () => {
    const record = { sessionId: 's1', trimSummary: stateFor([userMsg(0)]) };
    const sessions = makeSessions(record);
    const enricher = makeTrimEnricher({
      cheapCall: async () => ({ ok: false, skipped: true, reason: 'spend-limit' }),
      sessions: sessions as any,
    });
    enricher.queue({ sessionId: 's1', state: record.trimSummary, newlyDropped: [userMsg(0)] });
    const res = await enricher.drain('s1');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('spend-limit');
    expect(sessions.writes.length).toBe(0);
  });

  test('unparseable model output → no write', async () => {
    const record = { sessionId: 's1', trimSummary: stateFor([userMsg(0)]) };
    const sessions = makeSessions(record);
    const enricher = makeTrimEnricher({
      cheapCall: async () => ({ ok: true, text: 'I could not produce JSON, sorry!' }),
      sessions: sessions as any,
    });
    enricher.queue({ sessionId: 's1', state: record.trimSummary, newlyDropped: [userMsg(0)] });
    const res = await enricher.drain('s1');
    expect(res).toEqual({ ok: false, reason: 'unparseable' });
    expect(sessions.writes.length).toBe(0);
  });

  test('session lost its state (reset/deleted) → skip, no write, no throw', async () => {
    const sessions = makeSessions({ sessionId: 's1' }); // no trimSummary
    const enricher = makeTrimEnricher({
      cheapCall: async () => ({ ok: true, text: '{"facts":["x"]}' }),
      sessions: sessions as any,
    });
    enricher.queue({ sessionId: 's1', state: stateFor([userMsg(0)]), newlyDropped: [userMsg(0)] });
    const res = await enricher.drain('s1');
    expect(res).toEqual({ ok: true, skipped: 'no-state' });
    expect(sessions.writes.length).toBe(0);
  });

  test('a throwing cheapCall is swallowed into a reason', async () => {
    const record = { sessionId: 's1', trimSummary: stateFor([userMsg(0)]) };
    const enricher = makeTrimEnricher({
      cheapCall: async () => { throw new Error('network down'); },
      sessions: makeSessions(record) as any,
    });
    enricher.queue({ sessionId: 's1', state: record.trimSummary, newlyDropped: [userMsg(0)] });
    const res = await enricher.drain('s1');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('network down');
  });
});
