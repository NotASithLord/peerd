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

// A registry mirroring the REAL mix, using REAL tool names and their REAL
// sideEffect tags. why real names: the previous fixture used invented ones
// (`inspect_storage`) and asserted `app_read_file` IS grantable — the opposite
// of what the live pipeline does (filterActorSurface drops it). A fixture that
// asserts fiction is worse than no fixture: it is how issue #160 came to be
// filed on a false premise, and how the grant below went unpinned entirely.
//
// NOTE the entries tagged `read` that are NOT safe for a reviewer — fetch_url
// above all (arbitrary url + method + body). They are here precisely so the
// tests below prove they never reach the reviewer.
const DESCRIPTORS = [
  // read-tagged AND on the reviewer's allowlist
  { name: 'inspect', sideEffect: 'read' },
  { name: 'read_memory', sideEffect: 'read' },
  { name: 'actor_list', sideEffect: 'read' },
  { name: 'now', sideEffect: 'read' },
  // read-tagged but NOT for a reviewer — egress / page / instance reach
  { name: 'fetch_url', sideEffect: 'read' },          // arbitrary url+method+body
  { name: 'read_page', sideEffect: 'read' },
  { name: 'query_dom', sideEffect: 'read' },
  { name: 'read_web_cache', sideEffect: 'read' },
  { name: 'site_client_run', sideEffect: 'read' },
  { name: 'dweb_discover', sideEffect: 'read' },
  { name: 'js_read_file', sideEffect: 'read' },       // actor-only tier (#159)
  { name: 'pod_read', sideEffect: 'read' },           // actor-only tier (#159)
  { name: 'app_read_file', sideEffect: 'read' },      // actor-only tier (#159)
  { name: 'app_list_files', sideEffect: 'read' },     // actor-only tier (#159)
  // writes / mutations
  { name: 'click', sideEffect: 'write' },
  { name: 'navigate', sideEffect: 'write' },
  { name: 'page_exec', sideEffect: 'write' },
  { name: 'app_write_file', sideEffect: 'write' },
  { name: 'message_actor', sideEffect: 'write' },
  { name: 'submit_form', sideEffect: 'mutate_external' },
  { name: 'actor_create', sideEffect: 'write' },
  { name: 'request_review', sideEffect: 'read' }, // read-classified, but self-denied
];

// ---- read-only enforcement ------------------------------------------------

describe('readOnlyToolNames', () => {
  test('grants only names on the positive allowlist', () => {
    const names = readOnlyToolNames(DESCRIPTORS);
    expect(names.sort()).toEqual([
      'actor_list', 'inspect', 'now', 'read_memory',
      'js_read_file', 'pod_read', 'app_read_file', 'app_list_files',   // #160
    ].sort());
  });

  test('EXPOSES NO write or mutate_external tools to the reviewer', () => {
    const names = new Set(readOnlyToolNames(DESCRIPTORS));
    for (const d of DESCRIPTORS) {
      if (d.sideEffect !== 'read') expect(names.has(d.name)).toBe(false);
    }
    for (const w of ['click', 'navigate', 'page_exec', 'app_write_file', 'submit_form', 'actor_create', 'message_actor']) {
      expect(names.has(w)).toBe(false);
    }
  });

  // THE load-bearing one. `sideEffect:'read'` means "does not mutate", NOT
  // "cannot exfiltrate" — fetch_url is read-tagged and takes an attacker-chosen
  // url/method/body. Before the positive allowlist, this module (whose own header
  // says the reviewer must not hold an exfiltration channel) would have handed it
  // over; the save came from an unrelated filter two modules away, untested.
  test('read-tagged EGRESS tools are never granted (read !== non-exfiltrating)', () => {
    const names = new Set(readOnlyToolNames(DESCRIPTORS));
    for (const t of ['fetch_url', 'read_web_cache', 'site_client_run', 'dweb_discover']) {
      expect(names.has(t)).toBe(false);
    }
  });

  test('a NEW read-tagged tool is ungrantable until deliberately allowlisted (fails closed)', () => {
    const withNewTool = [...DESCRIPTORS, { name: 'some_future_read_tool', sideEffect: 'read' }];
    expect(readOnlyToolNames(withNewTool)).not.toContain('some_future_read_tool');
  });

  test('always-denied tools are excluded even when read-classified', () => {
    expect(readOnlyToolNames(DESCRIPTORS)).not.toContain('request_review');
  });
});

