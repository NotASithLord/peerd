// Lineage body compaction — pure render + classifier + plan. Includes a
// fuzz/property pass: on random histories the transform must preserve
// structure (count, ids, tool_use_id pairing), never grow the estimate,
// never mutate the input, stay idempotent, and never compact a decision
// (mutate_external/destructive) result.

import { describe, test, expect } from 'bun:test';
import {
  renderLineageLine, defaultClassify, planBodyCompaction,
  COMPACT_KEEP_RECENT, EXPENSIVE_MS,
} from '../../../extension/peerd-runtime/loop/lineage-compaction.js';
import { estimateMessagesTokens } from '../../../extension/peerd-runtime/loop/estimate.js';

// ---- factories ---------------------------------------------------------------
const block = (i: number, o: any = {}): any => ({
  tool_use_id: `tu_${i}`,
  content: 'x'.repeat(o.bytes ?? 4000),
  is_error: o.is_error ?? false,
  meta: {
    toolName: o.toolName ?? 'read_page',
    primitive: o.primitive ?? 'tab',
    sideEffect: o.sideEffect ?? 'read',
    origins: o.origins ?? ['https://example.com'],
    durationMs: o.durationMs ?? 10,
    gates: [], hooks: [],
  },
});
const resultMsg = (i: number, blocks: any[]): any => ({ role: 'user', content: '', id: `r${i}`, when: i, toolResults: blocks });
const asstMsg = (i: number, toolUses?: any[]): any => ({ role: 'assistant', content: `a${i}`, id: `a${i}`, when: i, ...(toolUses ? { toolUses } : {}) });
const userMsg = (i: number): any => ({ role: 'user', content: `u${i}`, id: `u${i}`, when: i });

// A long tool-round history: assistant tool_use + user tool_result, repeated.
const rounds = (n: number, blockOpts: any = {}): any[] => {
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    out.push(asstMsg(i * 2, [{ id: `tu_${i}`, name: 'read_page', input: {} }]));
    out.push(resultMsg(i * 2 + 1, [block(i, blockOpts)]));
  }
  return out;
};

describe('renderLineageLine', () => {
  test('renders tool · primitive/origin · outcome · size', () => {
    expect(renderLineageLine(block(1)))
      .toBe('‹elided› read_page · tab/example.com · ok · 4.0k chars');
  });
  test('errored body renders error + small size', () => {
    expect(renderLineageLine(block(2, { is_error: true, bytes: 312, toolName: 'call_api', primitive: 'web', origins: ['https://api.stripe.com'] })))
      .toBe('‹elided› call_api · web/api.stripe.com · error · 312 chars');
  });
  test('multiple origins show +N', () => {
    expect(renderLineageLine(block(3, { origins: ['https://a.com', 'https://b.com', 'https://c.com'] })))
      .toContain('tab/a.com +2');
  });
  test('tolerates missing meta / non-string content', () => {
    expect(renderLineageLine({} as any)).toBe('‹elided› tool · ok · 0 chars');
    expect(renderLineageLine({ content: 123, meta: { primitive: 'webvm' } } as any))
      .toBe('‹elided› tool · webvm · ok · 0 chars');
  });

  test('carries the durable instance handle (id + name) for engine results', () => {
    const appCreate = {
      content: '{\n  "id": "app-abc12",\n  "name": "Calculator",\n  "opened": true\n}\n\n<note>…</note>',
      is_error: false,
      meta: { toolName: 'app_create', primitive: 'app', origins: [] },
    };
    expect(renderLineageLine(appCreate as any))
      .toContain('· id=app-abc12 "Calculator" ·');
  });

  test('carries id alone when the body has no name', () => {
    expect(renderLineageLine({ content: '{"id":"vm-9"}', meta: { toolName: 'vm_boot', primitive: 'webvm' } } as any))
      .toContain('· id=vm-9 ·');
  });

  test('a crafted name cannot inject a fake handle — the real id wins', () => {
    // The create summary is JSON.stringify({id, name, ...}) with id FIRST, so a
    // name trying to smuggle "id":"FAKE" can't override it (and JSON escaping
    // breaks the injected quotes anyway).
    const body = JSON.stringify({ id: 'app-real', name: 'evil","id":"app-FAKE' }) + '\n<note>…</note>';
    expect(renderLineageLine({ content: body, meta: { toolName: 'app_create', primitive: 'app' } } as any))
      .toContain('id=app-real');
    expect(renderLineageLine({ content: body, meta: { toolName: 'app_create', primitive: 'app' } } as any))
      .not.toContain('app-FAKE');
  });

  test('does NOT mine an id out of a non-engine (e.g. web/page) result', () => {
    // A page snapshot that happens to contain "id":"..." must not be treated
    // as a durable handle — only engine primitives carry one.
    const webResult = { content: '{"results":[{"id":"sku-123"}]}', meta: { toolName: 'read_page', primitive: 'tab', origins: ['https://shop.com'] } };
    expect(renderLineageLine(webResult as any)).not.toContain('id=');
  });
});

