// Dispatch tracking — the contract wired into the dispatcher choke point.
// Covers: per-class settle semantics (§16.2 no generic timeouts), the
// replay guard (guarantee 2: an automatic re-dispatch of an unproven
// Class E call is refused, never executed), and the full dispatchToolCall
// path against a real in-memory operation log.

import { describe, test, expect, beforeEach } from 'bun:test';
import { makeDispatchTracker } from '../../../extension/peerd-runtime/lifecycle/dispatch-tracking.js';
import { createOperationLog } from '../../../extension/peerd-runtime/lifecycle/operation-log.js';
import { OPERATION_STATES } from '../../../extension/peerd-runtime/lifecycle/operation-state.js';
import { classifyFailure } from '../../../extension/peerd-runtime/observability/failure-classify.js';
import { createExplicitToolFixture } from '../tools/explicit-tool-fixture';
import { getToolAuthority } from '../../../extension/peerd-runtime/tools/metadata/authority.js';
import { toToolDescriptor } from '../../../extension/peerd-runtime/tools/metadata/descriptor.js';
import {
  prepareToolCall, settleToolCall,
} from '../../../extension/peerd-runtime/tools/dispatcher.js';
import { retryClassForTool } from '../../../extension/peerd-runtime/lifecycle/tool-retry-class.js';
import {
  executeControllerRepositoryTool,
} from '../../../extension/peerd-runtime/controller-repository-tools.js';

const S = OPERATION_STATES;
const fixture = createExplicitToolFixture();
const dispatchToolCall = fixture.dispatch;
const setFixtureTool = fixture.set;

const makeLog = () => {
  const map = new Map<string, unknown>();
  return createOperationLog({
    storage: {
      get: async (k: string) => map.get(k),
      set: async (k: string, v: unknown) => { map.set(k, structuredClone(v)); },
    },
    now: () => 1,
  });
};

const makeTracker = (log = makeLog()) => ({
  log,
  tracker: makeDispatchTracker({
    operationLog: log,
    generationId: () => 'gen-1-nonce',
    retryClassFor: (tool) => (tool as { retryClass?: string }).retryClass as any ?? 'E',
    classifyFailure,
  }),
});

describe('beginTracking', () => {
  test('Class A reads are untracked — no storage write per read', async () => {
    const { tracker } = makeTracker();
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 'read_page', retryClass: 'A' }, sessionId: 's',
    });
    expect(begun).toBeNull();
  });

  test('a tracked call is recorded dispatched BEFORE execute', async () => {
    const { tracker, log } = makeTracker();
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 'submit_form', retryClass: 'E' },
      sessionId: 's', target: 'https://example.com',
    });
    expect(begun && 'handle' in begun).toBe(true);
    const record = await log.get('s:c1');
    expect(record!.state).toBe(S.AWAITING_REMOTE);
    expect(record!.dispatched).toBe(true);
  });
});