describe('isReadOnlyTool (call-time defense in depth)', () => {
  test('allows allowlisted read tools, refuses write/mutate/unknown/off-list', () => {
    expect(isReadOnlyTool('inspect', DESCRIPTORS)).toBe(true);
    expect(isReadOnlyTool('click', DESCRIPTORS)).toBe(false);
    expect(isReadOnlyTool('submit_form', DESCRIPTORS)).toBe(false);
    expect(isReadOnlyTool('actor_create', DESCRIPTORS)).toBe(false);
    expect(isReadOnlyTool('hallucinated_tool', DESCRIPTORS)).toBe(false); // fail closed
    // off the allowlist but read-tagged → still refused at call time
    expect(isReadOnlyTool('fetch_url', DESCRIPTORS)).toBe(false);
    expect(isReadOnlyTool('read_page', DESCRIPTORS)).toBe(false);
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

// A mock spawnActor capturing what the orchestrator hands the reviewer.
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
      spawnActor: spawn,
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
    // The reviewer's grant is the positive allowlist ∩ read-tagged — NOT
    // "everything read-tagged" (which would have included fetch_url).
    expect([...granted].sort()).toEqual([
      'actor_list', 'app_list_files', 'app_read_file', 'inspect',
      'js_read_file', 'now', 'pod_read', 'read_memory',
    ]);
    // ASSERT: no write/mutate/orchestration tool exposed
    for (const w of ['click', 'navigate', 'page_exec', 'app_write_file', 'submit_form', 'actor_create', 'request_review']) {
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
    const requestReview = makeRequestReview({ spawnActor: spawn, getToolDescriptors: () => DESCRIPTORS });
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
      spawnActor: spawn,
      getToolDescriptors: () => DESCRIPTORS,
      // feature 03 says only `inspect` is permitted in this mode
      permissions: { readOnlyTools: () => ['inspect'] },
    });
    await requestReview({ parentSessionId: 'p-1', before: { 'a.js': '1' }, after: { 'a.js': '2' } });
    expect(calls[0].tools).toEqual(['inspect']); // intersection, narrowed further
  });

  test('uses the feature-02 checkpoints adapter when no explicit diff', async () => {
    const { spawn, calls } = makeMockSpawn(reviewerJson);
    const requestReview = makeRequestReview({
      spawnActor: spawn,
      getToolDescriptors: () => DESCRIPTORS,
      checkpoints: { diffSince: async (ref?: string) => ({ ref, files: [{ path: 'svc.js', status: 'modified', before: 'a', after: 'b' }] }) },
    });
    const out = await requestReview({ parentSessionId: 'p-1', since: 'cp-42' });
    expect(calls[0].task).toContain('MODIFIED: svc.js');
    expect(out.ok).toBe(true);
  });

  test('empty changeset short-circuits to approve without spawning', async () => {
    const { spawn, calls } = makeMockSpawn(reviewerJson);
    const requestReview = makeRequestReview({ spawnActor: spawn, getToolDescriptors: () => DESCRIPTORS });
    const out = await requestReview({ parentSessionId: 'p-1', before: { 'a.js': 'same' }, after: { 'a.js': 'same' } });
    expect(calls.length).toBe(0); // no reviewer spawned
    expect(out.ok).toBe(true);
    expect(out.summary!.verdict).toBe('approve');
  });

  test('no diff source at all → error, not a crash', async () => {
    const { spawn } = makeMockSpawn(reviewerJson);
    const requestReview = makeRequestReview({ spawnActor: spawn, getToolDescriptors: () => DESCRIPTORS });
    const out = await requestReview({ parentSessionId: 'p-1' });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('no_diff_source');
  });

  test('a refused spawn surfaces as an error result', async () => {
    const spawn = async () => ({ result: 'actor refused: max depth', sessionId: null, toolCalls: 0, durationMs: 0, refused: true as const });
    const requestReview = makeRequestReview({ spawnActor: spawn, getToolDescriptors: () => DESCRIPTORS });
    const out = await requestReview({ parentSessionId: 'p-1', before: { 'a.js': '1' }, after: { 'a.js': '2' } });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('refused');
  });

  test('a malformed reviewer run still returns a structured (fallback) summary', async () => {
    const { spawn } = makeMockSpawn('the model rambled without JSON');
    const requestReview = makeRequestReview({ spawnActor: spawn, getToolDescriptors: () => DESCRIPTORS });
    const out = await requestReview({ parentSessionId: 'p-1', before: { 'a.js': '1' }, after: { 'a.js': '2' } });
    expect(out.ok).toBe(false);
    expect(out.parseError).toBe('no_json_block');
    expect(out.summary!.verdict).toBe('comment'); // well-formed fallback shape
  });
});

