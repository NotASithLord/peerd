// Rolling trim-summary core — fold/merge/render/parse, pure values only.

import { describe, test, expect } from 'bun:test';
import {
  emptySummaryState, normalizeSummaryState, foldDropped, mergeEnrichment,
  renderSummaryText, digestMessages, buildSummarizationTask,
  parseSummarizationResult,
  SUMMARY_MAX_ITEMS, SUMMARY_ITEM_MAX_CHARS, SUMMARY_MAX_CHARS,
} from '../../../extension/peerd-runtime/loop/rolling-summary.js';
import type { UserMessage, AssistantMessage } from '../../../extension/peerd-provider/types.js';

const userMsg = (i: number): UserMessage => ({ role: 'user', content: `u${i}`, id: `u${i}`, when: i });
const asstMsg = (i: number, toolUses?: any[]): AssistantMessage => ({
  role: 'assistant', content: `a${i}`, id: `a${i}`, when: i,
  ...(toolUses ? { toolUses } : {}),
});
const toolResultMsg = (i: number, results: any[]): UserMessage => ({
  role: 'user', content: '', id: `tr${i}`, when: i, toolResults: results,
});

describe('normalizeSummaryState', () => {
  test('garbage in → fresh empty state out', () => {
    for (const v of [null, undefined, 42, 'x', []]) {
      expect(normalizeSummaryState(v as any)).toEqual(emptySummaryState());
    }
  });

  test('preserves valid fields, drops invalid ones', () => {
    const s = normalizeSummaryState({
      covered: 5, coveredLastId: 'a4', users: 2, assistants: -1,
      tools: { click: 3, bad: 0, worse: 'x' as any },
      facts: ['  one  fact ', '', 'one fact', 42 as any],
      lastWhen: 99,
    });
    expect(s.covered).toBe(5);
    expect(s.coveredLastId).toBe('a4');
    expect(s.users).toBe(2);
    expect(s.assistants).toBe(0);            // negative rejected
    expect(s.tools).toEqual({ click: 3 });   // zero/garbage counts dropped
    expect(s.facts).toEqual(['one fact']);   // trimmed, deduped (case-insensitive)
    expect(s.lastWhen).toBe(99);
  });

  test('caps list items in length and count', () => {
    const s = normalizeSummaryState({
      facts: Array.from({ length: 30 }, (_, i) => `fact ${i} ${'x'.repeat(500)}`),
    });
    expect(s.facts.length).toBe(SUMMARY_MAX_ITEMS);
    for (const f of s.facts) expect(f.length).toBeLessThanOrEqual(SUMMARY_ITEM_MAX_CHARS);
  });
});

describe('foldDropped', () => {
  test('rolls counts forward across successive folds (the rolling property)', () => {
    const first = foldDropped(emptySummaryState(), [
      userMsg(0), asstMsg(1, [{ id: 't1', name: 'click', input: {} }]),
      toolResultMsg(2, [{ tool_use_id: 't1', content: 'r', is_error: true }]),
    ]);
    expect(first.covered).toBe(3);
    expect(first.coveredLastId).toBe('tr2');
    expect(first.users).toBe(1);
    expect(first.assistants).toBe(1);
    expect(first.toolResults).toBe(1);
    expect(first.errors).toBe(1);
    expect(first.tools).toEqual({ click: 1 });

    const second = foldDropped(first, [
      userMsg(3), asstMsg(4, [{ id: 't2', name: 'click', input: {} }, { id: 't3', name: 'read_page', input: {} }]),
      toolResultMsg(5, [{ tool_use_id: 't2', content: 'r' }, { tool_use_id: 't3', content: 'r' }]),
    ]);
    expect(second.covered).toBe(6);
    expect(second.coveredLastId).toBe('tr5');
    expect(second.users).toBe(2);
    expect(second.tools).toEqual({ click: 2, read_page: 1 });
    expect(second.toolResults).toBe(3);
    expect(second.errors).toBe(1);           // carried forward
    expect(second.lastWhen).toBe(5);
    // The first state is NOT mutated.
    expect(first.covered).toBe(3);
  });

  test('model-enriched sections survive a mechanical fold', () => {
    const enriched = mergeEnrichment(foldDropped(emptySummaryState(), [userMsg(0)]), {
      facts: ['the user is building a CRX'],
    });
    const folded = foldDropped(enriched, [asstMsg(1)]);
    expect(folded.facts).toEqual(['the user is building a CRX']);
  });

  test('pins the first user message as the task, set once', () => {
    const first = foldDropped(emptySummaryState(), [
      { role: 'user', content: 'build me a scraper', id: 'u0', when: 0 },
      asstMsg(1),
    ]);
    expect(first.task).toBe('build me a scraper');
    // A later user turn does NOT overwrite the pinned task.
    const second = foldDropped(first, [
      { role: 'user', content: 'now add pagination', id: 'u2', when: 2 },
    ]);
    expect(second.task).toBe('build me a scraper');
  });

  test('tool-result-only user messages and synthetic turns never become the task', () => {
    const s = foldDropped(emptySummaryState(), [
      toolResultMsg(0, [{ tool_use_id: 't', content: 'r' }]),
      { role: 'user', content: 'prior summary', id: 'syn', when: 1, synthetic: true } as any,
      { role: 'user', content: 'the real task', id: 'u2', when: 2 },
    ]);
    expect(s.task).toBe('the real task');
  });
});

