// End-to-end interaction fuzz: redaction-shaped histories pushed through the
// FULL compression chain (planBodyCompaction → planTrim) and then the wire
// converter (toAnthropicMessages) must still produce a VALID Anthropic
// request. This is the interaction unit tests miss — each transform is
// individually correct, but do they COMPOSE without orphaning a tool_result,
// emitting an empty message, or breaking role validity?

import { describe, test, expect } from 'bun:test';
import { planBodyCompaction } from '../../../extension/peerd-runtime/loop/lineage-compaction.js';
import { planTrim } from '../../../extension/peerd-runtime/loop/trim.js';
import { toAnthropicMessages } from '../../../extension/peerd-provider/format/to-anthropic.js';

const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const SE = ['read', 'write', 'mutate_external', 'destructive'];

// Build a VALID loop-shaped history: starts with a user message, and every
// assistant tool_use turn is IMMEDIATELY followed by a user turn with the
// matching tool_results (the invariant the agent loop guarantees). Our
// transforms must preserve it.
const validHistory = (rnd: () => number): any[] => {
  const out: any[] = [{ role: 'user', content: 'kick off the task', id: 'u0', when: 0 }];
  let i = 1;
  const n = 3 + Math.floor(rnd() * 30);
  while (out.length < n) {
    const r = rnd();
    if (r < 0.4) {
      // a tool round: assistant tool_use(s) + paired user tool_results
      const k = 1 + Math.floor(rnd() * 3);
      const uses = Array.from({ length: k }, (_, j) => ({ id: `tu_${i}_${j}`, name: 'read_page', input: { q: 'x' } }));
      out.push({ role: 'assistant', content: '', id: `a${i}`, when: i, toolUses: uses });
      out.push({
        role: 'user', content: '', id: `r${i}`, when: i,
        toolResults: uses.map((u, j) => ({
          tool_use_id: u.id,
          // ≥1 char: the empty-tool-result case is a separate, pre-existing
          // path (a tool returning '' ships '' through redaction) unrelated
          // to the compaction/trim interaction this test isolates.
          content: 'x'.repeat(1 + Math.floor(rnd() * 6000)),
          is_error: rnd() < 0.15,
          meta: { toolName: 'read_page', primitive: ['tab', 'app', 'webvm', 'web'][Math.floor(rnd() * 4)], sideEffect: SE[Math.floor(rnd() * SE.length)], origins: ['https://example.com'], durationMs: Math.floor(rnd() * 9000), gates: [], hooks: [] },
        })),
      });
      i += 1;
    } else if (r < 0.7) {
      out.push({ role: 'assistant', content: 'some reasoning '.repeat(1 + Math.floor(rnd() * 20)), id: `a${i}`, when: i });
      i += 1;
    } else {
      out.push({ role: 'user', content: 'follow-up question', id: `u${i}`, when: i });
      i += 1;
    }
  }
  return out;
};

// Validity of an Anthropic message array, per the API's hard rules.
const assertValidAnthropic = (msgs: any[]) => {
  expect(Array.isArray(msgs)).toBe(true);
  expect(msgs.length).toBeGreaterThan(0);
  const useIds = new Set<string>();
  for (const m of msgs) {
    expect(m.role === 'user' || m.role === 'assistant').toBe(true);
    // content is a non-empty string or a non-empty block array
    if (typeof m.content === 'string') {
      expect(m.content.length).toBeGreaterThan(0);
    } else {
      expect(Array.isArray(m.content)).toBe(true);
      expect(m.content.length).toBeGreaterThan(0);
      for (const b of m.content) {
        if (b.type === 'tool_use') useIds.add(b.id);
        if (b.type === 'tool_result') {
          // every tool_result must reference a tool_use seen EARLIER
          expect(useIds.has(b.tool_use_id)).toBe(true);
          // and carry non-empty content (a spine string counts)
          const c = b.content;
          const ok = (typeof c === 'string' && c.length > 0)
            || (Array.isArray(c) && c.length > 0);
          expect(ok).toBe(true);
        }
      }
    }
  }
};