// ---- the reviewer's grant, pinned through the REAL pipeline ----------------
//
// These two exist because the near-miss above was invisible: `read-only.js`
// documents itself as the lethal-trifecta guard, `fetch_url` passed its filter
// cleanly, and the only thing that actually kept it out was
// mainAgentDescriptors — a CONTEXT-HYGIENE policy list two modules away, with
// nothing behind it and no test on it. If someone un-hides fetch_url for
// unrelated product reasons, these fail loudly instead of arming the reviewer.
//
// (The live registry can't be imported here — tools/defs/index.js refuses to
// load outside a browser extension — so we drive the REAL filters with a
// realistic descriptor set. The positive allowlist covers what a fixture can't:
// tools nobody thought to list.)
describe('reviewer grant — through the real narrowing pipeline', () => {
  test('the spawn pipeline drops every egress + actor-only read, not just the allowlist', async () => {
    const { mainAgentDescriptors, filterActorSurface } = await import('../../extension/peerd-runtime/tools/exposure.js');
    const { narrowTools } = await import('../../extension/peerd-runtime/actor/spawn.js');

    // What spawn.js actually computes as the grantable universe, then intersects
    // the reviewer's request against.
    const grantable = filterActorSurface(mainAgentDescriptors(DESCRIPTORS as any));
    const granted = new Set(
      narrowTools(grantable as any, { tools: readOnlyToolNames(DESCRIPTORS), allowRecursion: false })
        .map((t: any) => t.name),
    );

    // No egress reaches the reviewer, by ANY route.
    for (const t of ['fetch_url', 'read_web_cache', 'site_client_run', 'dweb_discover']) {
      expect(granted.has(t)).toBe(false);
    }
    // No mutation, no delegation, no self-recursion.
    for (const t of ['click', 'app_write_file', 'submit_form', 'message_actor', 'actor_create', 'request_review']) {
      expect(granted.has(t)).toBe(false);
    }
    // Instance reads are actor-only (#159), so a NORMAL spawned child never gets
    // them — filterActorSurface drops them from the grantable universe.
    for (const t of ['js_read_file', 'pod_read', 'app_read_file', 'app_list_files']) {
      expect(granted.has(t)).toBe(false);
    }

    // …and the #160 REVIEW spawn re-adds exactly those four, and ONLY those:
    // egress and writes stay gone even on the review path.
    const { REVIEW_INSTANCE_READS } = await import('../../extension/peerd-runtime/tools/exposure.js');
    const reviewGrantable = (grantable as any[]).concat(
      (DESCRIPTORS as any[]).filter((t) => REVIEW_INSTANCE_READS.has(t.name)),
    );
    const reviewGranted = new Set(
      narrowTools(reviewGrantable as any, { tools: readOnlyToolNames(DESCRIPTORS), allowRecursion: false })
        .map((t: any) => t.name),
    );
    for (const t of ['js_read_file', 'pod_read', 'app_read_file', 'app_list_files']) {
      expect(reviewGranted.has(t)).toBe(true);
    }
    for (const t of ['fetch_url', 'read_page', 'site_client_run', 'app_write_file', 'message_actor']) {
      expect(reviewGranted.has(t)).toBe(false);
    }
  });

  // The DURABLE one: assert on surviving CAPABILITIES, not tool names. Any
  // egress-capable tool must register a closure in CAPABILITY_CONSUMERS to work
  // AT ALL — that isn't optional, it's how a tool gets its capability. So this
  // catches a future egress tool automatically, with no list to remember.
  test('the reviewer ctx holds NO outward closure (egress/delegation/secrets)', async () => {
    const { CAPABILITY_CONSUMERS, restrictCtxCapabilities } = await import('../../extension/peerd-runtime/actor/spawn.js');

    // A ctx carrying every known capability, then stripped to the reviewer's grant.
    const fullCtx = Object.fromEntries(Object.keys(CAPABILITY_CONSUMERS).map((k) => [k, 'closure']));
    const granted = new Set(readOnlyToolNames(DESCRIPTORS));
    const survivors = new Set(Object.keys(restrictCtxCapabilities(fullCtx as any, granted as any)));

    for (const cap of [
      'getSecret', 'safeFetch', 'webFetch', 'webCache', 'dweb',
      'messageActor', 'spawnActor', 'spawnActorAsync',
      'siteClients', 'jsOffscreenClient',
    ]) {
      expect(survivors.has(cap)).toBe(false);
    }
  });
});

