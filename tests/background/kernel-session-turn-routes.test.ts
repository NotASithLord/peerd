import { describe, expect, test } from 'bun:test';
import {
  KERNEL_SESSION_TURN_ROUTE_NAMES,
  makeKernelSessionTurnRoutes,
} from '../../extension/background/kernel-session-turn-routes.js';
import { makeAgentSendCustody } from '../../extension/peerd-egress/background.js';

class SessionNotFoundError extends Error {}

const EXPECTED_ROUTES = [
  'agent/send', 'agent/stop', 'actor/spawn', 'session/debugBundle',
  'session/archive', 'session/reset', 'session/switch', 'actor-isolation/retry',
];

const operationId = (suffix: string) =>
  `send.${Date.now().toString(36)}.${suffix.padEnd(20, '0')}`;

const until = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition-not-met');
};

const makeCache = () => {
  const values: Record<string, any> = { currentSessionId: 'root' };
  return {
    values,
    sessionGet: async (key: string) => structuredClone(values[key]),
    sessionSet: async (key: string, value: any) => { values[key] = structuredClone(value); },
    sessionDelete: async (key: string) => { delete values[key]; },
  };
};

const harness = ({
  sessionCache = makeCache(), turn = {}, session = {}, isolation = {},
}: Record<string, any> = {}) => {
  const calls: Record<string, any> = {
    sequence: [], turns: [], stopped: [], halted: [], actors: [], pushes: 0,
  };
  const auditLog = {
    append: async () => {}, list: async () => [], verify: async () => ({ ok: true }),
  };
  const sessions = {
    get: async (id: string) => id === 'root' || id === 'next'
      ? { sessionId: id, depth: 2, messages: [] } : null,
    list: async () => [{ sessionId: 'root', depth: 0, messages: [] }],
    archive: async () => {},
    update: async () => {},
  };
  const pushState = async () => {
    calls.pushes += 1;
    calls.sequence.push('push');
  };
  const turnDeps = {
    vault: { isLocked: () => false }, auditLog, sessions, sessionCache,
    turnSlots: {
      stop: (sessionId: string) => { calls.stopped.push(sessionId); return true; },
    },
    makeAgentSendCustody, pushState,
    buildToolContext: async () => ({}),
    applyComposer: async ({ text }: any) => ({ text, refs: [], command: null }),
    commandSources: { list: async () => [] },
    prepareUserAttachmentsWithDocs: async ({ text }: any) => ({ text, attachments: [] }),
    runAgentTurn: (input: any) => { calls.turns.push(input); return Promise.resolve(); },
    runInit: async () => {}, handleSystemCommand: async () => {},
    handleToolsCommand: async () => {}, postChatNote: () => {},
    spawnActor: async (input: any) => { calls.actors.push(input); return 'actor-result'; },
    requestReview: async () => 'review-result',
    startGoalRun: async (input: any) => { calls.sequence.push('goal'); calls.goal = input; },
    haltGoalRun: async (id: string) => { calls.halted.push(id); },
    ensureSession: async () => 'root', actorRecoveryReady: async () => true,
    actorMessaging: { stopActorsFor: () => ['bound-actor'] },
    actorLifecycle: { stopSubtree: () => ['child-actor'] },
    settingsStore: { get: () => ({ auditLogMaxEntries: 100 }) },
    contextSnapshots: {
      snapshotsForMany: () => [], limits: () => ({}),
    },
    assembleDebugBundle: (input: any) => input,
    childSessionIdsOf: () => [], CHANNEL: 'store',
    browser: { runtime: { getManifest: () => ({ version: '0.1.0' }) } },
    ...turn,
  };
  const sessionDeps = {
    vault: turnDeps.vault, auditLog, pushState, sessions, sessionCache,
    autoMemory: { maybeExtract: async () => {} },
    resolvePermission: async () => ({ mode: 'act', confirmActions: false }),
    normalizeMode: (mode: unknown) => mode, normalizeConfirmActions: Boolean,
    SessionNotFoundError, maybeAutoResumeAfterRecovery: () => {},
    haltGoalRun: turnDeps.haltGoalRun, turnSlots: turnDeps.turnSlots,
    actorMessaging: turnDeps.actorMessaging, nukeSessionWorkspace: async () => {},
    purgeLifecycleSession: async () => {},
    ...session,
  };
  const isolationDeps = {
    retryActorIsolation: async () => ({ ok: true, capability: { status: 'available' } }),
    ...isolation,
  };
  return {
    calls, sessionCache,
    routes: makeKernelSessionTurnRoutes({ turnDeps, sessionDeps, isolationDeps }),
  };
};

