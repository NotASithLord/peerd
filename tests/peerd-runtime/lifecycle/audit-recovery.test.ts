// Lifecycle audit sanitization (§13) + the paired user/agent recovery
// reports (§14): same semantic distinction on both sides, secrets
// structurally excluded from audit detail.

import { describe, test, expect } from 'bun:test';
import {
  LIFECYCLE_EVENTS, lifecycleAuditEntry, sanitizeDetail,
} from '../../../extension/peerd-runtime/lifecycle/audit-events.js';
import {
  RECOVERY_CATEGORIES, categorizeRecovery, describeRecovery,
  securityDegradationReport, migrationBlockedReport,
} from '../../../extension/peerd-runtime/lifecycle/recovery-report.js';
import { decideRecovery } from '../../../extension/peerd-runtime/lifecycle/retry-class.js';
import { OPERATION_STATES } from '../../../extension/peerd-runtime/lifecycle/operation-state.js';

describe('audit sanitization', () => {
  test('forbidden keys are dropped at any depth', () => {
    const detail = sanitizeDetail({
      toolName: 'fetch_url',
      authorization: 'Bearer xyz',
      nested: {
        setCookie: 'sid=1', dpopProof: 'jwt', requestBody: 'payload',
        apiKey: 'sk-123', ok: 'kept',
      },
    }) as Record<string, any>;
    expect(detail.toolName).toBe('fetch_url');
    expect(detail.authorization).toBeUndefined();
    expect(detail.nested.setCookie).toBeUndefined();
    expect(detail.nested.dpopProof).toBeUndefined();
    expect(detail.nested.requestBody).toBeUndefined();
    expect(detail.nested.apiKey).toBeUndefined();
    expect(detail.nested.ok).toBe('kept');
  });

  test('strings are truncated and depth is bounded', () => {
    const long = 'x'.repeat(2000);
    expect((sanitizeDetail(long) as string).length).toBeLessThan(600);
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(JSON.stringify(sanitizeDetail(deep))).toContain('depth-capped');
  });

  test('entries carry the correlation chain and refuse unknown events', () => {
    const entry = lifecycleAuditEntry({
      event: LIFECYCLE_EVENTS.RETRY_REFUSED,
      sessionId: 's', actorId: 'a', operationId: 'o', attempt: 2,
      result: 'outcome_unknown', generationId: 'gen-1-x',
      detail: { password: 'nope', why: 'class E' },
    });
    expect(entry).toMatchObject({
      event: 'lifecycle.retry.refused', sessionId: 's', actorId: 'a',
      operationId: 'o', attempt: 2, result: 'outcome_unknown',
    });
    expect((entry.detail as Record<string, unknown>).password).toBeUndefined();
    expect(() => lifecycleAuditEntry({ event: 'made.up' })).toThrow(TypeError);
  });
});

describe('recovery reports — §14 categories', () => {
  test('interrupted Class A/C/E-undispatched → safe to retry', () => {
    for (const retryClass of ['A', 'C', 'E']) {
      const verdict = decideRecovery({ retryClass, dispatched: false });
      expect(categorizeRecovery(verdict, { retryClass }))
        .toBe(RECOVERY_CATEGORIES.SAFE_TO_RETRY);
    }
  });

  test('Class B → retry requires budget confirmation', () => {
    const verdict = decideRecovery({ retryClass: 'B', dispatched: false });
    expect(categorizeRecovery(verdict, { retryClass: 'B' }))
      .toBe(RECOVERY_CATEGORIES.RETRY_REQUIRES_BUDGET);
  });

  test('outcome_unknown → verify before retry, and user/agent agree', () => {
    const verdict = decideRecovery({ retryClass: 'E', dispatched: true });
    const report = describeRecovery(verdict, {
      retryClass: 'E', operationId: 'op-1', toolName: 'submit_form',
    });
    expect(report.category).toBe(RECOVERY_CATEGORIES.VERIFY_BEFORE_RETRY);
    expect(report.user).toContain('Check the target before repeating it');
    expect(report.agent).toMatchObject({
      category: RECOVERY_CATEGORIES.VERIFY_BEFORE_RETRY,
      state: OPERATION_STATES.OUTCOME_UNKNOWN,
      autoRetry: false,
      verificationRequired: true,
      operationId: 'op-1',
      toolName: 'submit_form',
    });
  });

  test('Class F → resource lost, files remain', () => {
    const verdict = decideRecovery({ retryClass: 'F', dispatched: false });
    const report = describeRecovery(verdict, { retryClass: 'F' });
    expect(report.category).toBe(RECOVERY_CATEGORIES.RESOURCE_LOST);
    expect(report.user).toContain('saved files remain');
  });

  test('settled verdicts are refused — a completed Class E action must never be labelled "safe to retry"', () => {
    const completedVerdict = decideRecovery({
      retryClass: 'E', dispatched: true, evidence: { kind: 'success-response' },
    });
    expect(() => categorizeRecovery(completedVerdict, { retryClass: 'E' }))
      .toThrow(TypeError);
    expect(() => describeRecovery(completedVerdict, { retryClass: 'E' }))
      .toThrow(TypeError);
  });

  test('the two explicit builders: security degradation and migration blocked', () => {
    const security = securityDegradationReport({ detail: 'offscreen doc refused' });
    expect(security.category).toBe(RECOVERY_CATEGORIES.SECURITY_DEGRADATION);
    expect(security.user).toContain('was not run');
    expect(security.agent.autoRetry).toBe(false);

    const migration = migrationBlockedReport({ diagnosticId: 'store-sessions-newer-v9' });
    expect(migration.category).toBe(RECOVERY_CATEGORIES.MIGRATION_BLOCKED);
    expect(migration.user).toContain('No data was changed');
    expect(migration.agent.diagnosticId).toBe('store-sessions-newer-v9');
  });
});