describe('defaultClassify', () => {
  const c = (o: any) => defaultClassify(block(0, o));
  test('read + ok + cheap → 1 (compact first)', () => { expect(c({ sideEffect: 'read', durationMs: 10 })).toBe(1); });
  test('read + ok + expensive → 2', () => { expect(c({ sideEffect: 'read', durationMs: EXPENSIVE_MS + 1 })).toBe(2); });
  test('write → 2', () => { expect(c({ sideEffect: 'write' })).toBe(2); });
  test('error → 3 (cause kept longer)', () => { expect(c({ is_error: true })).toBe(3); });
  test('mutate_external / destructive → never (Infinity)', () => {
    expect(c({ sideEffect: 'mutate_external' })).toBe(Infinity);
    expect(c({ sideEffect: 'destructive' })).toBe(Infinity);
  });
});

describe('planBodyCompaction — gating', () => {
  test('no-op without a context window', () => {
    expect(planBodyCompaction(rounds(12)).didCompact).toBe(false);
  });
  test('no-op when under the trigger', () => {
    expect(planBodyCompaction(rounds(2, { bytes: 100 }), { contextWindow: 1_000_000 }).didCompact).toBe(false);
  });
  test('no-op on empty / non-array', () => {
    expect(planBodyCompaction([], { contextWindow: 1000 }).didCompact).toBe(false);
    expect(planBodyCompaction(null as any, { contextWindow: 1000 }).didCompact).toBe(false);
  });
});

