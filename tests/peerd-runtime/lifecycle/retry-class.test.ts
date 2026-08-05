// Retry classes A–F × interruption phases — the §15 fault matrix at the
// pure-decision level. Each class is asserted against the three dispatch
// phases the SW-eviction fault injections name (before dispatch, after
// dispatch before response, with positive evidence), plus the cancellation
// races: the explicit user action must win.

import { describe, test, expect } from 'bun:test';
import {
  RETRY_CLASSES, isRetryClass, normalizeRetryClass, decideRecovery,
} from '../../../extension/peerd-runtime/lifecycle/retry-class.js';
import { OPERATION_STATES } from '../../../extension/peerd-runtime/lifecycle/operation-state.js';

const S = OPERATION_STATES;
const C = RETRY_CLASSES;

describe('class vocabulary', () => {
  test('the six contract classes', () => {
    expect(Object.values(C).sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(isRetryClass('E')).toBe(true);
    expect(isRetryClass('G')).toBe(false);
  });

  test('unclassified actions fail closed to Class E', () => {
    expect(normalizeRetryClass(undefined)).toBe(C.SIDE_EFFECT);
    expect(normalizeRetryClass('yolo')).toBe(C.SIDE_EFFECT);
    expect(normalizeRetryClass(3)).toBe(C.SIDE_EFFECT);
    expect(normalizeRetryClass('A')).toBe(C.PURE_READ);
  });
});

describe('the eviction matrix: interrupted before dispatch', () => {
  test('Class A: interrupted, auto-retry free', () => {
    const v = decideRecovery({ retryClass: 'A', dispatched: false });
    expect(v.state).toBe(S.INTERRUPTED);
    expect(v.autoRetry).toBe(true);
  });

  test('Class B: interrupted, auto-retry within budget as a new attempt with fresh credentials', () => {
    const v = decideRecovery({ retryClass: 'B', dispatched: false });
    expect(v.state).toBe(S.INTERRUPTED);
    expect(v.autoRetry).toBe(true);
    expect(v.retryRequires).toEqual(['new-attempt', 'fresh-credentials']);
  });

  test('Class B with budget exhausted: no auto-retry, budget is a precondition', () => {
    const v = decideRecovery({ retryClass: 'B', dispatched: false, budgetRemaining: false });
    expect(v.autoRetry).toBe(false);
    expect(v.retryRequires).toContain('budget');
  });

  test('Class C: interrupted, auto-retry with the SAME idempotency key', () => {
    const v = decideRecovery({ retryClass: 'C', dispatched: false });
    expect(v.state).toBe(S.INTERRUPTED);
    expect(v.autoRetry).toBe(true);
    expect(v.keepIdempotencyKey).toBe(true);
  });

  test('Class D undispatched: interrupted, retry keeps the original key', () => {
    const v = decideRecovery({ retryClass: 'D', dispatched: false });
    expect(v.state).toBe(S.INTERRUPTED);
    expect(v.autoRetry).toBe(true);
    expect(v.keepIdempotencyKey).toBe(true);
  });

  test('Class E undispatched: interrupted and safe, but NEVER auto-retried', () => {
    const v = decideRecovery({ retryClass: 'E', dispatched: false });
    expect(v.state).toBe(S.INTERRUPTED);
    expect(v.autoRetry).toBe(false);
    expect(v.retryRequires).toEqual(['user-instruction']);
  });

  test('Class F: interrupted, resource recreated, grants re-derived, no continuation', () => {
    const v = decideRecovery({ retryClass: 'F', dispatched: false });
    expect(v.state).toBe(S.INTERRUPTED);
    expect(v.autoRetry).toBe(false);
    expect(v.recreateResource).toBe(true);
    expect(v.retryRequires).toEqual(['rederive-grants']);
  });
});

describe('the eviction matrix: dispatched, no acknowledgement', () => {
  test('Class A/B/C reads and idempotent writes stay interrupted and retryable', () => {
    for (const retryClass of ['A', 'B', 'C']) {
      const v = decideRecovery({ retryClass, dispatched: true });
      expect(v.state).toBe(S.INTERRUPTED);
      expect(v.autoRetry).toBe(true);
    }
  });

  test('Class D dispatched: outcome_unknown, verification before retry, original key retained', () => {
    const v = decideRecovery({ retryClass: 'D', dispatched: true });
    expect(v.state).toBe(S.OUTCOME_UNKNOWN);
    expect(v.autoRetry).toBe(false);
    expect(v.verificationRequired).toBe(true);
    expect(v.keepIdempotencyKey).toBe(true);
    expect(v.retryRequires).toContain('external-verification');
  });

  test('Class E dispatched: outcome_unknown, never automatic retry — the ambiguous-ack case', () => {
    // The fake-external-service scenario (§15): effect performed, connection
    // dropped before the ack. peerd must say outcome_unknown, not retry.
    const v = decideRecovery({ retryClass: 'E', dispatched: true });
    expect(v.state).toBe(S.OUTCOME_UNKNOWN);
    expect(v.autoRetry).toBe(false);
    expect(v.verificationRequired).toBe(true);
    expect(v.retryRequires).toEqual(['external-verification', 'user-instruction']);
  });

  test('a generic timeout is not failed: no evidence means no failed verdict for any dispatched class', () => {
    for (const retryClass of ['A', 'B', 'C', 'D', 'E', 'F']) {
      const v = decideRecovery({ retryClass, dispatched: true });
      expect(v.state).not.toBe(S.FAILED);
      expect(v.state).not.toBe(S.COMPLETED);
    }
  });
});

describe('positive evidence settles everything', () => {
  test('completion evidence → completed, for every class', () => {
    for (const retryClass of ['A', 'B', 'C', 'D', 'E', 'F']) {
      const v = decideRecovery({
        retryClass, dispatched: true, evidence: { kind: 'success-response' },
      });
      expect(v.state).toBe(S.COMPLETED);
    }
  });

  test('failure evidence → failed', () => {
    const v = decideRecovery({
      retryClass: 'E', dispatched: true,
      evidence: { kind: 'error-response-before-effect' },
    });
    expect(v.state).toBe(S.FAILED);
  });

  test('timeout is not evidence — a Class E call with only a timeout stays outcome_unknown', () => {
    const v = decideRecovery({
      retryClass: 'E', dispatched: true, evidence: { kind: 'timeout' },
    });
    expect(v.state).toBe(S.OUTCOME_UNKNOWN);
  });
});

describe('cancellation races: the explicit user action wins', () => {
  test('cancel before dispatch: cancelled, for every class', () => {
    for (const retryClass of ['A', 'B', 'C', 'D', 'E', 'F']) {
      const v = decideRecovery({ retryClass, dispatched: false, cancelRequested: true });
      expect(v.state).toBe(S.CANCELLED);
      expect(v.autoRetry).toBe(false);
    }
  });

  test('cancel after a Class E dispatch: outcome_unknown, not a false "cancelled"', () => {
    const v = decideRecovery({ retryClass: 'E', dispatched: true, cancelRequested: true });
    expect(v.state).toBe(S.OUTCOME_UNKNOWN);
    expect(v.verificationRequired).toBe(true);
  });

  test('cancel after an idempotent dispatch: cancelled cleanly (duplicates are harmless)', () => {
    for (const retryClass of ['A', 'B', 'C']) {
      const v = decideRecovery({ retryClass, dispatched: true, cancelRequested: true });
      expect(v.state).toBe(S.CANCELLED);
    }
  });

  test('cancel + completion evidence: reported completed — a landed effect is never hidden', () => {
    const v = decideRecovery({
      retryClass: 'E', dispatched: true, cancelRequested: true,
      evidence: { kind: 'verified-state' },
    });
    expect(v.state).toBe(S.COMPLETED);
  });

  test('cancel + proven-absent: a clean cancelled', () => {
    const v = decideRecovery({
      retryClass: 'E', dispatched: true, cancelRequested: true,
      evidence: { kind: 'verified-absent' },
    });
    expect(v.state).toBe(S.CANCELLED);
  });
});
