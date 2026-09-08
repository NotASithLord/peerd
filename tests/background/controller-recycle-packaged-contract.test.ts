import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../packaging/lib.ts';
import {
  assertControllerFaultReport, CONTROLLER_FAULT_BUDGETS, selectDurableTurn,
} from '../../scripts/cdp/controller-recycle-fault.mjs';

const digest = 'a'.repeat(64);
const unknownLifecycle = (code: string) => ({
  sessionId: 'session-1',
  userMessageId: 'user-fault',
  assistant: {
    id: 'assistant-fault', content: '', streaming: false,
    error: 'Turn outcome unknown. Check the session before retrying.',
    errorCode: code, outcomeKnown: false, retryable: false,
    stopReason: null, toolUseNames: [],
  },
});
const successfulLifecycle = (content: string) => ({
  sessionId: 'session-1',
  userMessageId: 'user-retry',
  assistant: {
    id: 'assistant-retry', content, streaming: false, error: null,
    errorCode: null, outcomeKnown: null, retryable: null,
    stopReason: 'end_turn', toolUseNames: [],
  },
});
const report = () => {
  return {
    schema: 3,
    ok: true,
    bindings: {
      channel: 'store', browser: 'chrome',
      artifact: { sha256: digest, bytes: 100 },
      tree: { sha256: digest, bytes: 200, files: 10 },
      manifest: { backgroundEntry: 'background/vault-kernel-chrome.js' },
      browserIdentity: { sha256: digest },
      harness: { sha256: digest },
    },
    postRun: {
      artifact: { sha256: digest, bytes: 100 },
      tree: { sha256: digest, bytes: 200, files: 10 },
    },
    budgets: { ...CONTROLLER_FAULT_BUDGETS },
    observations: {
      baseline: { modelCalls: 1, terminal: { busy: false } },
      wholeHostLoss: {
        fault: {
          context: { contextId: 'context-old' }, host: { hostEpoch: 'host-old' },
          physicalFault: { method: 'chrome.offscreen.closeDocument', success: true },
          modelCalls: 1, audit: { toolEffects: 0 }, openedTabIds: [],
          terminal: { busy: false }, lifecycle: unknownLifecycle('controller-channel-closed'),
        },
        recovery: {
          context: { contextId: 'context-new' }, host: { hostEpoch: 'host-new' },
          modelCalls: 2, audit: { openTabEffects: 1 }, openedTabIds: [42],
          terminal: { assistants: ['controller whole host retry ok'], busy: false },
          lifecycle: successfulLifecycle('controller whole host retry ok'),
        },
      },
      postEffectHostLoss: {
        fault: {
          context: { contextId: 'context-post-effect-old' },
          host: { hostEpoch: 'host-post-effect-old' },
          physicalFault: { method: 'chrome.offscreen.closeDocument', success: true },
          modelCalls: 2,
          audit: { toolEffects: 1, openTabEffects: 1 }, openedTabIds: [43],
          terminal: { busy: false },
          lifecycle: unknownLifecycle('controller-channel-closed-post-effect'),
        },
        wake: {
          context: { contextId: 'context-post-effect-new' },
          host: { hostEpoch: 'host-post-effect-new' },
          modelCalls: 1,
          audit: { toolEffects: 0, openTabEffects: 0 }, openedTabIds: [],
          terminal: { assistants: ['controller post effect wake ok'], busy: false },
          lifecycle: successfulLifecycle('controller post effect wake ok'),
          faultLifecycleAfterWake: unknownLifecycle('controller-channel-closed-post-effect'),
        },
      },
      totalCompletionCalls: 7,
    },
  };
};

describe('packaged Chrome controller physical fault contract', () => {
  test('re-reads the original fault settlement by message identity after a later wake', () => {
    const messages = [
      { id: 'user-fault', role: 'user', content: 'fault turn' },
      { id: 'tool-call', role: 'assistant', content: '', toolUses: [{ id: 'tool-1' }] },
      { id: 'tool-result', role: 'user', content: '', toolResults: [{ tool_use_id: 'tool-1' }] },
      { id: 'assistant-fault', role: 'assistant', error: 'unknown' },
      { id: 'user-wake', role: 'user', content: 'wake turn' },
      { id: 'assistant-wake', role: 'assistant', content: 'wake ok' },
    ];

    expect(selectDurableTurn(messages, 'fault turn', 'assistant-fault')).toEqual({
      user: messages[0], assistant: messages[3],
    });
    expect(selectDurableTurn(messages, 'fault turn', 'missing')).toBeNull();
  });

  test('requires pre-effect and post-effect host loss with explicit non-replaying recovery', () => {
    expect(assertControllerFaultReport(report())).toBeTruthy();
    for (const mutate of [
      (value: any) => { value.bindings.channel = 'preview'; },
      (value: any) => { value.bindings.manifest.backgroundEntry = ''; },
      (value: any) => { value.observations.wholeHostLoss.fault.lifecycle.assistant.outcomeKnown = true; },
      (value: any) => { value.observations.wholeHostLoss.fault.lifecycle.assistant.retryable = true; },
      (value: any) => { value.observations.wholeHostLoss.fault.openedTabIds = [99]; },
      (value: any) => { value.observations.wholeHostLoss.recovery.context.contextId = 'context-old'; },
      (value: any) => { value.observations.wholeHostLoss.recovery.host.hostEpoch = 'host-old'; },
      (value: any) => { value.observations.postEffectHostLoss.fault.audit.toolEffects = 2; },
      (value: any) => { value.observations.postEffectHostLoss.fault.lifecycle.assistant.outcomeKnown = true; },
      (value: any) => { value.observations.postEffectHostLoss.wake.audit.openTabEffects = 1; },
      (value: any) => { value.observations.postEffectHostLoss.wake.openedTabIds = [44]; },
      (value: any) => { value.observations.postEffectHostLoss.wake.faultLifecycleAfterWake.assistant.retryable = true; },
      (value: any) => { value.observations.totalCompletionCalls = 8; },
      (value: any) => { value.postRun.tree.sha256 = 'b'.repeat(64); },
      (value: any) => { value.budgets.retryMs += 1; },
    ]) {
      const candidate = structuredClone(report());
      mutate(candidate);
      expect(() => assertControllerFaultReport(candidate)).toThrow();
    }
  });

  test('uses the exact physical browser fault Chrome supports without a production test hook', () => {
    const source = readFileSync(join(
      REPO_ROOT, 'scripts', 'cdp', 'controller-recycle-fault.mjs',
    ), 'utf8');
    expect(source).toContain("channel: 'store', browser: 'chrome'");
    expect(source).toContain('expectedBackgroundEntry: PRODUCTION_BACKGROUND_ENTRY');
    expect(source).toContain("contextTypes: ['OFFSCREEN_DOCUMENT']");
    expect(source).toContain("endsWith('/offscreen/offscreen.html')");
    expect(source).toContain('chrome.offscreen.closeDocument()');
    expect(source).toContain('completionResponse: async');
    expect(source).toContain('post-effect fault did not reach exactly one performed open_tab');
    expect(source).toContain('faultLifecycleAfterWake');
    expect(source).toContain("type: 'session/get'");
    expect(source).toContain("type: 'audit/list'");
    expect(source).toContain("readActiveFeatureLease(page, 'controller')");
    expect(source).not.toContain('Target.closeTarget');
    expect(source).not.toContain('workerOnlyLoss');
    expect(source).not.toContain('controller/test');
    expect(source).not.toContain('fault-injection');
  });
});