describe('settleTracking — §16.2 semantic failures', () => {
  const settle = async (retryClass: string, error: string) => {
    const { tracker, log } = makeTracker();
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 't', retryClass }, sessionId: 's',
    });
    const rewrite = await tracker.settleTracking(
      (begun as { handle: any }).handle, { ok: false, error });
    return { rewrite, record: await log.get('s:c1') };
  };

  test('success settles completed with evidence', async () => {
    const { tracker, log } = makeTracker();
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 't', retryClass: 'E' }, sessionId: 's',
    });
    const rewrite = await tracker.settleTracking(
      (begun as { handle: any }).handle, { ok: true });
    expect(rewrite).toBeNull();
    expect((await log.get('s:c1'))!.state).toBe(S.COMPLETED);
  });

  test('an UNTYPED error on a dispatched Class E defaults to outcome_unknown — burden of proof inverted', async () => {
    // 'element not found' READS definitive, but an unstamped string proves
    // nothing about whether the effect landed. Only a typed
    // pre-effect-failure carries the "did not occur" claim for D/E.
    const { rewrite, record } = await settle('E', 'element not found: #missing');
    expect(record!.state).toBe(S.OUTCOME_UNKNOWN);
    expect(rewrite!.error).toStartWith('outcome_unknown:');
  });

  test('an untyped definitive error on a Class B read still settles failed (heuristics decide for A/B/C)', async () => {
    const { rewrite, record } = await settle('B', 'element not found: #missing');
    expect(rewrite).toBeNull();
    expect(record!.state).toBe(S.FAILED);
  });

  test('a timeout on a Class E dispatch settles outcome_unknown and rewrites the error', async () => {
    const { rewrite, record } = await settle('E', 'request timed out after 30000ms');
    expect(record!.state).toBe(S.OUTCOME_UNKNOWN);
    expect(rewrite!.error).toStartWith('outcome_unknown:');
    expect(rewrite!.error).toContain('Check the target before repeating it');
    expect(rewrite!.recovery).toMatchObject({
      category: 'verify_before_retry', autoRetry: false, verificationRequired: true,
    });
  });

  test('an HTTP 5xx on a Class E dispatch is ambiguous too — the server got the request', async () => {
    const { record } = await settle('E', 'HTTP 502 Bad Gateway');
    expect(record!.state).toBe(S.OUTCOME_UNKNOWN);
  });

  test('execution-host deaths are ambiguous, not tool-attested failures', async () => {
    for (const error of [
      'script_failed: Error: The message port closed before a response was received.',
      'Could not establish connection. Receiving end does not exist.',
      'VMTabClosed: the VM tab was closed mid-command',
      'worker terminated before the job settled',
    ]) {
      const { record } = await settle('E', error);
      expect(record!.state).toBe(S.OUTCOME_UNKNOWN);
    }
    // …and an untyped tool string ALSO lands unknown (inverted burden);
    // only the typed pre-effect stamp settles failed for a dispatched E.
    const { record } = await settle('E', 'element not found: #missing');
    expect(record!.state).toBe(S.OUTCOME_UNKNOWN);
  });

  test('a timeout on a Class B read settles interrupted — retryable, budget-worded', async () => {
    const { rewrite, record } = await settle('B', 'fetch failed: connection reset');
    expect(record!.state).toBe(S.INTERRUPTED);
    expect(rewrite!.error).toStartWith('interrupted:');
  });

  test('an abort on a Class E dispatch is outcome_unknown, not a false cancelled', async () => {
    const { tracker, log } = makeTracker();
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 't', retryClass: 'E' }, sessionId: 's',
    });
    await tracker.settleTracking((begun as { handle: any }).handle,
      { ok: false, error: 'x', aborted: true });
    expect((await log.get('s:c1'))!.state).toBe(S.OUTCOME_UNKNOWN);
  });

  test('typed pre-effect proof makes an aborted Class E dispatch a clean cancellation', async () => {
    const { tracker, log } = makeTracker();
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 't', retryClass: 'E' }, sessionId: 's',
    });
    const rewrite = await tracker.settleTracking((begun as { handle: any }).handle, {
      ok: false,
      error: 'stopped before the actor ran',
      aborted: true,
      outcomeKind: 'pre-effect-failure',
    });
    expect((await log.get('s:c1'))!.state).toBe(S.CANCELLED);
    expect(rewrite!.error).toStartWith('cancelled:');
    expect(rewrite!.recovery.state).toBe(S.CANCELLED);
  });

  test('an abort on a Class C write settles cancelled cleanly', async () => {
    const { tracker, log } = makeTracker();
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 't', retryClass: 'C' }, sessionId: 's',
    });
    const rewrite = await tracker.settleTracking((begun as { handle: any }).handle,
      { ok: false, error: 'stopped', aborted: true });
    expect((await log.get('s:c1'))!.state).toBe(S.CANCELLED);
    expect(rewrite!.error).toStartWith('cancelled:');
  });
});

describe('fail closed when tracking cannot start', () => {
  const brokenStorage = () => createOperationLog({
    storage: {
      get: async () => { throw new Error('quota exceeded'); },
      set: async () => { throw new Error('quota exceeded'); },
    },
    now: () => 1,
  });

  test('Class E and D are REFUSED, not executed untracked, when the log is down', async () => {
    for (const retryClass of ['E', 'D']) {
      const tracker = makeDispatchTracker({
        operationLog: brokenStorage(),
        generationId: () => 'gen-1-x',
        retryClassFor: (tool) => (tool as { retryClass?: string }).retryClass as any,
      });
      const begun = await tracker.beginTracking({
        callId: 'c1', tool: { name: 'submit_form', retryClass }, sessionId: 's',
      });
      expect(begun && 'refuse' in begun).toBe(true);
      const refusal = (begun as { refuse: { error: string, recovery: any } }).refuse;
      expect(refusal.error).toContain('NOT executed');
      expect(refusal.recovery.category).toBe('security_degradation');
    }
  });

  test('Class B degrades to untracked — a broken log must not brick reads', async () => {
    const tracker = makeDispatchTracker({
      operationLog: brokenStorage(),
      generationId: () => 'gen-1-x',
      retryClassFor: () => 'B' as any,
    });
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 'fetch_url', retryClass: 'B' }, sessionId: 's',
    });
    expect(begun).toBeNull();
  });

  test('a death MID-SEQUENCE (begin ok, markDispatched fails) also refuses D/E', async () => {
    let writes = 0;
    const log = createOperationLog({
      storage: {
        get: async () => undefined,
        set: async () => { writes += 1; if (writes > 1) throw new Error('storage died'); },
      },
      now: () => 1,
    });
    const tracker = makeDispatchTracker({
      operationLog: log, generationId: () => 'gen-1-x',
      retryClassFor: () => 'E' as any,
    });
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 'submit_form', retryClass: 'E' }, sessionId: 's',
    });
    expect(begun && 'refuse' in begun).toBe(true);
  });

  test('makeFailClosedTracker: the boot-failure tracker refuses D/E and passes A/B/C', async () => {
    const { makeFailClosedTracker } = await import(
      '../../../extension/peerd-runtime/lifecycle/dispatch-tracking.js');
    const tracker = makeFailClosedTracker({
      reason: 'lifecycle boot failed',
      retryClassFor: (tool) => (tool as { retryClass?: string }).retryClass as any,
    });
    const refused = await tracker.beginTracking({ tool: { name: 'submit_form', retryClass: 'E' } });
    expect(refused && 'refuse' in refused).toBe(true);
    expect((refused as any).refuse.error).toContain('boot failed');
    expect(await tracker.beginTracking({ tool: { name: 'read_page', retryClass: 'A' } })).toBeNull();
    expect(await tracker.beginTracking({ tool: { name: 'fetch_url', retryClass: 'B' } })).toBeNull();
    expect(await tracker.settleTracking()).toBeNull();
  });
});