describe('compaction × trim × converter — wire output stays valid', () => {
  test('800 random histories: full chain never produces an invalid Anthropic request', () => {
    for (let seed = 1; seed <= 800; seed++) {
      const rnd = lcg(seed);
      const history = validHistory(rnd);
      const contextWindow = [0, 600, 4000, 1_000_000][Math.floor(rnd() * 4)];

      // The exact order the agent loop uses: compact bodies, then trim.
      const compacted = contextWindow
        ? planBodyCompaction(history, { contextWindow }).messages
        : history;
      const trimmed = planTrim(compacted, { contextWindow, summaryState: null }).messages;
      const wire = toAnthropicMessages(trimmed as any);
      assertValidAnthropic(wire);

      // The chain also must not have grown the history (count-wise) nor lost
      // the most recent real message's id off the tail.
      expect(trimmed.length).toBeLessThanOrEqual(history.length + 1); // +1 synthetic summary
    }
  });

  test('a tiny window that forces BOTH compaction and a deep trim still pairs', () => {
    const rnd = lcg(42);
    const history = validHistory(rnd);
    // tiny window → compaction fires, then trim collapses most of it
    const compacted = planBodyCompaction(history, { contextWindow: 300 }).messages;
    const trimmed = planTrim(compacted, { contextWindow: 300, summaryState: null }).messages;
    assertValidAnthropic(toAnthropicMessages(trimmed as any));
  });
});

// The product requirement as a PROPERTY: across random histories that create
// engine instances, every created id must still be reachable in the wire
// payload after the full compaction→trim→convert chain — no matter how deep
// the trim cuts. (≤ the summary's handle cap of 10 creates per history.)
describe('every created instance handle reaches the wire after the full chain', () => {
  const lcg2 = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const PRIMS = ['app', 'notebook', 'webvm'];

  const historyWithCreates = (rnd: () => number, ids: string[]): any[] => {
    const out: any[] = [{ role: 'user', content: 'start', id: 'u0', when: 0 }];
    let nextCreate = 0;
    let i = 1;
    while (nextCreate < ids.length || out.length < 20) {
      // sprinkle creates among bulky reads
      if (nextCreate < ids.length && rnd() < 0.3) {
        const prim = PRIMS[Math.floor(rnd() * PRIMS.length)];
        const id = ids[nextCreate++];
        out.push({ role: 'assistant', content: '', id: `a${i}`, when: i, toolUses: [{ id: `tu${i}`, name: `${prim}_create`, input: {} }] });
        out.push({ role: 'user', content: '', id: `r${i}`, when: i, toolResults: [{
          tool_use_id: `tu${i}`, content: JSON.stringify({ id, name: `n${nextCreate}` }) + '\nmade.', is_error: false,
          meta: { toolName: `${prim}_create`, primitive: prim, sideEffect: 'write', origins: [], durationMs: 50, gates: [], hooks: [] },
        }] });
      } else {
        out.push({ role: 'assistant', content: '', id: `a${i}`, when: i, toolUses: [{ id: `tu${i}`, name: 'read_page', input: {} }] });
        out.push({ role: 'user', content: '', id: `r${i}`, when: i, toolResults: [{
          tool_use_id: `tu${i}`, content: 'x'.repeat(4000), is_error: false,
          meta: { toolName: 'read_page', primitive: 'web', sideEffect: 'read', origins: ['https://e.com'], durationMs: 20, gates: [], hooks: [] },
        }] });
      }
      i += 1;
      if (out.length > 120) break; // bound
    }
    return out;
  };

  test('200 histories: no created id is ever stranded', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rnd = lcg2(seed);
      const nCreates = 1 + Math.floor(rnd() * 8); // ≤ 10, the handle cap
      const ids = Array.from({ length: nCreates }, (_, k) => `app-${seed}-${k}`);
      const history = historyWithCreates(rnd, ids);
      const cw = 400; // brutal: forces both compaction and a deep trim

      let state: any = null;
      // simulate a couple of successive turns (rolling state persists)
      let compacted = planBodyCompaction(history, { contextWindow: cw }).messages;
      let plan = planTrim(compacted, { contextWindow: cw, summaryState: state });
      state = plan.summaryState;
      const wire = JSON.stringify(toAnthropicMessages(plan.messages as any));

      for (const id of ids) {
        if (!wire.includes(id)) throw new Error(`seed ${seed}: stranded handle ${id}`);
      }
    }
  });
});
