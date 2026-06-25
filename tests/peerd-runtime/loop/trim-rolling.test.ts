// planTrim's ROLLING contract: successive trims incorporate the prior
// summary state instead of recomputing blind, model-enriched sections
// survive, drift resets safely, and the tool_use/tool_result boundary
// invariant from trim.test.ts holds with state in play.

import { describe, test, expect } from 'bun:test';
import { planTrim, trimHistory } from '../../../extension/peerd-runtime/loop/trim.js';
import { mergeEnrichment, emptySummaryState } from '../../../extension/peerd-runtime/loop/rolling-summary.js';
import type { TrimSummaryState } from '../../../extension/peerd-runtime/loop/rolling-summary.js';

const userMsg = (i: number) => ({ role: 'user', content: `u${i}`, id: `u${i}`, when: i });
const asstMsg = (i: number, toolUses?: any[]) => ({
  role: 'assistant', content: `a${i}`, id: `a${i}`, when: i,
  ...(toolUses ? { toolUses } : {}),
});
const toolResultMsg = (i: number, results: any[]) => ({
  role: 'user', content: '', id: `tr${i}`, when: i, toolResults: results,
});

const plainConversation = (n: number, offset = 0) => {
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const j = offset + i;
    out.push(j % 2 === 0 ? userMsg(j) : asstMsg(j));
  }
  return out;
};

const assertNoOrphanResults = (out: any[]) => {
  const useIds = new Set<string>();
  for (const m of out) {
    if (m.role === 'assistant' && Array.isArray(m.toolUses)) {
      for (const tu of m.toolUses) useIds.add(tu.id);
    }
  }
  for (const m of out) {
    if (m.role !== 'user' || !Array.isArray(m.toolResults)) continue;
    for (const tr of m.toolResults) expect(useIds.has(tr.tool_use_id)).toBe(true);
  }
};

