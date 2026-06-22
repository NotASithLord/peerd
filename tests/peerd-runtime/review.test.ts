import { describe, test, expect } from 'bun:test';
import {
  makeRequestReview,
} from '../../extension/peerd-runtime/review/orchestrator.js';
import {
  parseReviewSummary,
  worstSeverity,
} from '../../extension/peerd-runtime/review/schema.js';
import {
  readOnlyToolNames,
  isReadOnlyTool,
  intersectReadOnly,
} from '../../extension/peerd-runtime/review/read-only.js';
import {
  synthesizeDiff,
  fromCheckpointDiff,
  renderDiffForReview,
} from '../../extension/peerd-runtime/review/diff.js';
import { buildReviewTask } from '../../extension/peerd-runtime/review/prompt.js';

// A registry mirroring the real mix: read tools + write/mutate tools +
// the always-denied orchestration tools.
const DESCRIPTORS = [
  { name: 'read_page', sideEffect: 'read' },
  { name: 'query_dom', sideEffect: 'read' },
  { name: 'app_read_file', sideEffect: 'read' },
  { name: 'inspect_storage', sideEffect: 'read' },
  { name: 'click', sideEffect: 'write' },
  { name: 'navigate', sideEffect: 'write' },
  { name: 'page_exec', sideEffect: 'write' },
  { name: 'app_write_file', sideEffect: 'write' },
  { name: 'submit_form', sideEffect: 'mutate_external' },
  { name: 'spawn_subagent', sideEffect: 'write' },
  { name: 'request_review', sideEffect: 'read' }, // read-classified, but self-denied
];

// ---- read-only enforcement ------------------------------------------------

describe('readOnlyToolNames', () => {
  test('keeps only read tools and drops orchestration tools', () => {
    const names = readOnlyToolNames(DESCRIPTORS);
    expect(names).toEqual(['read_page', 'query_dom', 'app_read_file', 'inspect_storage']);
  });

  test('EXPOSES NO write or mutate_external tools to the reviewer', () => {
    const names = new Set(readOnlyToolNames(DESCRIPTORS));
    for (const d of DESCRIPTORS) {
      if (d.sideEffect !== 'read') expect(names.has(d.name)).toBe(false);
    }
    // explicit: none of the dangerous tools leak in
    for (const w of ['click', 'navigate', 'page_exec', 'app_write_file', 'submit_form', 'spawn_subagent']) {
      expect(names.has(w)).toBe(false);
    }
  });

  test('always-denied tools are excluded even when read-classified', () => {
    // request_review is sideEffect:'read' but must never be handed to a reviewer
    expect(readOnlyToolNames(DESCRIPTORS)).not.toContain('request_review');
  });
});

describe('isReadOnlyTool (call-time defense in depth)', () => {
  test('allows read tools, refuses write/mutate/unknown', () => {
    expect(isReadOnlyTool('read_page', DESCRIPTORS)).toBe(true);
    expect(isReadOnlyTool('click', DESCRIPTORS)).toBe(false);
    expect(isReadOnlyTool('submit_form', DESCRIPTORS)).toBe(false);
    expect(isReadOnlyTool('spawn_subagent', DESCRIPTORS)).toBe(false);
    expect(isReadOnlyTool('hallucinated_tool', DESCRIPTORS)).toBe(false); // fail closed
  });
});

describe('intersectReadOnly', () => {
  test('with no external set, returns the local set unchanged', () => {
    const local = ['a', 'b', 'c'];
    expect(intersectReadOnly(local, null)).toEqual(local);
  });
  test('intersects — neither set can widen the other', () => {
    expect(intersectReadOnly(['a', 'b', 'c'], new Set(['b', 'c', 'z']))).toEqual(['b', 'c']);
    expect(intersectReadOnly(['a', 'b'], ['x'])).toEqual([]);
  });
});

// ---- structured summary parse/validate ------------------------------------

describe('worstSeverity', () => {
  test('picks the worst (lowest-rank) severity', () => {
    expect(worstSeverity([{ severity: 'low' }, { severity: 'high' }, { severity: 'info' }] as any)).toBe('high');
    expect(worstSeverity([] as any)).toBe('info');
  });
});

