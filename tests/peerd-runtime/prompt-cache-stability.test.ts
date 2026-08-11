// Design 01 — prompt-cache stability.
//
// The bug this pins: the volatile `<time>now …</time>` block used to be
// substituted INTO the system string, so the (large) cached system block was a
// cache MISS on every turn (seconds-resolution). The fix relocates all per-turn
// volatile bytes (temporal + active tab) to a leading <context> MESSAGE that
// lands AFTER the system + tool cache breakpoints, leaving the main system
// string byte-stable within a session.
//
// These are the pure surfaces: renderSystemPrompt (now clock-free on the main
// path), buildTemporalContext (carries the volatile bytes), and the to-anthropic
// wire mapping (breakpoints land on system + last tool; the context message
// carries none).

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  renderSystemPrompt,
  buildTemporalContext,
  _setTemplateForTests,
} from '../../extension/peerd-runtime/loop/system-prompt.js';
import { buildTemporalBlock } from '../../extension/peerd-runtime/clock/context.js';
import { toAnthropicBody } from '../../extension/peerd-provider/format/to-anthropic.js';
import type { InternalMessage } from '../../extension/peerd-provider/types.js';

const TEMPLATE = readFileSync(
  join(import.meta.dir, '..', '..', 'extension', 'peerd-provider', 'system-prompt.txt'),
  'utf8',
);
// An ISO-8601 clock with seconds — exactly what used to bust the cache.
const ISO_SECONDS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

describe('renderSystemPrompt — the main system string is byte-stable', () => {
  test('the shipped template no longer carries a per-turn {{DATE}} line', () => {
    // {{TEMPORAL_BLOCK}} stays (the actor path still embeds it), but the date
    // line is gone — the ISO in the temporal block already carries the date.
    expect(TEMPLATE.includes('{{DATE}}')).toBe(false);
  });

  test('the main render (temporalBlock: "") carries no timestamp and is deterministic', async () => {
    _setTemplateForTests(TEMPLATE);
    // The exact args the orchestrator passes on the main path: no temporalBlock
    // (relocated to the context message), no activeTab (ditto). renderSystemPrompt
    // now reads no wall-clock at all, so two calls are byte-identical and the
    // output holds no time-derived bytes. This fails loudly if a volatile clock
    // read (a re-added `new Date()` / {{DATE}} substitution) creeps back in — a
    // re-added ISO/date stamp would land in the output and trip the regexes.
    const args = { memoryBlock: '<memory>ws facts</memory>', skillsBlock: '', temporalBlock: '' };
    const a = await renderSystemPrompt(args);
    const b = await renderSystemPrompt(args);
    expect(a).toBe(b);
    expect(ISO_SECONDS.test(a)).toBe(false);
    expect(/\d{4}-\d{2}-\d{2}/.test(a)).toBe(false); // no stray date-only stamp either
  });

  test('the actor path still embeds the temporal block (its prompt re-renders per turn)', async () => {
    _setTemplateForTests(TEMPLATE);
    const block = buildTemporalBlock({ lastTurnAt: null, nowMs: Date.parse('2026-08-03T12:00:00Z') });
    const out = await renderSystemPrompt({ actorType: 'notebook', temporalBlock: block });
    expect(out.includes(block)).toBe(true);
  });
});

describe('buildTemporalContext — carries the volatile bytes, pure', () => {
  test('wraps the temporal block (and its timestamp) in a <context> message', () => {
    const block = buildTemporalBlock({ lastTurnAt: null, nowMs: Date.parse('2026-08-03T12:00:00Z') });
    const out = buildTemporalContext({ temporalBlock: block });
    expect(out.startsWith('<context>')).toBe(true);
    expect(out.endsWith('</context>')).toBe(true);
    expect(out.includes(block)).toBe(true);
    expect(ISO_SECONDS.test(out)).toBe(true); // the clock lives HERE now
  });

  test('same inputs → same output (pure, no clock read)', () => {
    const block = '<time>now 2026-08-03T12:00:00Z</time>';
    const tab = { url: 'https://example.com/p', title: 'Example' };
    expect(buildTemporalContext({ temporalBlock: block, activeTab: tab }))
      .toBe(buildTemporalContext({ temporalBlock: block, activeTab: tab }));
  });

  test('empty when there is nothing volatile to send', () => {
    expect(buildTemporalContext({})).toBe('');
    expect(buildTemporalContext({ temporalBlock: '', activeTab: null })).toBe('');
  });

  test('carries only a safe policy marker for a protected foreground tab', () => {
    const out = buildTemporalContext({ protectedTab: 'private_network' });
    expect(out).toContain('<protected_tab>');
    expect(out).toContain('private-network page');
    expect(out).not.toContain('192.168');
    expect(out).toContain('Do not claim to read, summarize');
  });
});

