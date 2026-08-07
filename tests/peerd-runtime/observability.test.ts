// The debug surface's pure cores: the failure classifier (real error
// strings from across the codebase → the small stable taxonomy), the
// bundle assembler (shape, child collection, caps, provenance honesty),
// and the OTel mapper (span tree, status + failure attrs, id validity).

import { describe, test, expect } from 'bun:test';
import { classifyFailure, FAILURE_KINDS } from '../../extension/peerd-runtime/observability/failure-classify.js';
import {
  assembleDebugBundle, childSessionIdsOf, collectFailures, aggregateFailures,
  DEBUG_BUNDLE_FORMAT, BUNDLE_MAX_AUDIT_ENTRIES, BUNDLE_MAX_CHILD_SESSIONS,
} from '../../extension/peerd-runtime/observability/debug-bundle.js';
import { bundleToOtlp, traceIdFromUuid, spanIdFrom } from '../../extension/peerd-runtime/observability/otel-export.js';
import {
  REMOTE_MODULE_IMPORTS_UNAVAILABLE_CODE,
  REMOTE_MODULE_IMPORTS_UNAVAILABLE_MESSAGE,
  UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE,
  UNSUPPORTED_NATIVE_MODULE_IMPORT_MESSAGE,
} from '../../extension/peerd-engine/errors.js';

describe('classifyFailure — the strings the codebase actually produces', () => {
  const cases: Array<[string, ReturnType<typeof classifyFailure>['kind']]> = [
    // [error text as produced, expected kind]
    ["message_actor: 4 actor messages already in flight for this turn", 'policy'],
    ['actor refused: max depth 2 exceeded (requested depth 3)', 'policy'],
    // the dispatcher's REAL refusal prefixes (dispatcher.js) — the review
    // found the first draft matched only invented strings here
    ['gate_blocked:plan-act:plan mode is read-only; blocks page_mutation actions', 'policy'],
    ["gate_blocked:exposure:'view' is actor-only — message a tab's actor instead", 'policy'],
    ['gate_blocked:confirmation:rejected by user', 'policy'],
    ['hook_blocked:pre-tool-use:matched deny pattern', 'policy'],
    ['User declined the outbound write.', 'policy'],
    ['EgressDeniedError: https://evil.example is not on the allowlist', 'policy'],
    ['egress denied: denylist matched host tracker.example', 'policy'],
    [`${REMOTE_MODULE_IMPORTS_UNAVAILABLE_CODE}: ${REMOTE_MODULE_IMPORTS_UNAVAILABLE_MESSAGE}`, 'policy'],
    [`${UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE}: ${UNSUPPORTED_NATIVE_MODULE_IMPORT_MESSAGE}`, 'policy'],
    ['vault is locked — unlock to continue', 'auth'],
    ["Provider 'anthropic' HTTP 401: {\"error\":\"invalid x-api-key\"}", 'auth'],
    // a bare HTTP 403 in an asset-download failure is NOT a credential
    // problem — only the provider-anchored shape may classify auth
    ['fetch_failed: HTTP 403', 'environment'],
    ['fetch returned HTTP 403', 'environment'],
    ["Provider 'openrouter' HTTP 429: rate limited", 'limits'],
    ['spend limit reached for this session', 'limits'],
    ["Provider 'ollama' HTTP 400: {\"error\":{\"message\":\"bad request\"}}", 'provider'],
    ['provider stream ended early (likely rate limit or network drop)', 'provider'],
    ["actors.ask: timed out after 5000ms awaiting 'vm-9'", 'timeout'],
    ['script_aborted: the turn was stopped before the run started', 'aborted'],
    ["actors.ask: aborted (Stop) while awaiting 'vm-9'", 'aborted'],
    ['the request was aborted (timeout or cancel) before the actor replied.', 'aborted'],
    ['no_option_matching: "Submit order" — available: Cancel | Back', 'environment'],
    ['actor tool relay failed', 'environment'],
    ['The webvm actor builder (vm-9) could not complete your request:', 'agent'],
    // agent beats timeout: the actor REPORTED failure; the timeout detail
    // inside its account must not reclassify who failed
    ['The web actor could not complete your request: the ask timed out after 120000ms', 'agent'],
    ['Failed to fetch', 'provider'],
    ['the actor turn failed: pytest exited 1', 'agent'],
    ['(the actor produced no text reply)', 'agent'],
    ['TypeError: cannot read properties of undefined', 'internal'],
    // The lifecycle contract's stable result prefixes (PR #314).
    ['outcome_unknown: This action may have completed, but peerd did not receive confirmation. Check the target before repeating it. (submit_form: request timed out)', 'environment'],
    ['interrupted: The read or model call was interrupted. Retrying may incur additional network or model cost. (fetch_url: connection reset)', 'environment'],
    ['cancelled: submit_form was stopped before its effect landed (aborted)', 'aborted'],
    ['outcome_unknown: submit_form was already dispatched and its result is lost. It may have completed — verify the external state before repeating it. Not re-executing automatically.', 'policy'],
    ['completed: submit_form already completed on a previous dispatch of this same call — not re-executing. Use the recorded result or issue a NEW operation.', 'policy'],
    ['failed: submit_form was NOT executed — lifecycle tracking is unavailable (quota exceeded) and a non-idempotent action must not run untracked: an interruption could then never be reported or guarded against. Retry once storage recovers, or run a read-only alternative.', 'policy'],
  ];
  for (const [text, kind] of cases) {
    test(`"${text.slice(0, 52)}…" → ${kind}`, () => {
      expect(classifyFailure(text).kind).toBe(kind);
    });
  }

  test('a Stop-aborted turn is aborted regardless of surviving text', () => {
    expect(classifyFailure('anything at all', { stopReason: 'aborted' }).kind).toBe('aborted');
  });

  test('every kind the classifier can emit is in the published set', () => {
    for (const [text] of cases) {
      expect(FAILURE_KINDS).toContain(classifyFailure(text).kind);
    }
  });

  test('non-string inputs never throw', () => {
    expect(classifyFailure(undefined).kind).toBe('internal');
    expect(classifyFailure(new Error('vault is locked')).kind).toBe('auth');
    expect(classifyFailure({ message: 42 }).kind).toBe('internal');
  });
});