describe('planBodyCompaction — behavior', () => {
  test('fires over the trigger and shrinks the estimate', () => {
    const msgs = rounds(12); // ~12k est tokens of bodies
    const before = estimateMessagesTokens(msgs);
    const plan = planBodyCompaction(msgs, { contextWindow: 4000 });
    expect(plan.didCompact).toBe(true);
    expect(plan.compactedCount).toBeGreaterThan(0);
    expect(estimateMessagesTokens(plan.messages)).toBeLessThan(before);
  });

  test('protects the recent tail verbatim', () => {
    const msgs = rounds(12);
    const plan = planBodyCompaction(msgs, { contextWindow: 4000 });
    // The last COMPACT_KEEP_RECENT messages keep their full bodies.
    for (let i = msgs.length - COMPACT_KEEP_RECENT; i < msgs.length; i++) {
      expect(plan.messages[i]).toBe(msgs[i]); // same reference → untouched
    }
  });

  test('never compacts a decision (mutate_external) result, even under pressure', () => {
    const msgs = rounds(12, { sideEffect: 'mutate_external' });
    const plan = planBodyCompaction(msgs, { contextWindow: 1000 });
    expect(plan.didCompact).toBe(false);
    expect(plan.messages).toEqual(msgs);
  });

  test('compacts cheap reads before writes (lineage priority)', () => {
    // Alternate read / write rounds; give a target reachable by reads alone.
    const msgs: any[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(asstMsg(i * 2, [{ id: `tu_${i}`, name: 't', input: {} }]));
      msgs.push(resultMsg(i * 2 + 1, [block(i, { sideEffect: i % 2 === 0 ? 'read' : 'write', bytes: 4000 })]));
    }
    const plan = planBodyCompaction(msgs, { contextWindow: 4000, keepRecent: 2 });
    const compacted = (m: any) => typeof m.toolResults?.[0]?.content === 'string' && m.toolResults[0].content.startsWith('‹elided›');
    const reads = plan.messages.filter((_, i) => i % 2 === 1 && i < 18 && (msgs[i].toolResults[0].meta.sideEffect === 'read'));
    const writes = plan.messages.filter((_, i) => i % 2 === 1 && i < 18 && (msgs[i].toolResults[0].meta.sideEffect === 'write'));
    // At least one read was compacted; writes are only touched after all reads.
    expect(reads.some(compacted)).toBe(true);
    if (writes.some(compacted)) {
      expect(reads.every(compacted)).toBe(true); // a write only compacts once reads are exhausted
    }
  });

  test('skips tiny bodies (< minBytes)', () => {
    const msgs = rounds(12, { bytes: 100 });
    // Force the trigger with a tiny window but bodies are under minBytes.
    const plan = planBodyCompaction(msgs, { contextWindow: 100, minBytes: 400 });
    expect(plan.didCompact).toBe(false);
  });

  test('does not mutate the input', () => {
    const msgs = rounds(12);
    const snapshot = JSON.parse(JSON.stringify(msgs));
    planBodyCompaction(msgs, { contextWindow: 4000 });
    expect(msgs).toEqual(snapshot);
  });

  test('is deterministic and idempotent', () => {
    const msgs = rounds(12);
    const a = planBodyCompaction(msgs, { contextWindow: 4000 });
    const b = planBodyCompaction(msgs, { contextWindow: 4000 });
    expect(a.messages).toEqual(b.messages); // deterministic
    // Re-running on the OUTPUT compacts nothing new (prefix already spines,
    // tail protected) — idempotent in practice.
    const again = planBodyCompaction(a.messages, { contextWindow: 4000 });
    expect(estimateMessagesTokens(again.messages)).toBe(estimateMessagesTokens(a.messages));
  });

  test('honors an injected classifier', () => {
    const msgs = rounds(12);
    const plan = planBodyCompaction(msgs, { contextWindow: 4000, classify: () => Infinity });
    expect(plan.didCompact).toBe(false); // everything classified "never"
  });
});

// ---- fuzz / property pass ----------------------------------------------------
describe('planBodyCompaction — invariants on random histories', () => {
  // Tiny deterministic LCG so failures reproduce.
  const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

  const SIDE_EFFECTS = ['read', 'write', 'mutate_external', 'destructive'];
  const randomHistory = (rnd: () => number): any[] => {
    const n = 2 + Math.floor(rnd() * 40);
    const out: any[] = [];
    for (let i = 0; i < n; i++) {
      const r = rnd();
      if (r < 0.34) out.push(userMsg(i));
      else if (r < 0.5) out.push(asstMsg(i, [{ id: `tu_${i}`, name: 't', input: {} }]));
      else {
        const nblocks = 1 + Math.floor(rnd() * 3);
        const blocks = Array.from({ length: nblocks }, (_, b) => block(i * 10 + b, {
          bytes: Math.floor(rnd() * 6000),
          is_error: rnd() < 0.2,
          sideEffect: SIDE_EFFECTS[Math.floor(rnd() * SIDE_EFFECTS.length)],
          durationMs: Math.floor(rnd() * 10000),
        }));
        out.push(resultMsg(i, blocks));
      }
    }
    return out;
  };

  test('1000 random histories preserve every invariant', () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const rnd = lcg(seed);
      const msgs = randomHistory(rnd);
      const snapshot = JSON.parse(JSON.stringify(msgs));
      const contextWindow = [0, 500, 2000, 50_000][Math.floor(rnd() * 4)];
      const plan = planBodyCompaction(msgs, { contextWindow, keepRecent: 4 });

      // 1) input never mutated
      expect(msgs).toEqual(snapshot);
      // 2) structure: same length, same ids/order, same tool_use_id pairing
      expect(plan.messages.length).toBe(msgs.length);
      for (let i = 0; i < msgs.length; i++) {
        expect(plan.messages[i].id).toBe(msgs[i].id);
        expect(plan.messages[i].role).toBe(msgs[i].role);
        const a = (msgs[i] as any).toolResults, c = (plan.messages[i] as any).toolResults;
        if (Array.isArray(a)) {
          expect(c.length).toBe(a.length);
          for (let b = 0; b < a.length; b++) {
            expect(c[b].tool_use_id).toBe(a[b].tool_use_id);
            expect(c[b].is_error).toBe(a[b].is_error);
            // 3) a compacted body is never larger than the original; a
            //    decision result is never compacted at all.
            const grew = String(c[b].content).length > String(a[b].content).length;
            expect(grew).toBe(false);
            const se = a[b].meta?.sideEffect;
            if (se === 'mutate_external' || se === 'destructive') {
              expect(c[b].content).toBe(a[b].content);
            }
          }
        }
      }
      // 4) the estimate never grows
      expect(estimateMessagesTokens(plan.messages)).toBeLessThanOrEqual(estimateMessagesTokens(msgs));
      // 5) idempotent: a second pass never grows what the first produced
      const again = planBodyCompaction(plan.messages, { contextWindow, keepRecent: 4 });
      expect(estimateMessagesTokens(again.messages)).toBeLessThanOrEqual(estimateMessagesTokens(plan.messages));
    }
  });
});

