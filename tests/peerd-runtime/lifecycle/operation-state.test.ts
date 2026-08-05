// Canonical operation states — legality table + outcome_unknown resolution.
//
// The contract's guarantee 1 lives here: an uncertain side effect is never
// silently reported as definitely failed or definitely completed. The
// tests lock the transition table's edges and prove outcome_unknown has
// exactly one exit — positive evidence.

import { describe, test, expect } from 'bun:test';
import {
  OPERATION_STATES, TERMINAL_STATES, isTerminal, isOperationState,
  canTransition, assertTransition, IllegalTransitionError,
  provesCompletion, provesFailure, resolveUnknownOutcome,
  UnknownOutcomeUnresolvedError,
} from '../../../extension/peerd-runtime/lifecycle/operation-state.js';

const S = OPERATION_STATES;

describe('state vocabulary', () => {
  test('exactly the contract §3 states, no extras', () => {
    expect(Object.values(S).sort()).toEqual([
      'awaiting_remote', 'awaiting_user', 'cancelled', 'cancelling',
      'completed', 'created', 'failed', 'interrupted', 'outcome_unknown',
      'queued', 'running',
    ]);
  });

  test('the five §3.1 terminal states, and only those', () => {
    expect([...TERMINAL_STATES].sort()).toEqual([
      'cancelled', 'completed', 'failed', 'interrupted', 'outcome_unknown',
    ]);
    expect(isTerminal(S.RUNNING)).toBe(false);
    expect(isTerminal(S.OUTCOME_UNKNOWN)).toBe(true);
  });

  test('isOperationState rejects garbage', () => {
    expect(isOperationState('running')).toBe(true);
    expect(isOperationState('exploded')).toBe(false);
    expect(isOperationState(undefined)).toBe(false);
    expect(isOperationState(42)).toBe(false);
  });
});

describe('transition legality', () => {
  test('the ordinary forward path is legal', () => {
    expect(canTransition(S.CREATED, S.QUEUED)).toBe(true);
    expect(canTransition(S.QUEUED, S.RUNNING)).toBe(true);
    expect(canTransition(S.RUNNING, S.AWAITING_REMOTE)).toBe(true);
    expect(canTransition(S.AWAITING_REMOTE, S.COMPLETED)).toBe(true);
    expect(canTransition(S.RUNNING, S.AWAITING_USER)).toBe(true);
    expect(canTransition(S.AWAITING_USER, S.RUNNING)).toBe(true);
  });

  test('no transition leaves any terminal state', () => {
    for (const from of TERMINAL_STATES) {
      for (const to of Object.values(S)) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  test('awaiting_user can never reach outcome_unknown (no side effect is in flight while waiting on the user)', () => {
    expect(canTransition(S.AWAITING_USER, S.OUTCOME_UNKNOWN)).toBe(false);
    expect(canTransition(S.AWAITING_USER, S.INTERRUPTED)).toBe(true);
  });

  test('cancelling may still land completed — a landed effect is reported truthfully', () => {
    expect(canTransition(S.CANCELLING, S.COMPLETED)).toBe(true);
    expect(canTransition(S.CANCELLING, S.CANCELLED)).toBe(true);
    expect(canTransition(S.CANCELLING, S.OUTCOME_UNKNOWN)).toBe(true);
    expect(canTransition(S.CANCELLING, S.RUNNING)).toBe(false);
  });

  test('unknown states are never movable (fail closed)', () => {
    expect(canTransition('exploded', S.FAILED)).toBe(false);
    expect(canTransition(S.RUNNING, 'exploded')).toBe(false);
  });

  test('assertTransition throws a named error on illegal moves', () => {
    expect(() => assertTransition(S.COMPLETED, S.RUNNING))
      .toThrow(IllegalTransitionError);
    expect(assertTransition(S.RUNNING, S.COMPLETED)).toBe(S.COMPLETED);
  });
});

describe('outcome_unknown resolution — positive evidence only', () => {
  test('completion evidence resolves to completed', () => {
    for (const kind of ['success-response', 'verified-state',
      'idempotency-key-lookup', 'durable-commit-check']) {
      expect(provesCompletion(kind)).toBe(true);
      expect(resolveUnknownOutcome({ kind })).toBe(S.COMPLETED);
    }
  });

  test('failure evidence resolves to failed', () => {
    for (const kind of ['error-response-before-effect', 'verified-absent',
      'user-verified-absent']) {
      expect(provesFailure(kind)).toBe(true);
      expect(resolveUnknownOutcome({ kind })).toBe(S.FAILED);
    }
  });

  test('a timeout or lost connection NEVER resolves outcome_unknown', () => {
    for (const kind of ['timeout', 'connection-lost', 'probably-failed',
      undefined, null, '']) {
      expect(() => resolveUnknownOutcome({ kind }))
        .toThrow(UnknownOutcomeUnresolvedError);
    }
  });

  test('there is no automatic outcome_unknown → failed path anywhere', () => {
    // Belt and braces: the transition table refuses it too.
    expect(canTransition(S.OUTCOME_UNKNOWN, S.FAILED)).toBe(false);
    expect(canTransition(S.OUTCOME_UNKNOWN, S.COMPLETED)).toBe(false);
  });
});