describe('parseReviewSummary', () => {
  test('parses a well-formed reviewer block with issues', () => {
    const raw = [
      'Here is my review.',
      '```json',
      JSON.stringify({
        verdict: 'request_changes',
        summary: 'One real bug.',
        issues: [
          { severity: 'high', title: 'Dropped await', detail: 'fetch not awaited', location: 'app.js:10', fix: 'add await' },
          { severity: 'low', title: 'nit' },
        ],
      }),
      '```',
    ].join('\n');
    const { ok, summary } = parseReviewSummary(raw);
    expect(ok).toBe(true);
    expect(summary.verdict).toBe('request_changes');
    expect(summary.severity).toBe('high'); // derived from worst issue
    expect(summary.issues.length).toBe(2);
    expect(summary.issues[0].fix).toBe('add await');
  });

  test('reads the LAST fenced block when a scratch block precedes the answer', () => {
    // A reasoning model often shows an example/scratch block first; the
    // committed answer is the final fence.
    const raw = [
      '```json', '{"verdict":"comment","issues":[]}', '```',
      'final:',
      '```json', '{"verdict":"approve","issues":[]}', '```',
    ].join('\n');
    expect(parseReviewSummary(raw).summary.verdict).toBe('approve');
  });

  test('falls back to bare braces when the model emits no fence', () => {
    const { ok, summary } = parseReviewSummary('here you go {"verdict":"approve","issues":[]} done');
    expect(ok).toBe(true);
    expect(summary.verdict).toBe('approve');
  });

  test('overrides an over-optimistic approve when a high issue exists', () => {
    const raw = '```json\n' + JSON.stringify({
      verdict: 'approve',
      issues: [{ severity: 'critical', title: 'secret in storage' }],
    }) + '\n```';
    const { summary } = parseReviewSummary(raw);
    // model said approve, but critical present → coerced to request_changes
    expect(summary.verdict).toBe('request_changes');
    expect(summary.severity).toBe('critical');
  });

  test('clean review → approve with empty issues', () => {
    const raw = '```json\n{"verdict":"approve","issues":[]}\n```';
    const { ok, summary } = parseReviewSummary(raw);
    expect(ok).toBe(true);
    expect(summary.verdict).toBe('approve');
    expect(summary.severity).toBe('info');
    expect(summary.issues).toEqual([]);
  });

  test('malformed output never throws — returns a well-formed fallback', () => {
    const { ok, summary, parseError } = parseReviewSummary('I could not produce JSON, sorry.');
    expect(ok).toBe(false);
    expect(parseError).toBe('no_json_block');
    expect(summary.verdict).toBe('comment');
    expect(summary.issues.length).toBe(1);
    expect(summary.issues[0].severity).toBe('info');
  });

  test('invalid JSON inside a fence → fallback, no throw', () => {
    const { ok, parseError, summary } = parseReviewSummary('```json\n{ not valid }\n```');
    expect(ok).toBe(false);
    expect(parseError).toContain('json_parse');
    expect(summary.issues[0].title).toContain('could not be parsed');
  });

  test('coerces unknown severities to info', () => {
    const raw = '```json\n' + JSON.stringify({ verdict: 'comment', issues: [{ severity: 'apocalyptic', title: 'x' }] }) + '\n```';
    const { summary } = parseReviewSummary(raw);
    expect(summary.issues[0].severity).toBe('info');
  });
});

// ---- diff sourcing --------------------------------------------------------

describe('synthesizeDiff', () => {
  test('detects added, modified, deleted', () => {
    const before = { 'a.js': 'old', 'b.js': 'keep', 'gone.js': 'bye' };
    const after = { 'a.js': 'new', 'b.js': 'keep', 'c.js': 'fresh' };
    const cs = synthesizeDiff(before, after);
    const byPath = Object.fromEntries(cs.files.map((f) => [f.path, f.status]));
    expect(byPath['a.js']).toBe('modified');
    expect(byPath['c.js']).toBe('added');
    expect(byPath['gone.js']).toBe('deleted');
    expect(byPath['b.js']).toBeUndefined(); // unchanged → not in diff
  });
});