describe('typed failure outcomes outrank string heuristics', () => {
  const settleTyped = async (retryClass: string, error: string, outcomeKind?: string) => {
    const { tracker, log } = makeTracker();
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 't', retryClass }, sessionId: 's',
    });
    const rewrite = await tracker.settleTracking(
      (begun as { handle: any }).handle,
      { ok: false, error, outcomeKind: outcomeKind as any });
    return { rewrite, record: await log.get('s:c1') };
  };

  test('pre-effect-failure settles failed even when the message LOOKS like a timeout', async () => {
    const { record } = await settleTyped('E', 'gateway timed out validating the payload', 'pre-effect-failure');
    expect(record!.state).toBe(S.FAILED);
  });

  test('effect-completed settles completed without rewriting the policy refusal', async () => {
    const { rewrite, record } = await settleTyped(
      'E',
      'browser_private_network_blocked: navigation stopped after the page loaded',
      'effect-completed',
    );
    expect(rewrite).toBeNull();
    expect(record!.state).toBe(S.COMPLETED);
    expect(record!.evidence).toEqual({ kind: 'success-response' });
  });

  test('transport-lost settles ambiguous even when the message looks definitive', async () => {
    const { record } = await settleTyped('E', 'element not found: #missing', 'transport-lost');
    expect(record!.state).toBe(S.OUTCOME_UNKNOWN);
  });

  test('host-lost is ambiguous for E, interrupted for B', async () => {
    expect((await settleTyped('E', 'x', 'host-lost')).record!.state).toBe(S.OUTCOME_UNKNOWN);
    expect((await settleTyped('B', 'x', 'host-lost')).record!.state).toBe(S.INTERRUPTED);
  });

  test('an unstamped failure still takes the heuristic path', async () => {
    const { record } = await settleTyped('E', 'request timed out');
    expect(record!.state).toBe(S.OUTCOME_UNKNOWN);
  });
});

