// Startup reconciliation (§5.3) — a fresh SW generation settling the durable
// records the last one left behind, plus the §5.4 recovery record shape.

import { describe, test, expect } from 'bun:test';
import {
  reconcileAtStartup, buildTurnRecoveryRecord,
} from '../../../extension/peerd-runtime/lifecycle/reconcile.js';
import { mintGeneration } from '../../../extension/peerd-runtime/lifecycle/generation.js';
import { OPERATION_STATES } from '../../../extension/peerd-runtime/lifecycle/operation-state.js';
import { LIFECYCLE_EVENTS } from '../../../extension/peerd-runtime/lifecycle/audit-events.js';

const S = OPERATION_STATES;
const generation = mintGeneration({ seq: 6, id: 'gen-6-old', mintedAt: 0 },
  { nonce: 'fresh-nonce', now: 100 });

const record = (overrides: Record<string, unknown>) => ({
  operationId: 'op-1', sessionId: 'sess-1', toolName: 'fetch_url',
  retryClass: 'B', createdAt: 1, attempt: 1, state: S.RUNNING,
  generationId: 'gen-6-old',
  ...overrides,
});

describe('which records reconcile', () => {
  test('terminal records are immutable history', () => {
    const plan = reconcileAtStartup({
      records: [
        record({ operationId: 'done', state: S.COMPLETED }),
        record({ operationId: 'unk', state: S.OUTCOME_UNKNOWN }),
        record({ operationId: 'gone', state: S.CANCELLED }),
      ],
      generation,
    });
    expect(plan.transitions).toEqual([]);
  });

  test('records stamped with the CURRENT generation are left alone', () => {
    const plan = reconcileAtStartup({
      records: [record({ generationId: generation.id })],
      generation,
    });
    expect(plan.transitions).toEqual([]);
  });

  test('garbage records are skipped, not crashed on', () => {
    const plan = reconcileAtStartup({
      records: [null, {}, record({})] as any,
      generation,
    });
    expect(plan.transitions.length).toBe(1);
  });
});

describe('settling by retry class', () => {
  test('an orphaned running Class B read lands interrupted', () => {
    const plan = reconcileAtStartup({ records: [record({})], generation });
    expect(plan.transitions[0]).toMatchObject({
      operationId: 'op-1', from: S.RUNNING, to: S.INTERRUPTED,
    });
  });

  test('a dispatched Class E side effect lands outcome_unknown with verification required', () => {
    const plan = reconcileAtStartup({
      records: [record({
        toolName: 'submit_form', retryClass: 'E',
        state: S.AWAITING_REMOTE, dispatched: true,
      })],
      generation,
    });
    const [t] = plan.transitions;
    expect(t.to).toBe(S.OUTCOME_UNKNOWN);
    expect(t.verdict.autoRetry).toBe(false);
    expect(t.verdict.verificationRequired).toBe(true);
  });

  test('awaiting_user always lands interrupted — the dead confirmation cannot leave a side effect in flight', () => {
    const plan = reconcileAtStartup({
      records: [record({
        toolName: 'submit_form', retryClass: 'E',
        state: S.AWAITING_USER,
        // Even a (bogus) dispatched flag cannot push awaiting_user into
        // outcome_unknown — waiting on the user means nothing left peerd.
        dispatched: true,
      })],
      generation,
    });
    expect(plan.transitions[0].to).toBe(S.INTERRUPTED);
  });

  test('a cancelling record honors the cancel: cancelled when undispatched', () => {
    const plan = reconcileAtStartup({
      records: [record({
        retryClass: 'E', state: S.CANCELLING, cancelRequested: true,
      })],
      generation,
    });
    expect(plan.transitions[0].to).toBe(S.CANCELLED);
  });

  test('an unclassified record is treated as Class E (fail closed)', () => {
    const plan = reconcileAtStartup({
      records: [record({ retryClass: undefined, state: S.AWAITING_REMOTE, dispatched: true })],
      generation,
    });
    expect(plan.transitions[0].to).toBe(S.OUTCOME_UNKNOWN);
  });
});

describe('notifications and audit', () => {
  test('each settled operation notifies its parent session with the §5.4 record', () => {
    const plan = reconcileAtStartup({
      records: [record({
        actorId: 'actor-7', retryClass: 'E',
        state: S.AWAITING_REMOTE, dispatched: true, lastDurableStep: 7,
      })],
      generation,
    });
    expect(plan.notifications).toEqual([{
      sessionId: 'sess-1',
      actorId: 'actor-7',
      recoveryRecord: {
        operation: 'fetch_url',
        operationId: 'op-1',
        previousState: S.AWAITING_REMOTE,
        recoveryState: S.OUTCOME_UNKNOWN,
        lastDurableStep: 7,
        sideEffectStatus: 'outcome_unknown',
        verificationRequired: true,
      },
    }]);
  });

  test('the safe shape says "none attempted"', () => {
    const rr = buildTurnRecoveryRecord(
      record({ state: S.RUNNING }) as any,
      { state: S.INTERRUPTED, autoRetry: true, retryRequires: [],
        keepIdempotencyKey: false, verificationRequired: false,
        recreateResource: false, reason: 'r' },
    );
    expect(rr.sideEffectStatus).toBe('none attempted');
    expect(rr).not.toHaveProperty('verificationRequired');
  });

  test('the plan always opens with the generation-changed audit event, and settles append theirs', () => {
    const plan = reconcileAtStartup({
      records: [record({}), record({
        operationId: 'op-2', retryClass: 'E',
        state: S.AWAITING_REMOTE, dispatched: true,
      })],
      generation,
    });
    expect(plan.auditEvents[0].event).toBe(LIFECYCLE_EVENTS.SW_GENERATION_CHANGED);
    expect(plan.auditEvents[0].generationId).toBe(generation.id);
    const events = plan.auditEvents.slice(1).map((e) => e.event);
    expect(events).toEqual([
      LIFECYCLE_EVENTS.OPERATION_INTERRUPTED,
      LIFECYCLE_EVENTS.OUTCOME_UNKNOWN,
    ]);
    // Correlation: session → actor → operation → attempt → result.
    const entry = plan.auditEvents[2];
    expect(entry.sessionId).toBe('sess-1');
    expect(entry.operationId).toBe('op-2');
    expect(entry.attempt).toBe(1);
    expect(entry.result).toBe(S.OUTCOME_UNKNOWN);
  });
});
