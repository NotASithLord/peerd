import { describe, test, expect } from 'bun:test';
import { trimHistory } from '../../../extension/peerd-runtime/loop/trim.js';
import type { InternalMessage } from '../../../extension/peerd-provider/types.js';

// trimHistory's boundary-snapping contract: the kept-recent window must
// never OPEN on a tool_result-carrying user message, because its paired
// assistant tool_use would be on the trimmed side and the provider 400s
// on an orphaned tool_result. The cut snaps BACKWARD onto the paired
// assistant tool_use (slightly expanding the kept window) — correctness
// over exact keepRecent count.

// ---- message factories (shapes mirror agent-loop.js) ------------------------

const userMsg = (i: number): InternalMessage => ({
  role: 'user', content: `u${i}`, id: `u${i}`, when: i,
});
const asstMsg = (i: number, toolUses?: any[]): InternalMessage => ({
  role: 'assistant', content: `a${i}`, id: `a${i}`, when: i,
  ...(toolUses ? { toolUses } : {}),
});
// agent-loop.js resultMessage shape: content '' + toolResults array.
const toolResultMsg = (i: number, results: any[]): InternalMessage => ({
  role: 'user', content: '', id: `tr${i}`, when: i,
  toolResults: results,
});
// Defensive alternative shape: tool_result blocks inside a content array
// (the converter's block form), no toolResults property.
const blockResultMsg = (i: number, ids: string[]) => ({
  role: 'user',
  content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'x' })),
  id: `br${i}`, when: i,
});

const plainConversation = (n: number, offset = 0) => {
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const j = offset + i;
    out.push(j % 2 === 0 ? userMsg(j) : asstMsg(j));
  }
  return out;
};

// One complete tool round: assistant tool_use at index i, matching user
// tool_results at i+1.
const toolRound = (i: number) => [
  asstMsg(i, [{ id: `t${i}`, name: 'read_page', input: {} }]),
  toolResultMsg(i + 1, [{ tool_use_id: `t${i}`, content: 'r' }]),
];

// ---- invariant checker -------------------------------------------------------

// Every tool_result id present in the trimmed output must have a matching
// tool_use id also in the output — i.e. no orphans (in either shape).
const assertNoOrphanResults = (out: any[]) => {
  const useIds = new Set<string>();
  for (const m of out) {
    if (m.role === 'assistant' && Array.isArray(m.toolUses)) {
      for (const tu of m.toolUses) useIds.add(tu.id);
    }
  }
  for (const m of out) {
    if (m.role !== 'user') continue;
    const resultIds: string[] = [];
    if (Array.isArray(m.toolResults)) {
      for (const tr of m.toolResults) resultIds.push(tr.tool_use_id);
    }
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === 'tool_result') resultIds.push(b.tool_use_id);
      }
    }
    for (const id of resultIds) {
      expect(useIds.has(id)).toBe(true);
    }
  }
};

