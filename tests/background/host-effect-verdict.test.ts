import { describe, expect, test } from 'bun:test';
import {
  HOST_EFFECT_OUTCOME,
  hostEffectValueIsRefusal,
  stampAuthorityToolResult,
  stampAuthorityToolResultBlock,
} from '../../extension/background/host-effect-verdict.js';
import {
  controllerOperationReplayableAfterSettlement, controllerOperationRequiresConfirmation,
} from '../../extension/shared/controller-kernel-quota.js';

describe('exact host effect verdicts', () => {
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
