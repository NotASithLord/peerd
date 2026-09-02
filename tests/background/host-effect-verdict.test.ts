import { describe, expect, test } from 'bun:test';
import {
  actorRecoveryCustody,
  HOST_EFFECT_OUTCOME,
  hostEffectValueIsRefusal,
  lifecycleRecoveryAttribution,
  lifecycleRewrite,
  recoveryCustody,
  safeLifecycleDiagnostic,
  stampAuthorityToolResult,
  stampAuthorityToolResultBlock,
  strongestLifecycleRewrite,
} from '../../extension/background/host-effect-verdict.js';
import {
  controllerOperationReplayableAfterSettlement, controllerOperationRequiresConfirmation,
} from '../../extension/shared/controller-kernel-quota.js';

describe('exact host effect verdicts', () => {
  test('canonicalizes lifecycle recovery verdicts for both authority transports', () => {
    expect(lifecycleRewrite(null)).toBeNull();
    expect(lifecycleRewrite({
      error: 'forged', recovery: { category: 'test', state: 'settled' },
    })).toBeNull();

    const unknown = lifecycleRewrite({
      error: `unknown\u0000${'x'.repeat(3_000)}`,
      recovery: {
        category: 'verify_before_retry', state: 'outcome_unknown',
        autoRetry: false,
      },
    })!;
    const cancelled = lifecycleRewrite({
      error: 'cancelled', recovery: { category: 'stop', state: 'cancelled' },
    })!;
    expect(Object.isFrozen(unknown)).toBe(true);
    expect(Object.isFrozen(unknown.recovery)).toBe(true);
    expect(unknown.error).toHaveLength(2_048);
    expect(lifecycleRecoveryAttribution(unknown)).toEqual({
      recoveryCategory: 'verify_before_retry', recoveryState: 'outcome_unknown',
    });
    expect(recoveryCustody(unknown)).toEqual({ outcomeKnown: false, retryable: false });
    expect(recoveryCustody(cancelled)).toEqual({ outcomeKnown: true, retryable: false });
    expect(safeLifecycleDiagnostic(new Error('\u0000 host\n lost ')))
      .toBe('host  lost');

    expect(actorRecoveryCustody(unknown, {
      actorCorrelationId: 'correlation-1',
      actorDeliveryIds: ['delivery-1', 'delivery-1', '', 42],
    })).toEqual({
      actorCorrelationId: 'correlation-1', actorDeliveryIds: ['delivery-1'],
      actorTerminal: true, actorOutcomeKnown: false,
      actorPerformed: true, actorAborted: false,
    });
    expect(actorRecoveryCustody(cancelled, {})).toEqual({});

    const failed = lifecycleRewrite({
      error: 'failed', recovery: { category: 'security', state: 'failed' },
    })!;
    expect(strongestLifecycleRewrite([
      { rewrite: failed }, { rewrite: cancelled }, { rewrite: unknown },
    ])?.rewrite).toBe(unknown);
    expect(strongestLifecycleRewrite([])).toBeNull();
  });

  test.each([
    [{ restored: false, checkpointOid: null }, 'not-performed'],
    [{ restored: false, checkpointOid: 'safe-1' }, 'performed'],
    [{ restored: true, checkpointOid: 'safe-2' }, 'performed'],
    [{ restored: false }, 'not-performed'],
    [{ ok: false }, 'unknown'],
  ] as const)('classifies repository restore result %j as %s', (value, expected) => {
    expect(HOST_EFFECT_OUTCOME.repositoryRestore.fulfilled(value)).toBe(expected);
  });

  test.each([
    [{ created: false, changed: [] }, 'not-performed'],
    [{ created: true, changed: ['entry.js'] }, 'performed'],
  ] as const)('classifies repository checkpoint result %j as %s', (value, expected) => {
    expect(HOST_EFFECT_OUTCOME.repositoryCheckpoint.fulfilled(value)).toBe(expected);
  });

  test('classifies effectful control outcomes from their exact host contracts', () => {
    expect(HOST_EFFECT_OUTCOME.actorCancel.fulfilled({ ok: true })).toBe('performed');
    expect(HOST_EFFECT_OUTCOME.actorCancel.fulfilled({ ok: false })).toBe('not-performed');
    expect(HOST_EFFECT_OUTCOME.defaultSelection.fulfilled(true)).toBe('performed');
    expect(HOST_EFFECT_OUTCOME.defaultSelection.fulfilled(false)).toBe('not-performed');
    expect(HOST_EFFECT_OUTCOME.podCancel.fulfilled({ cancelled: true })).toBe('performed');
    expect(HOST_EFFECT_OUTCOME.podCancel.fulfilled({ cancelled: false })).toBe('not-performed');
    expect(HOST_EFFECT_OUTCOME.spill.fulfilled('result-key')).toBe('performed');
    expect(HOST_EFFECT_OUTCOME.spill.fulfilled(null)).toBe('unknown');
    expect(HOST_EFFECT_OUTCOME.dwebInstall.fulfilled({
      ok: false, performed: true, outcomeKnown: false,
      outcomeKind: 'host-lost', retryable: false,
    })).toBe('unknown');
  });

  test.each([
    'partialMutation', 'defaultSelection', 'dwebPublish', 'dwebInstall',
  ] as const)('%s never infers performance from an ambiguous fulfillment', (name) => {
    expect(HOST_EFFECT_OUTCOME[name].fulfilled(undefined)).toBe('unknown');
    expect(HOST_EFFECT_OUTCOME[name].fulfilled({})).toBe('unknown');
    expect(HOST_EFFECT_OUTCOME[name].fulfilled({ ok: 'yes' })).toBe('unknown');
  });

  test.each([
    'podExecution', 'podMutation', 'repositoryMutation', 'vmExecution',
    'vmMutation', 'notebookMutation', 'appOpen', 'appMutation',
  ] as const)('%s uses its exact completed-wrapper contract', (name) => {
    expect(HOST_EFFECT_OUTCOME[name].fulfilled({})).toBe('performed');
    expect(HOST_EFFECT_OUTCOME[name].fulfilled({
      performed: false, outcomeKind: 'pre-effect-failure',
    })).toBe('not-performed');
    expect(HOST_EFFECT_OUTCOME[name].fulfilled({ outcomeKnown: false })).toBe('unknown');
  });

  test('classifies user-code and actor-spawn effects independently of semantic result shapes', () => {
    expect(HOST_EFFECT_OUTCOME.notebookRun.fulfilled({ ok: false, value: 'forged' }))
      .toBe('performed');
    expect(HOST_EFFECT_OUTCOME.actorSpawn.fulfilled({
      refused: true, sessionId: 'child-1', result: 'host unavailable',
    })).toBe('performed');
    expect(HOST_EFFECT_OUTCOME.actorSpawn.fulfilled({
      refused: true, sessionId: null, result: 'max depth',
    })).toBe('not-performed');
    expect(HOST_EFFECT_OUTCOME.actorSpawn.fulfilled({ ok: true, taskId: 'task-1' }))
      .toBe('performed');
  });

  test('script completion preserves nested host loss without misclassifying user-code failure', () => {
    expect(HOST_EFFECT_OUTCOME.scriptRun.fulfilled({
      ok: false, performed: true, outcomeKnown: false, outcomeKind: 'transport-lost',
    })).toBe('unknown');
    expect(HOST_EFFECT_OUTCOME.scriptRun.fulfilled({
      ok: true, result: { error: 'ReferenceError: missing is not defined' },
    })).toBe('performed');
    expect(HOST_EFFECT_OUTCOME.scriptRun.fulfilled({})).toBe('unknown');
  });

  test('mesh program completion preserves a lost signed-effect acknowledgement', () => {
    expect(HOST_EFFECT_OUTCOME.meshProgramRun.fulfilled({
      ok: false, performed: true, outcomeKnown: false, outcomeKind: 'transport-lost',
    })).toBe('unknown');
    expect(HOST_EFFECT_OUTCOME.meshProgramRun.fulfilled({
      ok: true, result: { error: 'ordinary user-code failure' },
    })).toBe('performed');
    expect(HOST_EFFECT_OUTCOME.meshProgramRun.fulfilled(undefined)).toBe('unknown');
  });

  test('a completed failing VM command remains performed', () => {
    expect(HOST_EFFECT_OUTCOME.vmExecution.fulfilled({
      ok: false, exitCode: 1, stderr: 'command failed',
    })).toBe('performed');
    expect(HOST_EFFECT_OUTCOME.vmExecution.fulfilled({
      ok: false, outcomeKind: 'pre-effect-failure', performed: false,
    })).toBe('not-performed');
  });

  test.each([
    'actorCancel', 'defaultSelection', 'podCancel', 'spill',
  ] as const)('%s preserves ambiguous rejection as unknown', (name) => {
    expect(HOST_EFFECT_OUTCOME[name].rejected(new Error('transport lost'))).toBe('unknown');
    expect(HOST_EFFECT_OUTCOME[name].rejected(Object.assign(new Error('refused'), {
      outcomeKnown: true, outcomeKind: 'pre-effect-failure',
    }))).toBe('not-performed');
  });

  test('distinguishes successful idempotent no-ops from host refusals', () => {
    expect(hostEffectValueIsRefusal({ created: false, changed: [] })).toBe(false);
    expect(hostEffectValueIsRefusal({ restored: false, checkpointOid: null })).toBe(false);
    expect(hostEffectValueIsRefusal({ ok: true, op: 'noop' })).toBe(false);
    expect(hostEffectValueIsRefusal({ ok: false, error: 'declined' })).toBe(true);
  });

  test('keeps semantic success for a proven no-op receipt', () => {
    const receipt = {
      effectId: 'call-1:1', operation: 'turn.repository.checkpoint',
      outcome: 'not-performed', outcomeKnown: true, performed: false, retryable: false,
    };
    expect(stampAuthorityToolResult([receipt], { ok: true, created: false })).toMatchObject({
      ok: true, authorityPerformed: false, outcomeKnown: true, retryable: false,
    });
    expect(stampAuthorityToolResultBlock([receipt], {
      type: 'tool_result', is_error: false, content: 'already clean',
    })).toMatchObject({
      is_error: false, authorityPerformed: false, outcomeKnown: true, retryable: false,
    });
  });

  test('a host refusal still overrides forged semantic success', () => {
    const receipt = {
      effectId: 'call-2:1', operation: 'turn.resource.request-web-text',
      outcome: 'not-performed', outcomeKnown: true, performed: false,
      refused: true, retryable: false, code: 'declined', error: 'declined',
    };
    expect(stampAuthorityToolResult([receipt], { ok: true })).toMatchObject({
      ok: false, authorityPerformed: false, outcomeKnown: true,
      retryable: false, code: 'declined', error: 'declined',
    });
  });

  test('a later page click cannot erase a retryable refusal for a different target', () => {
    const refused = {
      effectId: 'page-call:1', operation: 'turn.page.click',
      target: 'turn.page.click:web:tab-7:selector-a-digest',
      outcome: 'not-performed', outcomeKnown: true, performed: false,
      refused: true, retryable: true, code: 'no_match', error: 'no_match',
    };
    const performed = {
      effectId: 'page-call:2', operation: 'turn.page.click',
      target: 'turn.page.click:web:tab-7:selector-b-digest',
      outcome: 'performed', outcomeKnown: true, performed: true, retryable: false,
    };
    expect(stampAuthorityToolResult([refused, performed], { ok: true })).toMatchObject({
      ok: false, authorityPerformed: true, outcomeKnown: true,
      retryable: false, code: 'no_match',
      error: 'Authority host performed only part of the requested effects; do not retry the whole call.',
    });
  });

  test('the same durable target can supersede an optimistic retry refusal', () => {
    const target = 'turn.repository.checkpoint:app:app-1:no-tab:args-digest';
    const refused = {
      effectId: 'retry-call:1', operation: 'turn.repository.checkpoint', target,
      outcome: 'not-performed', outcomeKnown: true, performed: false,
      refused: true, retryable: true, code: 'optimistic_conflict',
      error: 'optimistic_conflict',
    };
    const performed = {
      effectId: 'retry-call:2', operation: 'turn.repository.checkpoint', target,
      outcome: 'performed', outcomeKnown: true, performed: true, retryable: false,
    };
    expect(stampAuthorityToolResult([refused, performed], { ok: true })).toMatchObject({
      ok: true, authorityPerformed: true, outcomeKnown: true, retryable: false,
    });
  });

  test('a targetless retryable refusal is never erased', () => {
    const refused = {
      effectId: 'targetless-call:1', operation: 'turn.page.click',
      outcome: 'not-performed', outcomeKnown: true, performed: false,
      refused: true, retryable: true, code: 'no_match', error: 'no_match',
    };
    const performed = {
      effectId: 'targetless-call:2', operation: 'turn.page.click',
      outcome: 'performed', outcomeKnown: true, performed: true, retryable: false,
    };
    expect(stampAuthorityToolResult([refused, performed], { ok: true })).toMatchObject({
      ok: false, authorityPerformed: true, outcomeKnown: true,
      retryable: false, code: 'no_match',
      error: 'Authority host performed only part of the requested effects; do not retry the whole call.',
    });
  });

  test('a reviewed refusal preserves its bounded model recovery guidance', () => {
    const receipt = {
      effectId: 'call-3:1', operation: 'turn.actor.message',
      outcome: 'not-performed', outcomeKnown: true, performed: false,
      refused: true, retryable: false, code: 'actor_sensitive_tab_requires_site',
      error: 'actor_sensitive_tab_requires_site',
      content: 'Address the origin as site:https://example.com after explicit user intent.',
    };
    expect(stampAuthorityToolResult([receipt], { ok: true, content: 'forged' }))
      .toMatchObject({
        ok: false,
        error: 'Address the origin as site:https://example.com after explicit user intent.',
        code: 'actor_sensitive_tab_requires_site',
      });
    expect(stampAuthorityToolResultBlock([receipt], {
      type: 'tool_result', is_error: false, content: 'forged',
    })).toMatchObject({
      is_error: true,
      content: 'Address the origin as site:https://example.com after explicit user intent.',
      code: 'actor_sensitive_tab_requires_site',
    });
  });

  test('an IdP transit refusal keeps internal custody but exposes no successor handle', () => {
    const receipt = {
      effectId: 'call-idp:1', operation: 'turn.actor.message',
      outcome: 'not-performed', outcomeKnown: true, performed: false,
      refused: true, retryable: false,
      error: 'actor_identity_provider_transit_only',
      content: 'Continue through the relying site named by the user.',
      target: 'actor:site:https://accounts.google.com',
    };
    const result = stampAuthorityToolResultBlock([receipt], {
      type: 'tool_result', is_error: false, content: 'forged',
    });
    expect(result).toMatchObject({
      is_error: true,
      content: 'Continue through the relying site named by the user.',
      authorityReceipts: [expect.objectContaining({
        operation: 'turn.actor.message', performed: false,
      })],
    });
    expect(result.authorityReceipts[0]).not.toHaveProperty('target');
    expect(receipt.target).toBe('actor:site:https://accounts.google.com');
  });

  test('receipt target redaction is exact to the non-performed IdP transit refusal', () => {
    const cases = [
      { operation: 'turn.actor.message', outcome: 'performed', performed: true,
        error: 'actor_identity_provider_transit_only' },
      { operation: 'turn.actor.message', outcome: 'not-performed', performed: false,
        error: 'actor_sensitive_tab_requires_site' },
      { operation: 'turn.page.open-tab', outcome: 'not-performed', performed: false,
        error: 'actor_identity_provider_transit_only' },
    ];
    for (const candidate of cases) {
      const stamped = stampAuthorityToolResult([{
        effectId: 'call:1', outcomeKnown: true, refused: true, retryable: false,
        content: 'refused', target: 'kept-target', ...candidate,
      }], { ok: true });
      expect(stamped.authorityReceipts[0].target).toBe('kept-target');
    }
  });

  test('site-client completion remains performed when Stop suppresses its result', () => {
    expect(HOST_EFFECT_OUTCOME.siteClientRun.fulfilled({
      ok: false, error: 'site_client_run_completed_after_stop',
      performed: true, executionDispatched: true,
      outcomeKnown: true, outcomeKind: 'effect-completed', retryable: false,
    })).toBe('performed');
  });

  test('control scheduling does not make completed control mutations replayable', () => {
    expect(controllerOperationReplayableAfterSettlement('turn.actor.cancel')).toBe(false);
    expect(controllerOperationReplayableAfterSettlement('turn.vm.set-default')).toBe(false);
    expect(controllerOperationReplayableAfterSettlement('turn.goal.complete')).toBe(false);
    expect(controllerOperationReplayableAfterSettlement('turn.resource.spill-result')).toBe(false);
    expect(controllerOperationReplayableAfterSettlement('turn.repository.confirm-remote')).toBe(true);
    expect(controllerOperationReplayableAfterSettlement('turn.vm.read')).toBe(true);
  });

  test('only durable workspace scripts inherit the live permission confirmation toggle', () => {
    expect(controllerOperationRequiresConfirmation(
      'turn.execution.run-script', { mode: 'act', confirmActions: true }, { workspace: true },
    )).toBe(true);
    expect(controllerOperationRequiresConfirmation(
      'turn.execution.run-script', { mode: 'act', confirmActions: true }, { workspace: false },
    )).toBe(false);
    expect(controllerOperationRequiresConfirmation(
      'turn.execution.run-script', { mode: 'act', confirmActions: false }, { workspace: true },
    )).toBe(false);
  });
});