// ---- #160: the review exemption, and its blast radius ---------------------
//
// The exemption is the ONE hole in the actor-only wall, so these pin that it is
// exactly one hole: the three READ names, only under the SW-stamped marker.
describe('#160 review exemption — positively scoped on BOTH axes', () => {
  test('a review ctx may hold the four instance READS: and nothing else actor-only', async () => {
    const { actorTierGate } = await import('../../extension/peerd-runtime/tools/gates.js');
    const { EXPOSURE_REVIEW } = await import('../../extension/peerd-runtime/tools/exposure.js');
    const reviewCtx = { exposure: EXPOSURE_REVIEW } as any;

    for (const name of ['js_read_file', 'pod_read', 'app_read_file', 'app_list_files']) {
      expect(actorTierGate({ name } as any, {}, reviewCtx)).toBe(null); // no opinion → allowed
    }
    // every actor-only WRITE stays refused for the very same ctx
    for (const name of ['app_write_file', 'app_delete', 'js_write_file', 'js_delete', 'edit_file', 'vm_write_file']) {
      expect(actorTierGate({ name } as any, {}, reviewCtx)?.allowed).toBe(false);
    }
  });

  test('the SAME four reads stay refused for a NON-review, non-actor ctx', async () => {
    const { actorTierGate } = await import('../../extension/peerd-runtime/tools/gates.js');
    for (const ctx of [{ exposure: 'main' }, {}, { exposure: 'spoofed' }] as any[]) {
      for (const name of ['js_read_file', 'pod_read', 'app_read_file', 'app_list_files']) {
        expect(actorTierGate({ name } as any, {}, ctx)?.allowed).toBe(false);
      }
    }
  });

  test('the exemption grants no EGRESS — the marker does not widen anything else', async () => {
    const { actorTierGate } = await import('../../extension/peerd-runtime/tools/gates.js');
    const { EXPOSURE_REVIEW, REVIEW_INSTANCE_READS } = await import('../../extension/peerd-runtime/tools/exposure.js');
    // the exempt set is exactly four reads: no fetch/page/site/dweb tool in it
    expect([...REVIEW_INSTANCE_READS].sort()).toEqual(['app_list_files', 'app_read_file', 'js_read_file', 'pod_read']);
    // and a review ctx is still refused the dweb family
    const dwebTool = { name: 'dweb_discover', dweb: true } as any;
    expect(actorTierGate(dwebTool, {}, { exposure: EXPOSURE_REVIEW } as any)?.allowed).toBe(false);
  });

  // The marker is only trustworthy because the model cannot set it. actor_create
  // builds its spawn request from an EXPLICIT field whitelist; if someone ever
  // spreads model args into it, the exemption becomes forgeable.
  test('actor_create cannot forge the review flag (its spawn req is whitelisted)', async () => {
    const src = await Bun.file('extension/peerd-runtime/tools/defs/actor-create.js').text();
    expect(src).not.toContain('...args');          // no arg spread into the req
    expect(src).not.toMatch(/review\s*:/);         // never sets the flag
  });
});
