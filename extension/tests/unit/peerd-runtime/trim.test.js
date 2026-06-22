// @ts-check
// Sliding-window history trim — keeps recent turns intact, collapses
// older ones into one synthesised summary user message.

import { describe, it, expect } from '../../framework.js';
import { trimHistory } from '/peerd-runtime/loop/trim.js';

/** @typedef {import('/peerd-provider/types.js').UserMessage} UserMessage */
/** @typedef {import('/peerd-provider/types.js').AssistantMessage} AssistantMessage */
/** @typedef {import('/peerd-provider/types.js').ToolUseBlock} ToolUseBlock */
/** @typedef {import('/peerd-provider/types.js').ToolResultBlock} ToolResultBlock */

/** @param {number} i @returns {UserMessage} */
const userMsg = (i) => ({
  role: 'user', content: `u${i}`, id: `u${i}`, when: i,
});
/** @param {number} i @param {ToolUseBlock[]} [toolUses] @returns {AssistantMessage} */
const asstMsg = (i, toolUses) => ({
  role: 'assistant', content: `a${i}`, id: `a${i}`, when: i,
  ...(toolUses ? { toolUses } : {}),
});
/** @param {number} i @param {ToolResultBlock[]} results @returns {UserMessage} */
const toolResultMsg = (i, results) => ({
  role: 'user', content: '', id: `tr${i}`, when: i,
  toolResults: results,
});

// why: trim output content is `string | block[]`; in every assertion here
// it's a string (the synthesised summary). Narrow via cast at the read.
/** @param {{ content: string | unknown[] }} m @returns {string} */
const text = (m) => /** @type {string} */ (m.content);

/** @param {number} n @returns {(UserMessage | AssistantMessage)[]} */
const makeConversation = (n) => {
  /** @type {(UserMessage | AssistantMessage)[]} */
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(i % 2 === 0 ? userMsg(i) : asstMsg(i));
  }
  return out;
};