describe('to-anthropic — breakpoints land on system + last tool, not the context message', () => {
  const EPHEMERAL = { type: 'ephemeral' };
  const tools = [
    { name: 'a', description: 'first', schema: { type: 'object', properties: {} } },
    { name: 'b', description: 'last', schema: { type: 'object', properties: {} } },
  ];
  // A conversation that opens with the leading <context> message, then real
  // history. Alternating roles so nothing collapses and the context stays msg[0].
  const contextMsg = buildTemporalContext({ temporalBlock: '<time>now 2026-08-03T12:00:00Z</time>' });
  const messages: InternalMessage[] = [
    { role: 'user', content: contextMsg, id: 'ctx', when: 1 },
    { role: 'assistant', content: 'hi', id: 'a1', when: 2 },
    { role: 'user', content: 'do the thing', id: 'u1', when: 3 },
  ];

  test('system block keeps its cache breakpoint', () => {
    const body = toAnthropicBody({ model: 'claude-x', system: 'STABLE SYSTEM', messages, tools });
    expect(body.system[0].text).toBe('STABLE SYSTEM');
    expect(body.system[0].cache_control).toEqual(EPHEMERAL);
  });

  test('the LAST tool keeps its cache breakpoint; earlier tools do not', () => {
    const body = toAnthropicBody({ model: 'claude-x', system: 'S', messages, tools });
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual(EPHEMERAL);
  });

  test('the leading context message carries NO cache_control (stays plain string)', () => {
    const body = toAnthropicBody({ model: 'claude-x', system: 'S', messages, tools });
    const head = body.messages[0];
    // still the context bytes, un-wrapped (only the LAST message gets wrapped)
    expect(typeof head.content).toBe('string');
    expect(head.content).toBe(contextMsg);
  });

  test('the system block is invariant to the context message content (the cache-stability contract)', () => {
    const withCtxA = toAnthropicBody({
      model: 'claude-x', system: 'STABLE SYSTEM', tools,
      messages: [{ role: 'user', content: buildTemporalContext({ temporalBlock: '<time>now 2026-08-03T12:00:00Z</time>' }), id: 'c', when: 1 },
        { role: 'assistant', content: 'x', id: 'a', when: 2 }],
    });
    const withCtxB = toAnthropicBody({
      model: 'claude-x', system: 'STABLE SYSTEM', tools,
      messages: [{ role: 'user', content: buildTemporalContext({ temporalBlock: '<time>now 2099-01-01T00:00:00Z</time>' }), id: 'c', when: 1 },
        { role: 'assistant', content: 'x', id: 'a', when: 2 }],
    });
    // Different volatile context, byte-identical cached system prefix.
    expect(withCtxA.system[0].text).toBe(withCtxB.system[0].text);
    expect(withCtxA.system[0].cache_control).toEqual(withCtxB.system[0].cache_control);
  });

  test('turn-1 wire shape: the <context> survives collapse into the following user message and the breakpoint lands on the merged block', () => {
    // The REAL production shape on turn 1: the leading context user-string is
    // immediately followed by the actual user message. The converter collapses
    // adjacent same-role plain strings, so both fold into ONE user message — the
    // <context> fence must survive the merge and the last-message breakpoint must
    // attach to the merged block.
    const ctx = buildTemporalContext({ temporalBlock: '<time>now 2026-08-03T12:00:00Z</time>' });
    const body = toAnthropicBody({
      model: 'claude-x', system: 'S', tools,
      messages: [
        { role: 'user', content: ctx, id: 'ctx', when: 1 },
        { role: 'user', content: 'do the thing', id: 'u1', when: 2 },
      ],
    });
    expect(body.messages.length).toBe(1); // two user strings collapsed into one
    const merged = body.messages[0];
    // last message → wrapped into a text block carrying the breakpoint
    expect(Array.isArray(merged.content)).toBe(true);
    const block = merged.content[0];
    expect(block.text.includes('<context>')).toBe(true); // fence survived the merge
    expect(block.text.includes('do the thing')).toBe(true); // real user text present
    expect(block.cache_control).toEqual(EPHEMERAL);
  });
});