describe('fromCheckpointDiff (feature 02 adapter)', () => {
  test('normalizes a {files:[...]} changeset', () => {
    const cs = fromCheckpointDiff({ ref: 'cp-1', files: [{ path: 'x.js', status: 'modified', before: 'a', after: 'b' }] });
    expect(cs.ref).toBe('cp-1');
    expect(cs.files[0].path).toBe('x.js');
  });
  test('normalizes a bare array and defaults an unknown status to modified', () => {
    const cs = fromCheckpointDiff([{ path: 'y.js', status: 'weird', after: 'z' }]);
    expect(cs.files[0].status).toBe('modified');
  });
  test('empty/garbage input → empty changeset', () => {
    expect(fromCheckpointDiff(null).files).toEqual([]);
    expect(fromCheckpointDiff({}).files).toEqual([]);
  });
});

describe('renderDiffForReview + buildReviewTask', () => {
  test('renders changed files and wraps the diff as untrusted data', () => {
    const cs = synthesizeDiff({ 'a.js': 'x' }, { 'a.js': 'y', 'b.js': 'new' });
    const diffText = renderDiffForReview(cs);
    expect(diffText).toContain('MODIFIED: a.js');
    expect(diffText).toContain('ADDED: b.js');
    const task = buildReviewTask({ diffText, focus: 'the auth path' });
    expect(task).toContain('<diff>');
    expect(task).toContain('CLEAN CONTEXT');
    expect(task).toContain('the auth path');
    expect(task).toContain('lethal trifecta'.split(' ')[1]); // checklist present
    expect(task).toContain('```json'); // tells reviewer the output schema
  });
});

// ---- orchestrator end-to-end (mocked reviewer run) ------------------------

// A mock spawnSubagent capturing what the orchestrator hands the reviewer.
const makeMockSpawn = (result: string) => {
  const calls: any[] = [];
  const spawn = async (req: any) => {
    calls.push(req);
    return { result, sessionId: 'rev-1', toolCalls: 0, durationMs: 5 };
  };
  return { spawn, calls };
};

