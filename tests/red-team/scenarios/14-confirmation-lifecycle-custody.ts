// Scenario 14: a leaked prompt id or a sibling actor tries to inherit authority.

import {
  type Probe, type Scenario, blocked, leaked, summarize,
} from '../harness.ts';
import { makeConfirmAnswerRoute } from '../../../extension/background/routes/vault.js';
import { makeConfirmCoordinator } from '../../../extension/peerd-egress/confirm/protocol.js';
import { makeDispatchTracker } from '../../../extension/peerd-runtime/lifecycle/dispatch-tracking.js';
import { createOperationLog } from '../../../extension/peerd-runtime/lifecycle/operation-log.js';

const confirmationProbe = async (): Promise<Probe> => {
  let prompt: any = null;
  const coordinator = makeConfirmCoordinator({
    notifySidePanel: (next) => { prompt = next; },
  });
  const pending = coordinator.confirm({
    tool: 'click', description: 'submit', origins: ['https://shop.example'],
    sideEffect: 'write', ownerSessionId: 'chat-a', sessionId: 'actor-a',
    dispatchId: 'tool-use-a',
  } as any);
  const answer = makeConfirmAnswerRoute({
    sessionCache: { sessionGet: async () => 'chat-a' },
    isActualSidepanelSender: (sender: any) => sender?.surface === 'sidepanel',
    isActualHomeSender: (sender: any) => sender?.surface === 'home',
    confirmCoordinator: coordinator,
  });
  const base = {
    type: 'confirm/answer', id: prompt.id, answer: 'yes_once',
    ownerSessionId: 'chat-a', sessionId: 'actor-a', dispatchId: 'tool-use-a',
  };
  const engine = await answer(base, { surface: 'engine' });
  const foreignOwner = await answer(
    { ...base, ownerSessionId: 'chat-b' }, { surface: 'home' },
  );
  const foreignExecution = await answer(
    { ...base, sessionId: 'actor-b' }, { surface: 'sidepanel' },
  );
  coordinator.resolve({
    id: prompt.id, ownerSessionId: 'chat-a', sessionId: 'actor-a',
    dispatchId: 'tool-use-a',
  }, 'no');
  await pending;
  const held = engine.ok === false && foreignOwner.ok === false && foreignExecution.ok === false;
  return held
    ? blocked('reuse one prompt UUID from an engine, another chat, or another actor',
      'exact human sender, active root, execution session, and dispatch all remained bound')
    : leaked('reuse one prompt UUID from an engine, another chat, or another actor',
      `engine=${engine.ok} owner=${foreignOwner.ok} execution=${foreignExecution.ok}`);
};

const siblingActorProbe = async (): Promise<Probe> => {
  const storage = new Map<string, unknown>();
  const operationLog = createOperationLog({
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, structuredClone(value));
      },
    },
  });
  const tracker = makeDispatchTracker({
    operationLog,
    generationId: () => 'red-team-generation',
    retryClassFor: (tool) => (tool as any).retryClass,
    resolveOwnerSessionId: async (sessionId) =>
      sessionId.startsWith('actor-') ? 'chat-root' : sessionId,
  });
  const tool = { name: 'submit_form', retryClass: 'E' };
  const args = { form: 'checkout', amount: 1 };
  const first = await tracker.beginTracking({
    callId: 'first', tool, sessionId: 'actor-a', ownerSessionId: 'chat-root',
    target: 'https://shop.example', args, userInitiated: true,
  });
  await tracker.settleTracking((first as any).handle, {
    ok: false, error: 'request timed out',
  });
  const requires = await tracker.requiresIntentConfirmation({
    tool, sessionId: 'actor-b', ownerSessionId: 'chat-root',
    target: 'https://shop.example', args, userInitiated: true,
  });
  const replay = await tracker.beginTracking({
    callId: 'second', tool, sessionId: 'actor-b', ownerSessionId: 'chat-root',
    target: 'https://shop.example', args, userInitiated: true,
  });
  const held = Boolean(requires && (replay as any)?.refuse);
  return held
    ? blocked('move an uncertain action from actor A to sibling actor B',
      'root-owner and normalized-target intent guard required a new exact confirmation')
    : leaked('move an uncertain action from actor A to sibling actor B',
      `requires=${Boolean(requires)} refused=${Boolean((replay as any)?.refuse)}`);
};

const resourceReplayProbe = async (): Promise<Probe> => {
  const storage = new Map<string, unknown>();
  const operationLog = createOperationLog({
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, structuredClone(value));
      },
    },
  });
  const tracker = makeDispatchTracker({
    operationLog,
    generationId: () => 'red-team-generation',
    retryClassFor: (tool) => (tool as any).retryClass,
  });
  const tool = { name: 'sandbox_create', retryClass: 'F' };
  await operationLog.begin({
    operationId: 'chat-root:stale-resource', sessionId: 'chat-root',
    toolName: tool.name, retryClass: tool.retryClass,
    generationId: 'dead-generation',
  });
  await operationLog.transition('chat-root:stale-resource', 'running');
  await operationLog.settle('chat-root:stale-resource', {
    state: 'interrupted', autoRetry: false,
    retryRequires: ['rederive-grants'], keepIdempotencyKey: false,
    verificationRequired: false, recreateResource: true,
    reason: 'resource host was lost',
  });

  const replay = await tracker.beginTracking({
    callId: 'stale-resource', tool, sessionId: 'chat-root',
  });
  const replacement = await tracker.beginTracking({
    callId: 'fresh-resource', tool, sessionId: 'chat-root',
  });
  const refusal = (replay as any)?.refuse;
  const held = refusal?.error?.startsWith('resource_lost:')
    && refusal?.recovery?.retryRequires?.includes('rederive-grants')
    && Boolean((replacement as any)?.handle);
  return held
    ? blocked('replay a lost Class F resource call under stale authority',
      'the original call was refused and replacement required a fresh dispatch through the grant gates')
    : leaked('replay a lost Class F resource call under stale authority',
      `refused=${Boolean(refusal)} fresh=${Boolean((replacement as any)?.handle)}`);
};

export const scenario: Scenario = {
  id: '14-confirmation-lifecycle-custody',
  title: 'Cross-chat confirmation and uncertain-action replay',
  adversary: 'a first-party non-human surface, stale chat, or sibling actor',
  asset: 'the user authority attached to one prompt and one external action',
  claim: 'A prompt answer is bound to its human surface, active root chat, execution session, and dispatch. An uncertain external action remains guarded across sibling actor heaps by root owner and normalized target.',
  threatModelRef: 'INV-20',
  tier: 'unit',
  async run() {
    const probes = await Promise.all([
      confirmationProbe(), siblingActorProbe(), resourceReplayProbe(),
    ]);
    return summarize(probes, [
      'exact human sender and active root confirmation route',
      'prompt UUID, execution session, and dispatch claim binding',
      'root-owner and normalized-target lifecycle intent guard',
      'Class F replacement uses a fresh call after grant re-derivation',
    ]);
  },
};