describe('the replay guard — guarantee 2', () => {
  test('a CURRENT-generation duplicate is refused WITHOUT mutating the live record', async () => {
    // The first dispatch is still executing in this very SW — its outcome
    // is pending, not lost. The duplicate must be refused, but force-
    // settling the record would discard the evidence about to arrive.
    const { tracker, log } = makeTracker();
    await tracker.beginTracking({
      callId: 'c1', tool: { name: 'submit_form', retryClass: 'E' }, sessionId: 's',
    });
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 'submit_form', retryClass: 'E' }, sessionId: 's',
    });
    expect(begun && 'refuse' in begun).toBe(true);
    const refusal = (begun as { refuse: { error: string } }).refuse;
    expect(refusal.error).toStartWith('outcome_unknown:');
    expect(refusal.error).toContain('still pending');
    expect((await log.get('s:c1'))!.state).toBe(S.AWAITING_REMOTE); // NOT mutated
  });

  test('a DEAD-generation unproven Class E record IS force-settled outcome_unknown on replay', async () => {
    const { tracker, log } = makeTracker();
    // The record as a dead SW left it: dispatched under gen-0, unsettled.
    await log.begin({
      operationId: 's:c1', sessionId: 's', toolName: 'submit_form',
      retryClass: 'E', generationId: 'gen-0-dead',
    });
    await log.transition('s:c1', S.RUNNING);
    await log.markDispatched('s:c1');
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 'submit_form', retryClass: 'E' }, sessionId: 's',
    });
    expect((begun as { refuse: { error: string } }).refuse.error).toStartWith('outcome_unknown:');
    expect((await log.get('s:c1'))!.state).toBe(S.OUTCOME_UNKNOWN);
  });

  test('late positive evidence resolves a force-parked outcome_unknown record', async () => {
    const { tracker, log } = makeTracker();
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 'submit_form', retryClass: 'E' }, sessionId: 's',
    });
    // Simulate the mid-execute force-park (as a dead-generation replay
    // would have done it) …
    await log.settle('s:c1', {
      state: S.OUTCOME_UNKNOWN, autoRetry: false, retryRequires: [],
      keepIdempotencyKey: false, verificationRequired: true,
      recreateResource: false, reason: 'force-parked',
    });
    // … then the ORIGINAL dispatch resolves with proof. resolveUnknown is
    // the sanctioned evidence-gated exit; the evidence must not be dropped.
    await tracker.settleTracking((begun as { handle: any }).handle, { ok: true });
    expect((await log.get('s:c1'))!.state).toBe(S.COMPLETED);
  });

  test('a class-confusion replay (recorded E, presented D) is REFUSED, never run untracked', async () => {
    const { tracker, log } = makeTracker();
    await log.begin({
      operationId: 's:c1', sessionId: 's', toolName: 'submit_form',
      retryClass: 'E', generationId: 'gen-0-dead',
    });
    await log.settle('s:c1', {
      state: S.INTERRUPTED, autoRetry: false, retryRequires: ['user-instruction'],
      keepIdempotencyKey: false, verificationRequired: false,
      recreateResource: false, reason: 'pre-dispatch death',
    });
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 'submit_form', retryClass: 'D' }, sessionId: 's',
    });
    // Previously this path REJECTED (newAttempt's class check), and the
    // dispatcher's fail-open catch executed the replay untracked.
    expect(begun && 'refuse' in begun).toBe(true);
  });

  test('a completed call refuses re-execution — duplicates are named, not run', async () => {
    const { tracker } = makeTracker();
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 'submit_form', retryClass: 'E' }, sessionId: 's',
    });
    await tracker.settleTracking((begun as { handle: any }).handle, { ok: true });
    const again = await tracker.beginTracking({
      callId: 'c1', tool: { name: 'submit_form', retryClass: 'E' }, sessionId: 's',
    });
    expect((again as { refuse: { error: string } }).refuse.error).toStartWith('completed:');
  });

  test('an interrupted Class B call re-drives as a fresh attempt', async () => {
    const { tracker, log } = makeTracker();
    await tracker.beginTracking({
      callId: 'c1', tool: { name: 'fetch_url', retryClass: 'B' }, sessionId: 's',
    });
    await log.settle('s:c1', {
      state: S.INTERRUPTED, autoRetry: true, retryRequires: [],
      keepIdempotencyKey: false, verificationRequired: false,
      recreateResource: false, reason: 'sw died',
    });
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 'fetch_url', retryClass: 'B' }, sessionId: 's',
    });
    expect(begun && 'handle' in begun).toBe(true);
    const record = (await log.get('s:c1'))!;
    expect(record.attempt).toBe(2);
    // The retry mirrors the fresh path: dispatched marked before execute
    // and the LIVE generation stamped — a second eviction must reconcile
    // this as a dispatched attempt of the current generation, never as
    // "never attempted" under a dead one.
    expect(record.state).toBe(S.AWAITING_REMOTE);
    expect(record.dispatched).toBe(true);
    expect(record.generationId).toBe('gen-1-nonce');
  });

  test('every Class F override requires a new call with re-derived grants', async () => {
    for (const toolName of ['sandbox_create', 'vm_boot', 'actor_create']) {
      const { tracker, log } = makeTracker();
      const tool = { name: toolName, sideEffect: 'read' };
      const retryClass = retryClassForTool(tool);
      expect(retryClass).toBe('F');
      await log.begin({
        operationId: `s:${toolName}`, sessionId: 's', toolName,
        retryClass, generationId: 'gen-0-old',
      });
      await log.settle(`s:${toolName}`, {
        state: S.INTERRUPTED, autoRetry: false,
        retryRequires: ['rederive-grants'], keepIdempotencyKey: false,
        verificationRequired: false, recreateResource: true,
        reason: 'resource host was lost',
      });
      const replay = await tracker.beginTracking({
        callId: toolName, tool: { ...tool, retryClass }, sessionId: 's',
      });
      const refusal = (replay as { refuse: { error: string, recovery: any } }).refuse;
      expect(refusal.error).toStartWith('resource_lost:');
      expect(refusal.recovery.category).toBe('resource_lost');
      expect(refusal.recovery.retryRequires).toEqual(['rederive-grants']);
      expect((await log.get(`s:${toolName}`))!.attempt).toBe(1);
    }
  });

  test('a retried Class D killed mid-flight reconciles as outcome_unknown, not safe-to-retry', async () => {
    const { tracker, log } = makeTracker();
    await log.begin({
      operationId: 's:c1', sessionId: 's', toolName: 'dweb_share',
      retryClass: 'D', generationId: 'gen-0-old',
    });
    await log.settle('s:c1', {
      state: S.INTERRUPTED, autoRetry: true, retryRequires: [],
      keepIdempotencyKey: true, verificationRequired: false,
      recreateResource: false, reason: 'first eviction, pre-dispatch',
    });
    // The sanctioned re-drive… then the SW dies mid-execute.
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 'dweb_share', retryClass: 'D' }, sessionId: 's',
    });
    expect(begun && 'handle' in begun).toBe(true);
    const record = (await log.get('s:c1'))!;
    // The durable evidence a reconciler needs: dispatched, current gen.
    expect(record.dispatched).toBe(true);
    expect(record.generationId).toBe('gen-1-nonce');
  });

  test('an interrupted-before-dispatch Class E call refuses the automatic replay even though it is safe', async () => {
    const { tracker, log } = makeTracker();
    // The record as a real pre-dispatch eviction leaves it: begun and
    // running, never dispatched, settled interrupted by the reconciler.
    await log.begin({
      operationId: 's:c1', sessionId: 's', toolName: 'submit_form',
      retryClass: 'E', generationId: 'gen-0-old',
    });
    await log.transition('s:c1', S.RUNNING);
    await log.settle('s:c1', {
      state: S.INTERRUPTED, autoRetry: false, retryRequires: ['user-instruction'],
      keepIdempotencyKey: false, verificationRequired: false,
      recreateResource: false, reason: 'sw died pre-dispatch',
    });
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 'submit_form', retryClass: 'E' }, sessionId: 's',
    });
    expect((begun as { refuse: { error: string } }).refuse.error).toStartWith('interrupted:');
  });

  test('a dispatched-then-interrupted Class E record still refuses as outcome_unknown — dispatch outranks the label', async () => {
    const { tracker, log } = makeTracker();
    await tracker.beginTracking({
      callId: 'c1', tool: { name: 'submit_form', retryClass: 'E' }, sessionId: 's',
    });
    await log.settle('s:c1', {
      state: S.INTERRUPTED, autoRetry: false, retryRequires: [],
      keepIdempotencyKey: false, verificationRequired: false,
      recreateResource: false, reason: 'mislabelled',
    });
    const begun = await tracker.beginTracking({
      callId: 'c1', tool: { name: 'submit_form', retryClass: 'E' }, sessionId: 's',
    });
    expect((begun as { refuse: { error: string } }).refuse.error).toStartWith('outcome_unknown:');
  });

  test('a fresh call id cannot repeat unknown intent in the same or a synthetic turn', async () => {
    const { tracker } = makeTracker();
    const first = await tracker.beginTracking({
      callId: 'c1', tool: { name: 'submit_form', retryClass: 'E' },
      sessionId: 's', args: { form: 'checkout', value: 1 },
      turnId: 'turn-1', userInitiated: true,
    });
    await tracker.settleTracking((first as { handle: any }).handle, {
      ok: false, error: 'request timed out',
    });
    for (const attempt of [
      { callId: 'c2', turnId: 'turn-1', userInitiated: true },
      { callId: 'c3', turnId: 'turn-2', userInitiated: false },
    ]) {
      const replay = await tracker.beginTracking({
        ...attempt,
        tool: { name: 'submit_form', retryClass: 'E' },
        sessionId: 's', args: { value: 1, form: 'checkout' },
      });
      expect((replay as { refuse: { error: string } }).refuse.error)
        .toStartWith('outcome_unknown:');
    }
  });

  test('a new user confirmation can deliberately repeat previously unknown intent', async () => {
    const { tracker } = makeTracker();
    const first = await tracker.beginTracking({
      callId: 'c1', tool: { name: 'submit_form', retryClass: 'E' },
      sessionId: 's', args: { form: 'checkout' },
      turnId: 'turn-1', userInitiated: true,
    });
    await tracker.settleTracking((first as { handle: any }).handle, {
      ok: false, error: 'request timed out',
    });
    const confirmedIntent = await tracker.requiresIntentConfirmation({
      tool: { name: 'submit_form', retryClass: 'E' },
      sessionId: 's', ownerSessionId: 's', target: 'tool:submit_form',
      args: { form: 'checkout' }, userInitiated: true,
    });
    const deliberate = await tracker.beginTracking({
      callId: 'c2', tool: { name: 'submit_form', retryClass: 'E' },
      sessionId: 's', args: { form: 'checkout' },
      turnId: 'turn-2', userInitiated: true, confirmed: true,
      confirmedIntent,
    });
    expect(deliberate && 'handle' in deliberate).toBe(true);
  });

  test('a sibling actor in the same root chat cannot bypass unknown intent', async () => {
    const log = makeLog();
    const rootFor = async (sessionId: string) =>
      sessionId === 'actor-a' || sessionId === 'actor-b' ? 'chat-root' : sessionId;
    const tracker = makeDispatchTracker({
      operationLog: log,
      generationId: () => 'gen-1-nonce',
      retryClassFor: (tool) => (tool as { retryClass?: string }).retryClass as any ?? 'E',
      classifyFailure,
      resolveOwnerSessionId: rootFor,
    });
    const tool = { name: 'submit_form', retryClass: 'E' };
    const args = { form: 'checkout', amount: 1 };
    const first = await tracker.beginTracking({
      callId: 'actor-a-call', tool, sessionId: 'actor-a',
      ownerSessionId: 'chat-root', target: 'https://shop.example', args,
      userInitiated: true,
    });
    await tracker.settleTracking((first as { handle: any }).handle, {
      ok: false, error: 'request timed out',
    });

    const repeatClaim = await tracker.requiresIntentConfirmation({
      tool, sessionId: 'actor-b', ownerSessionId: 'chat-root',
      target: 'https://shop.example', args, userInitiated: true,
    });
    expect(repeatClaim).toMatchObject({
      required: true, ownerSessionId: 'chat-root', target: 'https://shop.example',
    });
    const unapproved = await tracker.beginTracking({
      callId: 'actor-b-call', tool, sessionId: 'actor-b',
      ownerSessionId: 'chat-root', target: 'https://shop.example', args,
      userInitiated: true,
    });
    expect(unapproved && 'refuse' in unapproved).toBe(true);

    const approved = await tracker.beginTracking({
      callId: 'actor-b-approved', tool, sessionId: 'actor-b',
      ownerSessionId: 'chat-root', target: 'https://shop.example', args,
      userInitiated: true, confirmed: true, confirmedIntent: repeatClaim,
    });
    expect(approved && 'handle' in approved).toBe(true);
    expect((await log.get('actor-b:actor-b-approved'))?.ownerSessionId).toBe('chat-root');
  });

  test('repeat approval is bound to the exact target and intent shown', async () => {
    const { tracker } = makeTracker();
    const tool = { name: 'submit_form', retryClass: 'E' };
    const first = await tracker.beginTracking({
      callId: 'c1', tool, sessionId: 's', target: 'https://shop.example',
      args: { form: 'checkout' }, userInitiated: true,
    });
    await tracker.settleTracking((first as { handle: any }).handle, {
      ok: false, error: 'request timed out',
    });
    const other = await tracker.beginTracking({
      callId: 'c-other', tool, sessionId: 's', target: 'https://shop.example',
      args: { form: 'wire-transfer' }, userInitiated: true,
    });
    await tracker.settleTracking((other as { handle: any }).handle, {
      ok: false, error: 'request timed out',
    });
    const claim = await tracker.requiresIntentConfirmation({
      tool, sessionId: 's', target: 'https://shop.example',
      args: { form: 'checkout' }, userInitiated: true,
    });
    const changedAfterPrompt = await tracker.beginTracking({
      callId: 'c2', tool, sessionId: 's', target: 'https://shop.example',
      args: { form: 'wire-transfer' }, userInitiated: true,
      confirmed: true, confirmedIntent: claim,
    });
    expect(changedAfterPrompt && 'refuse' in changedAfterPrompt).toBe(true);

    const otherTarget = await tracker.beginTracking({
      callId: 'c-bank', tool, sessionId: 's', target: 'https://bank.example',
      args: { form: 'checkout' }, userInitiated: true,
    });
    await tracker.settleTracking((otherTarget as { handle: any }).handle, {
      ok: false, error: 'request timed out',
    });
    const retargetedAfterPrompt = await tracker.beginTracking({
      callId: 'c3', tool, sessionId: 's', target: 'https://bank.example',
      args: { form: 'checkout' }, userInitiated: true,
      confirmed: true, confirmedIntent: claim,
    });
    expect(retargetedAfterPrompt && 'refuse' in retargetedAfterPrompt).toBe(true);
  });

  test('a later user turn without confirmation still cannot repeat unknown intent', async () => {
    const { tracker } = makeTracker();
    const first = await tracker.beginTracking({
      callId: 'c1', tool: { name: 'submit_form', retryClass: 'E' },
      sessionId: 's', args: { form: 'checkout' },
      turnId: 'turn-1', userInitiated: true,
    });
    await tracker.settleTracking((first as { handle: any }).handle, {
      ok: false, error: 'request timed out',
    });
    const unapproved = await tracker.beginTracking({
      callId: 'c2', tool: { name: 'submit_form', retryClass: 'E' },
      sessionId: 's', args: { form: 'checkout' },
      turnId: 'turn-2', userInitiated: true,
    });
    expect((unapproved as { refuse: { error: string } }).refuse.error)
      .toContain('needs a new user confirmation');
  });
});