// ---- the user requirement: a created handle survives the FULL chain ----------
// "if a session creates an app or workbook it retains where that is even after
// summarization/trim sessions." Compaction shrinks the create body to a spine,
// but the spine must still carry the id; and trim must not then drop the
// message that carries it off the front. We assert the id is reachable in what
// gets SENT after the full compaction→trim pass, even under brutal pressure.
describe('a created instance handle survives compaction + trim', () => {
  const createBody = (id: string, name: string) =>
    JSON.stringify({ id, name, url: `chrome-extension://x/app-tab.html#${id}` }) +
    '\n<note>App created and opened in a new tab.</note>'.repeat(40);

  // An early app_create, then a long tail of bulky reads to force pressure.
  const historyWithCreate = (): any[] => {
    const out: any[] = [userMsg(0)];
    out.push(asstMsg(1, [{ id: 'tu_app', name: 'app_create', input: { name: 'dashboard' } }]));
    out.push(resultMsg(2, [{
      tool_use_id: 'tu_app',
      content: createBody('app-7f3a', 'dashboard'),
      is_error: false,
      meta: { toolName: 'app_create', primitive: 'app', sideEffect: 'write', origins: [], durationMs: 120, gates: [], hooks: [] },
    }]));
    for (let i = 3; i < 30; i++) {
      out.push(asstMsg(i, [{ id: `tu_${i}`, name: 'read_page', input: {} }]));
      out.push(resultMsg(i + 100, [block(i, { bytes: 5000 })]));
      i += 1;
    }
    return out;
  };

  test('the app id is still in the wire payload after a tight-window pass', async () => {
    const { planTrim } = await import('../../../extension/peerd-runtime/loop/trim.js');
    const { toAnthropicMessages } = await import('../../../extension/peerd-provider/format/to-anthropic.js');
    const history = historyWithCreate();

    // Tight window: compaction fires on the create body, trim then cuts deep.
    const compacted = planBodyCompaction(history, { contextWindow: 2000 }).messages;
    // The create result is in the compacted prefix, so its body became a spine…
    const spine = (compacted.find((m: any) => m.id === 'r2') as any)?.toolResults?.[0]?.content;
    expect(spine).toContain('‹elided›');
    // …but the spine carries the durable handle.
    expect(spine).toContain('id=app-7f3a');
    expect(spine).toContain('app_create');

    // And after trim + wire conversion the id is still present somewhere the
    // model can read it (not trimmed off the front).
    const trimmed = planTrim(compacted, { contextWindow: 2000, summaryState: null }).messages;
    const wire = JSON.stringify(toAnthropicMessages(trimmed as any));
    expect(wire).toContain('app-7f3a');
  });
});
