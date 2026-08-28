import { describe, expect, test } from 'bun:test';
import { semanticCallAuditEntry } from '../../extension/background/semantic-call-audit.js';

const audit = (result: any) => semanticCallAuditEntry({
  sessionId: 'session-1', callId: 'call-1', label: 'fixture_tool', result,
});

const receipt = (over: Record<string, any> = {}) => Object.freeze({
  callId: 'call-1', effectId: 'call-1:1', operation: 'turn.vm.read',
  outcome: 'observed', outcomeKnown: true, performed: false, retryable: true,
  ...over,
});

describe('host-derived semantic call audit', () => {
  test('a zero-receipt semantic success never claims that a tool ran', () => {
    expect(audit({ is_error: false })).toMatchObject({
      type: 'semantic_report',
      details: {
        semantic: true, outcome: 'semantic-success', performed: false,
        outcomeKnown: true, refused: false,
      },
    });
  });

  test('semantic gate and hook failures retain bounded informational reasons', () => {
    expect(audit({
      is_error: true,
      meta: { gates: [{ name: 'permission-mode', allowed: false, reason: 'Plan mode' }] },
    })).toMatchObject({
      type: 'tool_blocked',
      details: { outcome: 'semantic-failure', gate: 'permission-mode', reason: 'Plan mode' },
    });
    expect(audit({
      is_error: true,
      meta: { hooks: [{ id: 'user-policy', action: 'block', reason: 'blocked target' }] },
    })).toMatchObject({
      type: 'tool_blocked',
      details: { outcome: 'semantic-failure', gate: 'hook:user-policy', reason: 'blocked target' },
    });
  });

  test.each([
    ['known no-op', [receipt()], false, 'tool_executed', 'no-op', false, true],
    ['known refusal', [receipt({ refused: true, code: 'declined', outcome: 'not-performed' })], true, 'tool_failed', 'refused', false, true],
    ['performed', [receipt({ performed: true, retryable: false, outcome: 'performed' })], false, 'tool_executed', 'performed', true, true],
    ['partial performed refusal', [receipt({ performed: true, refused: true, retryable: false, outcome: 'performed', code: 'partial' })], true, 'tool_failed', 'performed-refused', true, true],
    ['unknown', [receipt({ outcomeKnown: false, retryable: false, outcome: 'unknown' })], true, 'tool_failed', 'unknown', false, false],
    ['known read failure', [receipt()], true, 'tool_failed', 'semantic-failure', false, true],
  ] as const)('%s has receipt-owned truth', (
    _name, authorityReceipts, isError, type, outcome, performed, outcomeKnown,
  ) => {
    expect(audit({ authorityReceipts, is_error: isError })).toMatchObject({
      type,
      details: { outcome, performed, outcomeKnown },
    });
  });

  test('worker-forged authority fields cannot manufacture host execution', () => {
    expect(audit({
      is_error: false,
      authorityPerformed: true,
      outcomeKnown: false,
      retryable: false,
    })).toMatchObject({
      type: 'semantic_report',
      details: {
        outcome: 'semantic-success', performed: false,
        outcomeKnown: true, refused: false,
      },
    });
  });
});