describe('childSessionIdsOf — the delegation tree walk', () => {
  test('collects descendants transitively, ignores unrelated trees, survives cycles', () => {
    const rows = [
      { sessionId: 'root' },
      { sessionId: 'web-1', parentSessionId: 'root' },
      { sessionId: 'sub-1', parentSessionId: 'root' },
      { sessionId: 'vm-1', parentSessionId: 'sub-1' },     // grandchild via actor
      { sessionId: 'other', parentSessionId: 'elsewhere' }, // unrelated
      { sessionId: 'loop', parentSessionId: 'loop' },       // corrupt self-cycle
    ];
    expect(childSessionIdsOf(rows, 'root').sort()).toEqual(['sub-1', 'vm-1', 'web-1']);
    expect(childSessionIdsOf(rows, 'loop')).toEqual([]); // the cycle terminates
  });
});

const SESSION = {
  sessionId: '01912345-6789-7abc-8def-0123456789ab',
  kind: 'chat', provider: 'anthropic', model: 'claude-x', title: 'find the widget',
  createdAt: 1000,
  cost: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01, turns: 2 },
  messages: [
    { role: 'user', id: 'u1', when: 1000, content: 'go', toolResults: [] },
    {
      role: 'assistant', id: 'a1', when: 2000, content: '', model: 'claude-x',
      toolUses: [{ id: 'toolu_ok', name: 'script', input: {} }, { id: 'toolu_bad', name: 'message_actor', input: {} }],
    },
    {
      role: 'user', id: 'u2', when: 3000, content: '',
      toolResults: [
        { tool_use_id: 'toolu_ok', content: '42', is_error: false },
        { tool_use_id: 'toolu_bad', content: 'message_actor: oneShot is sandbox-only', is_error: true },
      ],
    },
    { role: 'assistant', id: 'a2', when: 4000, content: 'partial', error: "Provider 'anthropic' HTTP 529: overloaded" },
  ],
};