describe('trimHistory', () => {
  describe('no-op cases', () => {
    it('returns a shallow copy when length is at the soft cap', () => {
      const msgs = makeConversation(60);
      const out = trimHistory(msgs);
      expect(out.length).toBe(60);
      // Not the same array reference (defensive copy).
      expect(out === msgs).toBe(false);
      // First and last messages unchanged.
      expect(out[0].id).toBe('u0');
      expect(out[59].id).toBe('a59');
    });

    it('returns a copy when length is under the soft cap', () => {
      const msgs = makeConversation(20);
      const out = trimHistory(msgs);
      expect(out.length).toBe(20);
      expect(out[0].id).toBe('u0');
    });

    it('handles an empty array', () => {
      const out = trimHistory([]);
      expect(out).toEqual([]);
    });

    it('handles non-array input gracefully', () => {
      // why: trimHistory is typed for an array but guards non-array input
      // at runtime (returns []). Casts exercise that guard.
      expect(trimHistory(/** @type {never} */ (/** @type {unknown} */ (null)))).toEqual([]);
      expect(trimHistory(/** @type {never} */ (/** @type {unknown} */ (undefined)))).toEqual([]);
    });

    it('respects a custom softCap that keeps the array untrimmed', () => {
      const msgs = makeConversation(40);
      const out = trimHistory(msgs, { softCap: 100 });
      expect(out.length).toBe(40);
    });
  });

  describe('trim cases', () => {
    it('collapses oldest messages into one summary when over soft cap', () => {
      const msgs = makeConversation(80);
      const out = trimHistory(msgs);
      // 80 - 20 = 60 dropped, replaced by 1 summary. 1 + 20 = 21.
      expect(out.length).toBe(21);
      expect(out[0].synthetic).toBe(true);
      expect(out[0].role).toBe('user');
      expect(typeof out[0].content).toBe('string');
      // Recent messages preserved verbatim.
      expect(out[1].id).toBe('u60');
      expect(out[20].id).toBe('a79');
    });

    it('respects keepRecent and softCap overrides', () => {
      const msgs = makeConversation(50);
      const out = trimHistory(msgs, { keepRecent: 5, softCap: 30 });
      // 50 - 5 = 45 dropped → 1 summary + 5 recent = 6 total.
      expect(out.length).toBe(6);
      expect(out[0].synthetic).toBe(true);
      // messages[45] is odd-indexed → assistant. For PLAIN messages
      // trimHistory slices at the keepRecent boundary verbatim (the
      // 'u60' in the sibling test is even-index luck) — boundary
      // snapping only kicks in when the cut would land on a
      // tool_result-carrying user message (see the orphan test below).
      expect(out[1].id).toBe('a45');
      expect(out[5].id).toBe('a49');
    });

    it('never opens the kept window on an orphaned tool_result', () => {
      // Cut positioned to land EXACTLY on the tool_results message of a
      // tool round. The boundary must snap back one message so the
      // paired assistant tool_use stays in the window — the provider
      // 400s on a tool_result whose tool_use was trimmed away.
      const msgs = [];
      for (let i = 0; i < 30; i++) {
        msgs.push(i % 2 === 0 ? userMsg(i) : asstMsg(i));
      }
      msgs.push(asstMsg(30, [{ id: 't30', name: 'read_page', input: {} }]));
      msgs.push(toolResultMsg(31, [{ tool_use_id: 't30', content: 'r' }]));
      for (let i = 32; i < 65; i++) {
        msgs.push(i % 2 === 0 ? userMsg(i) : asstMsg(i));
      }
      const keepRecent = msgs.length - 31; // cut index 31 = tr31
      const out = trimHistory(msgs, { keepRecent, softCap: 60 });
      expect(out[0].synthetic).toBe(true);
      expect(out[1].id).toBe('a30');   // snapped onto the paired tool_use
      expect(out[2].id).toBe('tr31');  // result follows inside the window
    });

    it('summary message carries an id and a when timestamp', () => {
      const msgs = makeConversation(80);
      const out = trimHistory(msgs);
      expect(typeof out[0].id).toBe('string');
      expect(out[0].id.startsWith('trim-summary-')).toBe(true);
      // when matches the last dropped message's when (i=59).
      expect(out[0].when).toBe(59);
    });

    it('summary wraps the prose in a <conversation_trim_summary> block', () => {
      const msgs = makeConversation(80);
      const out = trimHistory(msgs);
      const body = text(out[0]);
      expect(body.startsWith('<conversation_trim_summary>')).toBe(true);
      expect(body.endsWith('</conversation_trim_summary>')).toBe(true);
    });

    it('summary counts user and assistant messages', () => {
      const msgs = makeConversation(80);
      const out = trimHistory(msgs);
      const body = text(out[0]);
      // Dropped 60: i=0..59 → 30 user (even i), 30 assistant (odd i).
      expect(body.includes('30 user messages')).toBe(true);
      expect(body.includes('30 assistant repl')).toBe(true);
    });

    it('summary lists tool names with usage counts', () => {
      const msgs = [
        userMsg(0),
        asstMsg(1, [{ id: 't1', name: 'read_page', input: {} }]),
        toolResultMsg(2, [{ tool_use_id: 't1', content: 'x' }]),
        userMsg(3),
        asstMsg(4, [
          { id: 't2', name: 'read_page', input: {} },
          { id: 't3', name: 'click', input: {} },
        ]),
        toolResultMsg(5, [
          { tool_use_id: 't2', content: 'y' },
          { tool_use_id: 't3', content: 'z' },
        ]),
        // Pad past the soft cap so a trim actually fires.
        ...makeConversation(80),
      ];
      const out = trimHistory(msgs);
      const body = text(out[0]);
      // read_page used twice, click once.
      expect(body.includes('read_page×2')).toBe(true);
      expect(body.includes('click')).toBe(true);
      // Single-use names omit the count suffix.
      expect(body.includes('click×1')).toBe(false);
    });

    it('summary surfaces error count from tool results', () => {
      const msgs = [
        asstMsg(1, [{ id: 't1', name: 'click', input: {} }]),
        toolResultMsg(2, [
          { tool_use_id: 't1', content: 'failed', is_error: true },
        ]),
        ...makeConversation(80),
      ];
      const out = trimHistory(msgs);
      const body = text(out[0]);
      expect(body.includes('errored')).toBe(true);
    });

    it('is deterministic — same input yields identical output', () => {
      const msgs = makeConversation(80);
      const a = trimHistory(msgs);
      const b = trimHistory(msgs);
      expect(a[0].content).toBe(b[0].content);
      expect(a[0].id).toBe(b[0].id);
      expect(a.length).toBe(b.length);
    });
  });
});