describe('the full dispatcher path', () => {
  const baseCtx = () => ({
    audit: async () => {},
    session: { sessionId: 'sess-1' },
    permission: { mode: 'act', confirmActions: false },
    hooks: [],
  });

  beforeEach(fixture.clear);

  test('a tracked tool that times out returns the semantic error and recovery meta', async () => {
    const { tracker, log } = makeTracker();
    setFixtureTool({
      name: 'flaky_submit', description: 'x', schema: {},
      primitive: 'web', sideEffect: 'mutate_external', retryClass: 'E',
      origins: () => ['https://example.com'],
      execute: async () => { throw new Error('request timed out'); },
    } as any);
    const result = await dispatchToolCall(
      { id: 'tu-1', name: 'flaky_submit', args: {} },
      { ...baseCtx(), lifecycle: tracker } as any,
    );
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toStartWith('outcome_unknown:');
    expect((result.meta as any).recovery.category).toBe('verify_before_retry');
    expect((await log.get('sess-1:tu-1'))!.state).toBe(S.OUTCOME_UNKNOWN);
  });

  test('Git mutation host loss remains unknown through controller settlement', async () => {
    for (const operation of ['checkpoint', 'restore', 'link', 'fetch', 'push'] as const) {
      const { tracker, log } = makeTracker();
      const failure = Object.assign(new Error('late host reply'), {
        code: 'repository-host-timeout', outcomeKnown: false, outcomeKind: 'host-lost',
      });
      const approvedRemote = { url: 'https://github.com/owner/repo.git', host: 'github.com' };
      const repositoryAuthority = {
        readRemote: async () => approvedRemote,
        confirmRestore: async () => 'yes_once',
        confirmRemote: async () => 'yes_once',
        checkpoint: async () => { throw failure; },
        restore: async () => { throw failure; },
        link: async () => { throw failure; },
        fetch: async () => { throw failure; },
        push: async () => { throw failure; },
      };
      const isRemote = ['link', 'fetch', 'push'].includes(operation);
      const name = isRemote ? 'repo_remote' : 'repo_version';
      const args = operation === 'restore' ? { op: operation, to: 'abc123' }
        : operation === 'link'
          ? { op: operation, url: 'https://github.com/owner/repo' }
          : { op: operation };
      const id = `git-${operation}`;
      const prepared: any = await prepareToolCall({ id, name, args }, {
        ...baseCtx(), lifecycle: tracker,
        exposure: 'actor', actorType: 'app', actorInstanceId: 'app-1',
        session: { sessionId: 'sess-1', kind: 'actor' },
      } as any, toToolDescriptor(getToolAuthority(name)));
      expect(prepared.prepared).toBe(true);
      const semantic = await executeControllerRepositoryTool(
        name, args, { actorType: 'app', actorInstanceId: 'app-1' },
        repositoryAuthority, { signal: new AbortController().signal },
      );
      const result = await settleToolCall(prepared, { result: semantic });
      expect(result).toMatchObject({
        ok: false,
        code: 'repository-host-timeout',
        outcomeKnown: false,
        outcomeKind: 'host-lost',
        retryable: false,
      });
      expect((result as { error: string }).error).toStartWith('outcome_unknown:');
      expect((result.meta as any).recovery).toMatchObject({
        state: S.OUTCOME_UNKNOWN, autoRetry: false, verificationRequired: true,
      });
      expect((await log.get(`sess-1:${id}`))!.state).toBe(S.OUTCOME_UNKNOWN);
    }
  });

  test('re-dispatching the same tool_use id does NOT re-execute the tool', async () => {
    const { tracker } = makeTracker();
    let executions = 0;
    setFixtureTool({
      name: 'pay_once', description: 'x', schema: {},
      primitive: 'web', sideEffect: 'mutate_external', retryClass: 'E',
      origins: () => [],
      execute: async () => { executions += 1; throw new Error('connection reset'); },
    } as any);
    const ctx = { ...baseCtx(), lifecycle: tracker } as any;
    await dispatchToolCall({ id: 'tu-1', name: 'pay_once', args: {} }, ctx);
    const replay = await dispatchToolCall({ id: 'tu-1', name: 'pay_once', args: {} }, ctx);
    expect(executions).toBe(1); // the replay never reached execute()
    expect(replay.ok).toBe(false);
    expect((replay as { error: string }).error).toStartWith('outcome_unknown:');
  });

  test('a matching unknown intent forces an honestly attributed actor confirmation', async () => {
    const { tracker } = makeTracker();
    const beginTracking = tracker.beginTracking;
    let boundApprovalClaim: any = null;
    tracker.beginTracking = async (input: any) => {
      boundApprovalClaim = input.confirmedIntent ?? boundApprovalClaim;
      return beginTracking(input);
    };
    let executions = 0;
    const prompts: any[] = [];
    setFixtureTool({
      name: 'pay_once', description: 'x', schema: {},
      primitive: 'web', sideEffect: 'mutate_external', retryClass: 'E',
      origins: () => ['https://payments.example/checkout'],
      execute: async () => {
        executions += 1;
        if (executions === 1) throw new Error('connection reset');
        return { ok: true, content: 'done' };
      },
    } as any);
    await dispatchToolCall(
      { id: 'tu-1', name: 'pay_once', args: { amount: 1 } },
      {
        ...baseCtx(), lifecycle: tracker,
        lifecycleTurnId: 'turn-1', lifecycleUserInitiated: true,
      } as any,
    );
    const repeat = await dispatchToolCall(
      { id: 'tu-2', name: 'pay_once', args: { amount: 1 } },
      {
        ...baseCtx(), lifecycle: tracker,
        lifecycleTurnId: 'turn-2', lifecycleUserInitiated: true,
        session: { ...baseCtx().session, kind: 'actor' },
        confirm: async (prompt: any) => { prompts.push(prompt); return 'yes_once'; },
      } as any,
    );
    expect(repeat.ok).toBe(true);
    expect(executions).toBe(2);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].note).toContain('An actor in this chat');
    expect(prompts[0].note).toContain('outcome is unknown');
    expect(prompts[0].lifecycleTarget).toBe('https://payments.example');
    expect(prompts[0].lifecycleTarget).toBe(boundApprovalClaim.target);
    expect(prompts[0].oneShot).toBe(true);
  });

  test('a self-confirming tool can resolve unknown intent without losing its detailed consent', async () => {
    const { tracker } = makeTracker();
    let executions = 0;
    const prompts: any[] = [];
    setFixtureTool({
      name: 'site_client_write', description: 'x', schema: {},
      primitive: 'web', sideEffect: 'write', retryClass: 'E',
      origins: () => ['https://shop.example'],
      execute: async (_args: any, ctx: any) => {
        executions += 1;
        const answer = await ctx.confirm({
          tool: 'site_client_write', sideEffect: 'write',
          origins: ['https://shop.example'], summary: 'Detailed client proposal',
          sessionId: ctx.session?.sessionId,
        });
        if (answer !== 'yes_once') return { ok: false, error: 'declined' };
        if (executions === 1) throw new Error('connection reset');
        return { ok: true, content: 'saved' };
      },
    } as any);
    const ctx = {
      ...baseCtx(), lifecycle: tracker,
      lifecycleTurnId: 'turn-1', lifecycleUserInitiated: true,
      confirm: async (prompt: any) => { prompts.push(prompt); return 'yes_once'; },
    } as any;
    await dispatchToolCall({
      id: 'tu-1', name: 'site_client_write', args: { origin: 'https://shop.example' },
    }, ctx);
    expect(prompts).toHaveLength(1);

    const repeated = await dispatchToolCall({
      id: 'tu-2', name: 'site_client_write', args: { origin: 'https://shop.example' },
    }, { ...ctx, lifecycleTurnId: 'turn-2' });
    expect(repeated.ok).toBe(true);
    expect(prompts).toHaveLength(3);
    expect(prompts[1].note).toContain('unknown outcome');
    expect(prompts[2].summary).toBe('Detailed client proposal');
    expect(prompts[1].dispatchId).toBe('tu-2');
    expect(prompts[2].dispatchId).toBe('tu-2');
  });

  test('a synthetic repeat is refused without opening a confirmation prompt', async () => {
    const { tracker } = makeTracker();
    let prompts = 0;
    setFixtureTool({
      name: 'pay_once', description: 'x', schema: {},
      primitive: 'web', sideEffect: 'mutate_external', retryClass: 'E',
      origins: () => [],
      execute: async () => { throw new Error('connection reset'); },
    } as any);
    await dispatchToolCall(
      { id: 'tu-1', name: 'pay_once', args: { amount: 1 } },
      {
        ...baseCtx(), lifecycle: tracker,
        lifecycleTurnId: 'turn-1', lifecycleUserInitiated: true,
      } as any,
    );
    const repeat = await dispatchToolCall(
      { id: 'tu-2', name: 'pay_once', args: { amount: 1 } },
      {
        ...baseCtx(), lifecycle: tracker,
        lifecycleTurnId: 'turn-2', lifecycleUserInitiated: false,
        confirm: async () => { prompts += 1; return 'yes_once'; },
      } as any,
    );
    expect(repeat.ok).toBe(false);
    expect(prompts).toBe(0);
    expect((repeat as { error: string }).error).toContain('needs a new user confirmation');
  });

  test('without ctx.lifecycle the dispatch is unchanged (no tracking, no rewrite)', async () => {
    setFixtureTool({
      name: 'plain', description: 'x', schema: {},
      primitive: 'web', sideEffect: 'mutate_external',
      origins: () => [],
      execute: async () => { throw new Error('request timed out'); },
    } as any);
    const result = await dispatchToolCall(
      { id: 'tu-1', name: 'plain', args: {} }, baseCtx() as any);
    expect((result as { error: string }).error).toBe('request timed out');
  });
});