describe('trimHistory boundary snapping', () => {
  test('cut landing mid-pair snaps back to include the assistant tool_use', () => {
    // 30 plain messages, then one tool round positioned so the default
    // cut (length - keepRecent) lands EXACTLY on the tool_result message.
    // Layout: plain[0..29], asst tool_use @30, tool_results @31, plain tail.
    const msgs = [
      ...plainConversation(30),
      ...toolRound(30),
      ...plainConversation(33, 32), // total 65 > softCap 60
    ];
    const keepRecent = msgs.length - 31; // cut index 31 = the tool_result msg
    const out = trimHistory(msgs, { keepRecent, softCap: 60 });

    expect(out[0].synthetic).toBe(true);
    // Window opens on the PAIRED assistant tool_use, not the orphan side.
    expect(out[1].id).toBe('a30');
    expect(out[2].id).toBe('tr31');
    // Expanded by exactly one message past keepRecent (plus the summary).
    expect(out.length).toBe(1 + keepRecent + 1);
    assertNoOrphanResults(out);
  });

  test('cut landing on a plain message is unchanged (no snap)', () => {
    const msgs = plainConversation(80);
    const out = trimHistory(msgs); // defaults: softCap 60, keepRecent 20
    expect(out.length).toBe(21);
    expect(out[0].synthetic).toBe(true);
    expect(out[1].id).toBe('u60'); // exact keepRecent slice
    assertNoOrphanResults(out);
  });

  test('cut landing on the assistant tool_use itself needs no snap', () => {
    const msgs = [
      ...plainConversation(30),
      ...toolRound(30),
      ...plainConversation(33, 32),
    ];
    const keepRecent = msgs.length - 30; // cut index 30 = the tool_use msg
    const out = trimHistory(msgs, { keepRecent, softCap: 60 });
    expect(out[1].id).toBe('a30');       // verbatim boundary, results follow
    expect(out.length).toBe(1 + keepRecent);
    assertNoOrphanResults(out);
  });

  test('multiple consecutive tool rounds: snap stays within one round', () => {
    // plain[0..19], then 25 back-to-back tool rounds (indices 20..69).
    const rounds: any[] = [];
    for (let r = 0; r < 25; r++) rounds.push(...toolRound(20 + r * 2));
    const msgs = [...plainConversation(20), ...rounds]; // 70 total

    // Cut index 31 → tr31 (mid-round of round 6). Must snap to a30 only —
    // NOT walk back across earlier completed rounds.
    const keepRecent = msgs.length - 31;
    const out = trimHistory(msgs, { keepRecent, softCap: 60 });
    expect(out[1].id).toBe('a30');
    expect(out[2].id).toBe('tr31');
    assertNoOrphanResults(out);

    // Sweep EVERY possible cut position across the tool-round region: no
    // keepRecent value may ever produce an orphaned tool_result.
    for (let keep = 1; keep < msgs.length; keep++) {
      const swept = trimHistory(msgs, { keepRecent: keep, softCap: 10 });
      assertNoOrphanResults(swept);
    }
  });

  test('snaps on the block-content tool_result shape too', () => {
    const msgs = [
      ...plainConversation(30),
      asstMsg(30, [{ id: 't30', name: 'click', input: {} }]),
      blockResultMsg(31, ['t30']),
      ...plainConversation(33, 32),
    ];
    const keepRecent = msgs.length - 31; // cut lands on the block-form result
    const out = trimHistory(msgs, { keepRecent, softCap: 60 });
    expect(out[1].id).toBe('a30');
    expect(out[2].id).toBe('br31');
    assertNoOrphanResults(out);
  });

  test('snap that reaches index 0 degrades to a no-op copy', () => {
    // tool_results all the way down to the front: snapping back past the
    // first message means there is nothing left to drop — return the
    // history untouched rather than synthesize an empty-prefix summary.
    const msgs = [
      asstMsg(0, [{ id: 't0', name: 'read_page', input: {} }]),
      ...Array.from({ length: 64 }, (_, i) =>
        toolResultMsg(i + 1, [{ tool_use_id: 't0', content: 'r' }])),
    ];
    const out = trimHistory(msgs, { keepRecent: 20, softCap: 60 });
    expect(out.length).toBe(msgs.length);
    expect(out[0].id).toBe('a0');
    expect(out.some((m: any) => m.synthetic)).toBe(false);
  });

  test('under the soft cap stays a shallow-copy no-op', () => {
    const msgs = [...plainConversation(20), ...toolRound(20)];
    const out = trimHistory(msgs);
    expect(out.length).toBe(msgs.length);
    expect(out).not.toBe(msgs);          // defensive copy
    expect(out[0].id).toBe('u0');
    expect(out[out.length - 1].id).toBe('tr21');
    expect(out.some((m: any) => m.synthetic)).toBe(false);
  });

  test('snapped trim is deterministic', () => {
    const msgs = [
      ...plainConversation(30),
      ...toolRound(30),
      ...plainConversation(33, 32),
    ];
    const keepRecent = msgs.length - 31;
    const a = trimHistory(msgs, { keepRecent, softCap: 60 });
    const b = trimHistory(msgs, { keepRecent, softCap: 60 });
    expect(a.length).toBe(b.length);
    expect(a[0].id).toBe(b[0].id);
    expect(a[0].content).toBe(b[0].content);
  });
});