describe('planTrim rolling summary', () => {
  test('no-op under the soft cap: didTrim false, no state', () => {
    const plan = planTrim(plainConversation(20));
    expect(plan.didTrim).toBe(false);
    expect(plan.summaryState).toBe(null);
    expect(plan.newlyDropped).toEqual([]);
    expect(plan.messages.length).toBe(20);
  });

  test('first trim folds the whole dropped prefix and reports it as newly dropped', () => {
    const msgs = plainConversation(80);
    const plan = planTrim(msgs);
    expect(plan.didTrim).toBe(true);
    expect(plan.newlyDropped.length).toBe(60);
    expect(plan.summaryState!.covered).toBe(60);
    expect(plan.summaryState!.coveredLastId).toBe('a59');
    expect(plan.summaryState!.users).toBe(30);
    expect(plan.summaryState!.assistants).toBe(30);
    expect(plan.messages[0].synthetic).toBe(true);
    expect(plan.messages[0].content).toContain('60 earlier messages elided');
  });

  test('wrapSummary post-processes the rendered summary content (web-resident self-fence)', () => {
    // DESIGN-17: a web resident injects fenceWebResidentSummary here so its own
    // page-derived summary re-enters as fenced DATA. The hook sees the FULL rendered
    // text and its output BECOMES the message content verbatim.
    const msgs = plainConversation(80);
    let seen = '';
    const plan = planTrim(msgs, {
      wrapSummary: (t) => { seen = t; return `<untrusted>${t}</untrusted>`; },
    });
    expect(plan.didTrim).toBe(true);
    // The hook received the real rendered summary…
    expect(seen).toContain('60 earlier messages elided');
    // …and its wrapped output is exactly what the synthesised message carries.
    expect(plan.messages[0].content).toBe(`<untrusted>${seen}</untrusted>`);
  });

  test('omitting wrapSummary renders the summary verbatim (every non-web caller)', () => {
    const plan = planTrim(plainConversation(80));
    expect(plan.messages[0].content).toContain('60 earlier messages elided');
    expect(plan.messages[0].content).not.toContain('<untrusted>');
  });

  test('second trim with prior state folds ONLY the newly-dropped slice', () => {
    const msgs = plainConversation(80);
    const first = planTrim(msgs);
    // Session grows by 10 messages; trim again with the persisted state.
    const grown = [...msgs, ...plainConversation(10, 80)];
    const second = planTrim(grown, { summaryState: first.summaryState });
    expect(second.didTrim).toBe(true);
    // dropCount = 90 - 20 = 70; covered was 60 → 10 newly dropped.
    expect(second.newlyDropped.length).toBe(10);
    expect(second.newlyDropped[0].id).toBe('u60');
    expect(second.summaryState!.covered).toBe(70);
    expect(second.summaryState!.users).toBe(35);
    expect(second.messages[0].content).toContain('70 earlier messages elided');
  });

  test('rolling counts equal a from-scratch refold (mechanical equivalence)', () => {
    const msgs = [...plainConversation(80), ...plainConversation(14, 80)];
    const incremental = planTrim(msgs, {
      summaryState: planTrim(msgs.slice(0, 80)).summaryState,
    });
    const fromScratch = planTrim(msgs);
    expect(incremental.summaryState!.users).toBe(fromScratch.summaryState!.users);
    expect(incremental.summaryState!.assistants).toBe(fromScratch.summaryState!.assistants);
    expect(incremental.summaryState!.covered).toBe(fromScratch.summaryState!.covered);
    expect(incremental.messages[0].content).toBe(fromScratch.messages[0].content);
  });

  test('model-enriched sections persist into the next trim summary message', () => {
    const msgs = plainConversation(80);
    const first = planTrim(msgs);
    const enriched = mergeEnrichment(first.summaryState!, {
      facts: ['user is booking a flight to Lisbon'],
      threads: ['seat selection unfinished'],
    });
    const grown = [...msgs, ...plainConversation(10, 80)];
    const second = planTrim(grown, { summaryState: enriched });
    expect(second.messages[0].content).toContain('user is booking a flight to Lisbon');
    expect(second.messages[0].content).toContain('seat selection unfinished');
  });

  test('anchor drift resets the state instead of trusting a stale watermark', () => {
    const msgs = plainConversation(80);
    const stale = { ...planTrim(msgs).summaryState!, coveredLastId: 'NOT-a59' };
    const plan = planTrim(msgs, { summaryState: stale });
    // Refolded from scratch: counts match the honest fold.
    expect(plan.summaryState!.users).toBe(30);
    expect(plan.summaryState!.covered).toBe(60);
    expect(plan.summaryState!.coveredLastId).toBe('a59');
  });

  test('covered beyond the snapped cut resets rather than double-counting', () => {
    const msgs = plainConversation(80);
    const overreaching: TrimSummaryState = { ...emptySummaryState(), covered: 75, coveredLastId: 'a74', users: 99 };
    const plan = planTrim(msgs, { summaryState: overreaching });
    expect(plan.summaryState!.covered).toBe(60);
    expect(plan.summaryState!.users).toBe(30); // refolded, not 99 + extra
  });

  test('boundary invariant holds with rolling state across growth + tool rounds', () => {
    // Tool rounds spanning the cut region, grown in two stages.
    const rounds: any[] = [];
    for (let r = 0; r < 25; r++) {
      rounds.push(
        asstMsg(20 + r * 2, [{ id: `t${20 + r * 2}`, name: 'click', input: {} }]),
        toolResultMsg(21 + r * 2, [{ tool_use_id: `t${20 + r * 2}`, content: 'r' }]),
      );
    }
    const stage1 = [...plainConversation(20), ...rounds.slice(0, 30)]; // 50 msgs
    const stage2 = [...plainConversation(20), ...rounds];              // 70 msgs
    const first = planTrim(stage1, { softCap: 40, keepRecent: 10 });
    assertNoOrphanResults(first.messages);
    const second = planTrim(stage2, {
      softCap: 40, keepRecent: 10, summaryState: first.summaryState,
    });
    assertNoOrphanResults(second.messages);
    expect(second.summaryState!.covered).toBeGreaterThan(first.summaryState!.covered);
  });

  test('trimHistory stays a pure array view of planTrim', () => {
    const msgs = plainConversation(80);
    expect(trimHistory(msgs)).toEqual(planTrim(msgs).messages);
  });

  test('deterministic with state: same inputs, identical outputs', () => {
    const msgs = plainConversation(90);
    const state = planTrim(msgs.slice(0, 80)).summaryState;
    const a = planTrim(msgs, { summaryState: state });
    const b = planTrim(msgs, { summaryState: state });
    expect(a.messages[0].content).toBe(b.messages[0].content);
    expect(a.summaryState).toEqual(b.summaryState);
  });
});
