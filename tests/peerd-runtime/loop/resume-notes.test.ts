import { describe, test, expect } from 'bun:test';
import {
  injectResumeNotes,
  RESUME_NOTES_MAX_CHARS,
} from '../../../extension/peerd-runtime/loop/resume-notes.js';

// injectResumeNotes is the pure half of interrupted-reasoning recovery:
// an assistant turn that died mid-reasoning (aborted / max_tokens /
// provider error) persists its partial `thinking`, but the API strips
// replayed thinking blocks and the format layer drops thinking-only
// messages — so without this rewrite the next request carries no trace
// of the attempt. Qualifying turns get their thinking injected as
// visible content (with a bracketed resume preamble) and lose their
// thinkingBlocks; everything else must pass through BY REFERENCE.

// ---- message factories (shapes mirror agent-loop.js persistence) -----------

const userMsg = (i: number): any => ({
  role: 'user', content: `u${i}`, id: `u${i}`, when: i,
});
const asstMsg = (i: number, extra: any = {}): any => ({
  role: 'assistant', content: '', id: `a${i}`, when: i, ...extra,
});
const blocks = () => [{ type: 'thinking', thinking: 'signed', signature: 'sig' }];

describe('injectResumeNotes', () => {
  test('thinking-only aborted message gains notes and loses thinkingBlocks', () => {
    const m = asstMsg(1, {
      thinking: 'step 1: open the tab', thinkingBlocks: blocks(), stopReason: 'aborted',
    });
    const [out] = injectResumeNotes([m]);
    expect(out).not.toBe(m);
    expect(out.content).toContain('interrupted mid-reasoning');
    expect(out.content).toContain('step 1: open the tab');
    expect('thinkingBlocks' in out).toBe(false);
    // Shallow copy, not a mutation of the input message.
    expect(m.content).toBe('');
    expect(m.thinkingBlocks).toBeDefined();
  });

  test('max_tokens truncation gets the same treatment', () => {
    const m = asstMsg(1, {
      thinking: 'half-finished plan', thinkingBlocks: blocks(), stopReason: 'max_tokens',
    });
    const [out] = injectResumeNotes([m]);
    expect(out).not.toBe(m);
    expect(out.content).toContain('half-finished plan');
    expect('thinkingBlocks' in out).toBe(false);
  });

  test('errored turn (error field, no stopReason) gets the same treatment', () => {
    const m = asstMsg(1, {
      thinking: 'was comparing the two prices', error: 'overloaded_error: 529',
    });
    const [out] = injectResumeNotes([m]);
    expect(out).not.toBe(m);
    expect(out.content).toContain('was comparing the two prices');
  });

  test("stopReason 'incomplete' qualifies by name even without an error field", () => {
    const m = asstMsg(1, {
      thinking: 'mid-stream when the provider cut off', stopReason: 'incomplete',
    });
    const [out] = injectResumeNotes([m]);
    expect(out).not.toBe(m);
    expect(out.content).toContain('mid-stream when the provider cut off');
  });

  test('completed turn (end_turn, has text) passes through BY REFERENCE', () => {
    const m = asstMsg(1, {
      content: 'the answer', thinking: 'worked it out', thinkingBlocks: blocks(),
      stopReason: 'end_turn',
    });
    expect(injectResumeNotes([m])[0]).toBe(m);
  });

  test('tool_use turn with thinkingBlocks passes through BY REFERENCE', () => {
    // Signed blocks on a tool_use turn are REQUIRED replay for the
    // in-flight tool loop — even when the turn carries an interrupted
    // marker, it must not be rewritten.
    const m = asstMsg(1, {
      thinking: 'click then read', thinkingBlocks: blocks(), stopReason: 'aborted',
      toolUses: [{ id: 't1', name: 'click', input: {} }],
    });
    expect(injectResumeNotes([m])[0]).toBe(m);
  });

  test('aborted turn WITH partial text keeps the text first, then notes', () => {
    const m = asstMsg(1, {
      content: 'Partial answer so far', thinking: 'and next I should...',
      stopReason: 'aborted',
    });
    const [out] = injectResumeNotes([m]);
    expect(out.content.startsWith('Partial answer so far\n\n')).toBe(true);
    const notes = out.content.slice('Partial answer so far\n\n'.length);
    expect(notes.startsWith('[')).toBe(true);
    expect(notes).toContain('and next I should...');
  });

  test('over-long thinking is tail-capped and trimmed to a line boundary', () => {
    // Geometry: `keep` is 2892 chars, so slice(-3000) opens on the LAST
    // 107 chars of the x-run (a cut-off partial line) + '\n' at index
    // 107 — inside the 200-char snap window. The notes must start AFTER
    // that newline, on the whole RESUME LINE.
    const keep = `RESUME LINE: continue from here\n${'y'.repeat(RESUME_NOTES_MAX_CHARS - 140)}`;
    const thinking = `${'OLD'.repeat(1000)}${'x'.repeat(150)}\n${keep}`;
    expect(thinking.length).toBeGreaterThan(RESUME_NOTES_MAX_CHARS);
    const m = asstMsg(1, { thinking, stopReason: 'max_tokens' });
    const [out] = injectResumeNotes([m]);
    // Notes = one preamble line + '\n' + injected thinking tail.
    const injected = out.content.slice(out.content.indexOf('\n') + 1);
    expect(injected.length).toBeLessThanOrEqual(RESUME_NOTES_MAX_CHARS);
    expect(injected).toBe(keep);
    expect(injected).not.toContain('OLD');
    expect(injected).not.toContain('x'); // the cut-off partial line is gone
  });

  test('over-long thinking with no early line break keeps the raw tail cut', () => {
    const thinking = 'z'.repeat(RESUME_NOTES_MAX_CHARS * 2); // no newlines at all
    const m = asstMsg(1, { thinking, stopReason: 'max_tokens' });
    const [out] = injectResumeNotes([m]);
    const injected = out.content.slice(out.content.indexOf('\n') + 1);
    expect(injected).toBe('z'.repeat(RESUME_NOTES_MAX_CHARS));
  });

  test('empty or absent thinking passes through BY REFERENCE', () => {
    const empty = asstMsg(1, { thinking: '', stopReason: 'aborted' });
    const absent = asstMsg(2, { stopReason: 'aborted' });
    const out = injectResumeNotes([empty, absent]);
    expect(out[0]).toBe(empty);
    expect(out[1]).toBe(absent);
  });

  test('user messages pass through BY REFERENCE', () => {
    const u = userMsg(1);
    expect(injectResumeNotes([u])[0]).toBe(u);
  });

  test('returns a NEW array and never mutates the input array or its members', () => {
    const interrupted = asstMsg(1, {
      thinking: 'notes', thinkingBlocks: blocks(), stopReason: 'aborted',
    });
    const input = [userMsg(0), interrupted, userMsg(2)];
    const snapshot = JSON.stringify(input);
    const out = injectResumeNotes(input);
    expect(out).not.toBe(input);
    expect(out.length).toBe(3);
    expect(JSON.stringify(input)).toBe(snapshot);
    // Untouched members keep identity around the rewritten one.
    expect(out[0]).toBe(input[0]);
    expect(out[2]).toBe(input[2]);
    expect(out[1]).not.toBe(input[1]);
  });
});