describe('makeRequestReview (clean-context, read-only, structured)', () => {
  const reviewerJson = '```json\n' + JSON.stringify({
    verdict: 'request_changes',
    summary: 'Found a dropped await.',
    issues: [{ severity: 'high', title: 'Dropped await', location: 'a.js:1', fix: 'await it' }],
  }) + '\n```';

  test('spawns the reviewer with ONLY read-only tools (no write tools)', async () => {
    const { spawn, calls } = makeMockSpawn(reviewerJson);
    const audits: any[] = [];
    const requestReview = makeRequestReview({
      spawnSubagent: spawn,
      getToolDescriptors: () => DESCRIPTORS,
      appendAudit: async (e: any) => { audits.push(e); },
    });

    const out = await requestReview({
      parentSessionId: 'p-1',
      before: { 'a.js': 'old' },
      after: { 'a.js': 'new' },
    });

    // the reviewer was granted exactly the read-only set
    const granted = new Set(calls[0].tools);
    expect([...granted].sort()).toEqual(['app_read_file', 'inspect_storage', 'query_dom', 'read_page']);
    // ASSERT: no write/mutate/orchestration tool exposed
    for (const w of ['click', 'navigate', 'page_exec', 'app_write_file', 'submit_form', 'spawn_subagent', 'request_review']) {
      expect(granted.has(w)).toBe(false);
    }
    // recursion explicitly disabled
    expect(calls[0].allowRecursion).toBe(false);

    // the structured summary parsed + surfaced
    expect(out.ok).toBe(true);
    expect(out.summary!.verdict).toBe('request_changes');
    expect(out.summary!.severity).toBe('high');
    expect(out.summary!.issues[0].title).toBe('Dropped await');
    expect(out.sessionId).toBe('rev-1');

    // audited both ends
    expect(audits.some((a) => a.type === 'review_requested')).toBe(true);
    expect(audits.some((a) => a.type === 'review_completed')).toBe(true);
  });

  test('passes the rendered diff (untrusted-wrapped) as the reviewer task', async () => {
    const { spawn, calls } = makeMockSpawn(reviewerJson);
    const requestReview = makeRequestReview({ spawnSubagent: spawn, getToolDescriptors: () => DESCRIPTORS });
    await requestReview({ parentSessionId: 'p-1', before: { 'a.js': 'old' }, after: { 'a.js': 'new' }, focus: 'security' });
    expect(calls[0].task).toContain('<diff>');
    expect(calls[0].task).toContain('MODIFIED: a.js');
    expect(calls[0].task).toContain('security');
    // clean context: the reviewer task carries the diff, not parent history
    expect(calls[0].parentSessionId).toBe('p-1');
  });

  test('intersects the read-only set with a feature-03 permissions adapter', async () => {
    const { spawn, calls } = makeMockSpawn(reviewerJson);
    const requestReview = makeRequestReview({
      spawnSubagent: spawn,
      getToolDescriptors: () => DESCRIPTORS,
      // feature 03 says only read_page is permitted in this mode
      permissions: { readOnlyTools: () => ['read_page'] },
    });
    await requestReview({ parentSessionId: 'p-1', before: { 'a.js': '1' }, after: { 'a.js': '2' } });
    expect(calls[0].tools).toEqual(['read_page']); // intersection, narrowed further
  });

  test('uses the feature-02 checkpoints adapter when no explicit diff', async () => {
    const { spawn, calls } = makeMockSpawn(reviewerJson);
    const requestReview = makeRequestReview({
      spawnSubagent: spawn,
      getToolDescriptors: () => DESCRIPTORS,
      checkpoints: { diffSince: async (ref?: string) => ({ ref, files: [{ path: 'svc.js', status: 'modified', before: 'a', after: 'b' }] }) },
    });
    const out = await requestReview({ parentSessionId: 'p-1', since: 'cp-42' });
    expect(calls[0].task).toContain('MODIFIED: svc.js');
    expect(out.ok).toBe(true);
  });

  test('empty changeset short-circuits to approve without spawning', async () => {
    const { spawn, calls } = makeMockSpawn(reviewerJson);
    const requestReview = makeRequestReview({ spawnSubagent: spawn, getToolDescriptors: () => DESCRIPTORS });
    const out = await requestReview({ parentSessionId: 'p-1', before: { 'a.js': 'same' }, after: { 'a.js': 'same' } });
    expect(calls.length).toBe(0); // no reviewer spawned
    expect(out.ok).toBe(true);
    expect(out.summary!.verdict).toBe('approve');
  });

  test('no diff source at all → error, not a crash', async () => {
    const { spawn } = makeMockSpawn(reviewerJson);
    const requestReview = makeRequestReview({ spawnSubagent: spawn, getToolDescriptors: () => DESCRIPTORS });
    const out = await requestReview({ parentSessionId: 'p-1' });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('no_diff_source');
  });

  test('a refused spawn surfaces as an error result', async () => {
    const spawn = async () => ({ result: 'subagent refused: max depth', sessionId: null, toolCalls: 0, durationMs: 0, refused: true as const });
    const requestReview = makeRequestReview({ spawnSubagent: spawn, getToolDescriptors: () => DESCRIPTORS });
    const out = await requestReview({ parentSessionId: 'p-1', before: { 'a.js': '1' }, after: { 'a.js': '2' } });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('refused');
  });

  test('a malformed reviewer run still returns a structured (fallback) summary', async () => {
    const { spawn } = makeMockSpawn('the model rambled without JSON');
    const requestReview = makeRequestReview({ spawnSubagent: spawn, getToolDescriptors: () => DESCRIPTORS });
    const out = await requestReview({ parentSessionId: 'p-1', before: { 'a.js': '1' }, after: { 'a.js': '2' } });
    expect(out.ok).toBe(false);
    expect(out.parseError).toBe('no_json_block');
    expect(out.summary!.verdict).toBe('comment'); // well-formed fallback shape
  });
});