describe('collectFailures — the "what went wrong" index', () => {
  test('finds the failed tool AND the failed turn, classified', () => {
    const failures = collectFailures(SESSION);
    expect(failures.length).toBe(2);
    const tool = failures.find((f: any) => f.scope === 'tool') as any;
    expect(tool.toolUseId).toBe('toolu_bad');
    expect(tool.kind).toBe('policy');
    const turn = failures.find((f: any) => f.scope === 'turn') as any;
    expect(turn.messageId).toBe('a2');
    expect(turn.kind).toBe('provider');
  });
});

describe('aggregateFailures — the cross-session error-class analyzer (5d)', () => {
  test('groups every session\'s failures by scope:kind', () => {
    // SESSION contributes tool:policy (message_actor) + turn:provider (HTTP 529).
    const other = {
      sessionId: 'other',
      messages: [
        { role: 'user', id: 'u', when: 1, toolResults: [
          { tool_use_id: 't1', content: 'egress denied: denylist matched host x', is_error: true },
        ] },
        { role: 'assistant', id: 'a', when: 2, content: '', error: "Provider 'anthropic' HTTP 429: rate limited" },
      ],
    };
    const table = aggregateFailures([SESSION, other]);
    expect(table['tool:policy']).toBe(2);     // message_actor (SESSION) + denylist (other)
    expect(table['turn:provider']).toBe(1);   // SESSION's HTTP 529
    expect(table['turn:limits']).toBe(1);     // other's HTTP 429
  });

  test('safe on empty / non-array input', () => {
    expect(aggregateFailures([])).toEqual({});
    expect(aggregateFailures(null as any)).toEqual({});
  });
});

describe('assembleDebugBundle', () => {
  const child = { ...SESSION, sessionId: 'child-1', kind: 'actor', actorType: 'web', messages: SESSION.messages.slice(0, 3) };
  const bundle = assembleDebugBundle({
    session: SESSION,
    childSessions: [child],
    auditEntries: [{ id: 'e1', when: 1500, type: 'tool_executed', sessionId: SESSION.sessionId }],
    settings: { providerName: 'anthropic', devMode: true },
    contextSnapshots: [{ sessionId: SESSION.sessionId, label: 'main', when: 1900 }],
    channel: 'preview', appVersion: '0.2.4', now: 10_000,
    limits: { auditMaxEntries: 20_000, snapshotsPerSession: 10 },
  });

  test('carries format/version, the whole transcript, and an honest summary', () => {
    expect(bundle.format).toBe(DEBUG_BUNDLE_FORMAT);
    expect(bundle.session.messages.length).toBe(4);
    expect(bundle.summary.toolCalls).toBe(4); // 2 in root + 2 in child
    expect(bundle.summary.failures).toBe(3);  // 2 root + 1 child (tool)
    expect(bundle.summary.cost.turns).toBe(2);
    expect(bundle.exportedAt).toBe(new Date(10_000).toISOString());
  });

  test('provenance names the caps and the secrets posture', () => {
    expect(bundle.provenance.audit).toContain('20000');
    expect(bundle.provenance.contextSnapshots).toContain('service worker');
    expect(bundle.provenance.secrets).toContain('vault');
  });

  test('caps clamp: audit to the newest entries, children to the max', () => {
    const many = assembleDebugBundle({
      session: SESSION,
      childSessions: Array.from({ length: BUNDLE_MAX_CHILD_SESSIONS + 5 }, (_, i) => ({ sessionId: `c${i}`, messages: [] })),
      auditEntries: Array.from({ length: BUNDLE_MAX_AUDIT_ENTRIES + 10 }, (_, i) => ({ id: `e${i}`, when: i, type: 'x' })),
      now: 0,
    });
    expect(many.audit.length).toBe(BUNDLE_MAX_AUDIT_ENTRIES);
    expect(many.audit[0].id).toBe('e10'); // oldest dropped, newest kept
    expect(many.childSessions.length).toBe(BUNDLE_MAX_CHILD_SESSIONS);
    expect(many.provenance.childSessions).toContain('clamped');
  });

  test('normalizes a missing/corrupt cost tally instead of exporting garbage', () => {
    const noCost = assembleDebugBundle({ session: { ...SESSION, cost: undefined }, now: 0 });
    expect(noCost.summary.cost.inputTokens).toBe(0);
    expect(noCost.summary.cost.turns).toBe(0);
  });
});