describe('mergeEnrichment', () => {
  test('replaces structured lists (stale threads age out) without touching counts', () => {
    let s = foldDropped(emptySummaryState(), [userMsg(0), asstMsg(1)]);
    s = mergeEnrichment(s, { facts: ['f1'], decisions: ['d1'], threads: ['t1', 't2'] });
    expect(s.threads).toEqual(['t1', 't2']);
    s = mergeEnrichment(s, { threads: ['t2'] });
    expect(s.threads).toEqual(['t2']);       // replaced, not appended
    expect(s.facts).toEqual(['f1']);         // absent key → untouched
    expect(s.users).toBe(1);
    expect(s.covered).toBe(2);
  });

  test('ignores garbage', () => {
    const s = foldDropped(emptySummaryState(), [userMsg(0)]);
    expect(mergeEnrichment(s, null as any)).toEqual(s);
    expect(mergeEnrichment(s, { facts: 'nope' as any })).toEqual(s);
  });
});

describe('renderSummaryText', () => {
  test('mechanical-only render keeps the pinned format', () => {
    const s = foldDropped(emptySummaryState(), [
      userMsg(0), asstMsg(1, [{ id: 't1', name: 'read_page', input: {} }]),
      toolResultMsg(2, [{ tool_use_id: 't1', content: 'r' }]),
    ]);
    const text = renderSummaryText(s);
    expect(text.startsWith('<conversation_trim_summary>')).toBe(true);
    expect(text.endsWith('</conversation_trim_summary>')).toBe(true);
    expect(text).toContain('1 user message');
    expect(text).toContain('tools used: read_page');
    // No empty structured sections.
    expect(text).not.toContain('Facts:');
    expect(text).not.toContain('Open threads:');
  });

  test('enriched render includes structured facts/decisions/open-threads', () => {
    const s = mergeEnrichment(foldDropped(emptySummaryState(), [userMsg(0)]), {
      facts: ['site is example.com'], decisions: ['use the API path'], threads: ['form not submitted yet'],
    });
    const text = renderSummaryText(s);
    expect(text).toContain('Facts:\n  - site is example.com');
    expect(text).toContain('Decisions:\n  - use the API path');
    expect(text).toContain('Open threads:\n  - form not submitted yet');
  });

  test('renders a Goal line: the verbatim task as a floor, the model goal when present', () => {
    const task = foldDropped(emptySummaryState(), [
      { role: 'user', content: 'scrape the catalog', id: 'u0', when: 0 },
    ]);
    expect(renderSummaryText(task)).toContain('Goal: scrape the catalog');
    // Model-refined goal wins over the raw task.
    const refined = mergeEnrichment(task, { goal: 'export the product catalog to CSV' });
    expect(renderSummaryText(refined)).toContain('Goal: export the product catalog to CSV');
  });

  test('renders an Artifacts / handles section', () => {
    const s = mergeEnrichment(emptySummaryState(), { artifacts: ['tab 7 (checkout)', 'webvm: build-box'] });
    const text = renderSummaryText(s);
    expect(text).toContain('Artifacts / handles:\n  - tab 7 (checkout)');
    expect(text).toContain('  - webvm: build-box');
  });

  test('size cap drops structured items (threads first) rather than overflowing', () => {
    const big = (n: number) => Array.from({ length: n }, (_, i) => `item ${i} ${'x'.repeat(SUMMARY_ITEM_MAX_CHARS - 10)}`);
    const s = mergeEnrichment(emptySummaryState(), {
      facts: big(10), decisions: big(10), threads: big(10),
    });
    const text = renderSummaryText(s);
    expect(text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    // Counts survive — they're load-bearing.
    expect(text).toContain('0 user messages');
  });
});

describe('digestMessages', () => {
  test('keeps text turns, compresses tool rounds to counts', () => {
    const digest = digestMessages([
      { role: 'user', content: 'find me a flight', id: 'u0', when: 0 },
      asstMsg(1, [{ id: 't1', name: 'web_search', input: {} }]),
      toolResultMsg(2, [{ tool_use_id: 't1', content: 'HUGE PAGE'.repeat(100), is_error: false }]),
      { role: 'assistant', content: 'found three options', id: 'a3', when: 3 },
    ] as any);
    expect(digest).toContain('User: find me a flight');
    expect(digest).toContain('[tools: web_search]');
    expect(digest).toContain('[1 tool result]');
    expect(digest).toContain('Assistant: found three options');
    expect(digest).not.toContain('HUGE PAGE');
  });

  test('over-budget digests elide the middle, keeping head and tail', () => {
    const msgs = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${'y'.repeat(120)}`, id: `m${i}`, when: i,
    }));
    const digest = digestMessages(msgs as any, { maxChars: 2000 });
    expect(digest.length).toBeLessThan(2300);
    expect(digest).toContain('[... elided ...]');
    expect(digest).toContain('turn 0');
    expect(digest).toContain('turn 199');
  });
});

describe('buildSummarizationTask / parseSummarizationResult', () => {
  test('task carries the prior summary and the digest, demands JSON', () => {
    const state = mergeEnrichment(emptySummaryState(), { facts: ['prior fact'] });
    const task = buildSummarizationTask({ state, droppedDigest: 'User: hello' });
    expect(task).toContain('prior fact');
    expect(task).toContain('User: hello');
    expect(task).toContain('"facts"');
  });

  test('parses plain JSON, fenced JSON, and alias keys', () => {
    expect(parseSummarizationResult('{"facts":["f"],"decisions":[],"threads":["t"]}'))
      .toEqual({ goal: '', facts: ['f'], decisions: [], threads: ['t'], artifacts: [] });
    expect(parseSummarizationResult('Sure!\n```json\n{"facts":[],"decisions":["d"],"openThreads":["t"]}\n```'))
      .toEqual({ goal: '', facts: [], decisions: ['d'], threads: ['t'], artifacts: [] });
  });

  test('parses goal + artifacts (handles alias)', () => {
    expect(parseSummarizationResult('{"goal":"book a flight","handles":["tab 7","/tmp/x"]}'))
      .toEqual({ goal: 'book a flight', facts: [], decisions: [], threads: [], artifacts: ['tab 7', '/tmp/x'] });
  });

  test('unparseable output → null, never a throw', () => {
    expect(parseSummarizationResult('')).toBe(null);
    expect(parseSummarizationResult('no json here')).toBe(null);
    expect(parseSummarizationResult('{broken')).toBe(null);
  });
});

// ---- mechanical handle harvest -----------------------------------------------
// The user requirement: "if a session creates an app or workbook it retains
// where that is even after summarization/trim." Handles are harvested
// DETERMINISTICALLY (no model needed) and are never destroyed by the optional
// enrichment layer.
describe('handle harvest (durable engine instances)', () => {
  const createResult = (i: number, primitive: string, id: string, name: string): any => ({
    role: 'user', content: '', id: `tr${i}`, when: i,
    toolResults: [{
      tool_use_id: `tu${i}`,
      content: JSON.stringify({ id, name, url: `x#${id}` }) + '\n<note>created.</note>',
      is_error: false,
      meta: { toolName: `${primitive}_create`, primitive, sideEffect: 'write', origins: [], durationMs: 50 },
    }],
  });

  test('folds an app_create id+name into handles, and renders it', () => {
    const s = foldDropped(emptySummaryState(), [createResult(1, 'app', 'app-7f3a', 'dashboard')]);
    expect(s.handles).toEqual(['app app-7f3a "dashboard"']);
    expect(renderSummaryText(s)).toContain('app app-7f3a "dashboard"');
  });

  test('harvests notebook + webvm too, dedups repeats, ignores non-engine & errors', () => {
    let s = foldDropped(emptySummaryState(), [
      createResult(1, 'notebook', 'nb-1', 'scratch'),
      createResult(2, 'webvm', 'vm-9', 'build-box'),
      createResult(3, 'app', 'app-7f3a', 'dashboard'),
      createResult(4, 'app', 'app-7f3a', 'dashboard'), // dup id+name → one entry
      // a read on a page (non-engine) with a stray "id" must NOT be harvested
      { role: 'user', content: '', id: 'tr5', when: 5, toolResults: [{
        tool_use_id: 'tu5', content: '{"id":"not-a-handle"}', is_error: false,
        meta: { toolName: 'read_page', primitive: 'web', sideEffect: 'read', origins: [] } }] },
      // an errored create carries no live handle
      { role: 'user', content: '', id: 'tr6', when: 6, toolResults: [{
        tool_use_id: 'tu6', content: '{"id":"app-dead"}', is_error: true,
        meta: { toolName: 'app_create', primitive: 'app', sideEffect: 'write', origins: [] } }] },
    ]);
    expect(s.handles).toEqual(['notebook nb-1 "scratch"', 'webvm vm-9 "build-box"', 'app app-7f3a "dashboard"']);
    expect(s.handles).not.toContain('not-a-handle');
    expect(s.handles).not.toContain('app-dead');
  });

  test('the optional model enrichment can NEVER wipe a harvested handle', () => {
    let s = foldDropped(emptySummaryState(), [createResult(1, 'app', 'app-7f3a', 'dashboard')]);
    // a later enrichment that returns its OWN artifacts (and forgets the app)
    s = mergeEnrichment(s, { goal: 'build a dashboard', artifacts: ['some-other-ref'] });
    const text = renderSummaryText(s);
    expect(text).toContain('app app-7f3a "dashboard"'); // handle survives
    expect(text).toContain('some-other-ref');           // model artifact also shown
  });

  test('harvests a handle even from an already-COMPACTED spine body', () => {
    // After lineage compaction the create body is a spine, not JSON; the
    // harvester must still read the id back out of it.
    const spine = '‹elided› app_create · app · ok · id=app-7f3a "dashboard" · 312 chars';
    const s = foldDropped(emptySummaryState(), [{
      role: 'user', content: '', id: 'tr1', when: 1,
      toolResults: [{ tool_use_id: 'tu1', content: spine, is_error: false,
        meta: { toolName: 'app_create', primitive: 'app', sideEffect: 'write', origins: [] } }],
    } as any]);
    expect(s.handles).toEqual(['app app-7f3a "dashboard"']);
  });

  test('handles survive a normalize round-trip (persisted across SW restart)', () => {
    const s = foldDropped(emptySummaryState(), [createResult(1, 'app', 'app-7f3a', 'dashboard')]);
    const reloaded = normalizeSummaryState(JSON.parse(JSON.stringify(s)));
    expect(reloaded.handles).toEqual(['app app-7f3a "dashboard"']);
  });
});