describe('native kernel session and turn route boundary', () => {
  test('owns only the requested handlers and preserves actor/isolation results', async () => {
    const { calls, routes } = harness();
    expect([...KERNEL_SESSION_TURN_ROUTE_NAMES]).toEqual(EXPECTED_ROUTES);
    expect(Object.keys(routes)).toEqual(EXPECTED_ROUTES);
    expect(Object.isFrozen(routes)).toBe(true);
    for (const route of [
      'session/list', 'session/get', 'session/contextSnapshots',
      'session/setModel', 'permission/set',
    ]) expect((routes as any)[route]).toBeUndefined();
    expect((routes as any)['transfer/import']).toBeUndefined();

    await expect(routes['actor/spawn']({ task: 'inspect' }))
      .resolves.toEqual({ ok: true, result: 'actor-result' });
    await expect(routes['actor-isolation/retry']())
      .resolves.toEqual({ ok: true, capability: { status: 'available' } });
    await expect(routes['session/debugBundle']({ sessionId: 'root' }))
      .resolves.toMatchObject({ ok: true, bundle: { session: { sessionId: 'root' } } });
    expect(calls.actors[0]).toMatchObject({ task: 'inspect', parentSessionId: 'root', parentDepth: 2 });
    expect(calls.pushes).toBe(0);
  });

  test('keeps accepted sends unknown after host loss and never replays the model turn', async () => {
    const sessionCache = makeCache();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const firstTurns: any[] = [];
    const first = harness({
      sessionCache,
      turn: { runAgentTurn: (input: any) => { firstTurns.push(input); return pending; } },
    });
    const id = operationId('kernel-loss');
    const message = { text: 'do it once', operationId: id, sessionId: 'root' };

    await expect(first.routes['agent/send'](message))
      .resolves.toMatchObject({ ok: true, operationId: id });
    expect(firstTurns).toHaveLength(1);
    expect(sessionCache.values['agentSendReceipts.v1'][id].status).toBe('accepted');

    const successor = harness({ sessionCache });
    await expect(successor.routes['agent/send'](message)).resolves.toMatchObject({
      ok: false, operationId: id, outcomeKnown: false, retryable: false,
    });
    expect(successor.calls.turns).toEqual([]);

    release();
    await until(() => sessionCache.values['agentSendReceipts.v1'][id].status === 'settled');
    await expect(successor.routes['agent/send']({
      checkOnly: true, operationId: id, sessionId: 'root',
    })).resolves.toMatchObject({ ok: true, operationId: id, duplicate: true });
  });

  test('keeps Goal publication ordering and Stop custody exact', async () => {
    const { calls, routes } = harness();
    await expect(routes['agent/send']({ text: 'finish this', goal: true }))
      .resolves.toEqual({ ok: true, handled: 'goal' });
    expect(calls.sequence).toEqual(['push', 'goal']);
    expect(calls.goal).toEqual({ sessionId: 'root', goal: 'finish this' });
    expect(calls.turns).toEqual([]);

    await expect(routes['agent/stop']()).resolves.toEqual({ ok: true });
    expect(calls.halted).toEqual(['root']);
    expect(calls.stopped).toEqual(['root', 'bound-actor']);
    expect(calls.pushes).toBe(1);
  });

  test('keeps one state projection per archive, reset, and switch', async () => {
    for (const [name, message] of [
      ['session/archive', { sessionId: 'root' }],
      ['session/reset', {}],
      ['session/switch', { sessionId: 'next' }],
    ] as const) {
      const { calls, routes } = harness();
      await expect(routes[name](message)).resolves.toEqual({ ok: true });
      expect(calls.pushes).toBe(1);
    }
  });
});