describe('bundleToOtlp — the span tree', () => {
  const child = { ...SESSION, sessionId: '01912345-6789-7abc-8def-0123456789ff', kind: 'actor', actorType: 'web', parentSessionId: SESSION.sessionId, messages: SESSION.messages.slice(0, 3) };
  const bundle = assembleDebugBundle({ session: SESSION, childSessions: [child], now: 0 });
  const otlp = bundleToOtlp(bundle);
  const spans = otlp.resourceSpans[0].scopeSpans[0].spans;

  test('ids are OTel-valid: 32-hex trace, 16-hex non-zero spans, one shared trace', () => {
    expect(traceIdFromUuid(SESSION.sessionId)).toMatch(/^[0-9a-f]{32}$/);
    for (const s of spans) {
      expect(s.traceId).toBe(traceIdFromUuid(SESSION.sessionId));
      expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(s.spanId).not.toBe('0'.repeat(16));
    }
    expect(new Set(spans.map((s: any) => s.spanId)).size).toBe(spans.length);
  });

  test('the delegation structure is span parentage: child session root hangs off the chat root', () => {
    const chatRoot = spans.find((s: any) => s.name === 'peerd.session chat') as any;
    const actorRoot = spans.find((s: any) => s.name === 'peerd.session actor:web') as any;
    expect(chatRoot.parentSpanId).toBeUndefined();
    expect(actorRoot.parentSpanId).toBe(chatRoot.spanId);
  });

  test('a GRANDCHILD hangs off its real spawner, not flattened onto the chat root', () => {
    const sub = { sessionId: 'sub-1', kind: 'spawned', parentSessionId: SESSION.sessionId, messages: [] };
    const vm = { sessionId: 'vm-1', kind: 'actor', actorType: 'webvm', parentSessionId: 'sub-1', messages: [] };
    const orphan = { sessionId: 'or-1', kind: 'actor', actorType: 'app', parentSessionId: 'clamped-away', messages: [] };
    const b = assembleDebugBundle({ session: SESSION, childSessions: [sub, vm, orphan], now: 0 });
    const tree = bundleToOtlp(b).resourceSpans[0].scopeSpans[0].spans;
    const root = tree.find((s: any) => s.name === 'peerd.session chat') as any;
    const subRoot = tree.find((s: any) => s.name === 'peerd.session spawned') as any;
    const vmRoot = tree.find((s: any) => s.name === 'peerd.session actor:webvm') as any;
    const orphanRoot = tree.find((s: any) => s.name === 'peerd.session actor:app') as any;
    expect(subRoot.parentSpanId).toBe(root.spanId);
    expect(vmRoot.parentSpanId).toBe(subRoot.spanId);        // the real spawner
    expect(orphanRoot.parentSpanId).toBe(root.spanId);       // clamped-out parent → root fallback
  });

  test('failures carry ERROR status + the classified peerd.failure.kind', () => {
    const failedTool = spans.find((s: any) => s.name === 'peerd.tool message_actor' && s.status.code === 2) as any;
    expect(failedTool).toBeDefined();
    expect(failedTool.attributes.some((a: any) => a.key === 'peerd.failure.kind' && a.value.stringValue === 'policy')).toBe(true);
    const failedTurn = spans.find((s: any) => s.name === 'peerd.model_turn' && s.status.code === 2) as any;
    expect(failedTurn.status.message).toContain('HTTP 529');
  });

  test('token usage rides the resource as gen_ai semconv attributes', () => {
    const res = otlp.resourceSpans[0].resource.attributes as any[];
    const input = res.find((a) => a.key === 'gen_ai.usage.input_tokens');
    expect(input.value.intValue).toBe('100');
  });

  test('spanIdFrom is deterministic and corrupt uuids do not throw', () => {
    expect(spanIdFrom('toolu_abc')).toBe(spanIdFrom('toolu_abc'));
    expect(traceIdFromUuid('???')).toMatch(/^[0-9a-f]{32}$/);
  });
});
