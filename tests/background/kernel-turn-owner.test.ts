import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import { createKernelTurnOwner } from '../../extension/background/kernel-turn-owner.js';
import { runControllerTurn } from '../../extension/offscreen/controller-turn-runtime.js';
import { makeAgentSendCustody } from '../../extension/peerd-egress/background.js';

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

const makeSessions = () => {
  let record: any = {
    sessionId: 'root', provider: 'provider', model: 'model', depth: 0, messages: [],
  };
  const clone = () => structuredClone(record);
  return {
    get: async (id: string) => id === 'root' ? clone() : null,
    list: async () => [clone()],
    appendMessage: async (_id: string, message: any) => {
      record = { ...record, messages: [...record.messages, structuredClone(message)] };
      return clone();
    },
    updateAssistantMessage: async (_id: string, messageId: string, patch: any) => {
      record = {
        ...record,
        messages: record.messages.map((message: any) => message.id === messageId
          ? { ...message, ...structuredClone(patch) } : message),
      };
      return clone();
    },
    setTrimSummary: async (_id: string, state: any) => {
      record = { ...record, trimSummary: structuredClone(state) };
      return clone();
    },
    archive: async () => {}, update: async () => {}, snapshot: clone,
  };
};

const makeControllerFactory = (calls: Record<string, any>, turnFailure: any = null) =>
  ({ authorizeTurnCall, handleTurnKernelCall }: any) => {
    calls.controllerCreates += 1;
    return {
      callTurn: async (payload: any, options: any = {}) => {
        calls.turnCalls += 1;
        if (turnFailure) return turnFailure;
        const authority = authorizeTurnCall(payload);
        return runControllerTurn(payload, {
          signal: options.signal ?? new AbortController().signal,
          authority,
          kernelCall: (operation, value) => handleTurnKernelCall(operation, value, {
            capability: 'turn.run', authority,
            signal: options.signal ?? new AbortController().signal,
            deadlineAt: Date.now() + 60_000,
          }),
        });
      },
      callSemantic: async (payload: any) => {
        calls.semanticCalls += 1;
        return { ok: true, payload };
      },
      renderSystemPrompt: async () => 'PINNED-SYSTEM',
      withRun: async (operation: () => Promise<void>) => {
        calls.withRuns += 1;
        await operation();
      },
      close: () => { calls.controllerCloses += 1; },
    };
  };

const makeRuntime = (seams: any, calls: Record<string, any>, sessionCache = makeCache()) => {
  const sessions = makeSessions();
  const runAgentTurn = async (args: any) => {
    try {
      for await (const event of seams.runUserTurn({
        sessionId: args.sessionId ?? 'root', userText: args.userText,
        sessions, tools: [], refreshTools: async () => [],
        classifyToolCall: () => null, toolDispatch: async () => ({ ok: true }),
        getSystemPrompt: () => seams.renderSystemPrompt({ actorType: 'orchestrator' }),
        appendAudit: async () => {}, enrichTrimSummary: () => {},
        signal: new AbortController().signal, reasoning: { enabled: false },
        callModel: async function* () {
          calls.modelCalls += 1;
          yield { type: 'text-delta', text: 'sealed reply' };
          yield { type: 'message-stop', stopReason: 'end_turn' };
        },
      })) calls.events.push(event);
      return { ok: true };
    } catch (cause) {
      calls.failures.push(cause);
      calls.events.push({
        type: 'turn/error', error: cause instanceof Error ? cause.message : String(cause),
        code: (cause as any)?.code, outcomeKnown: (cause as any)?.outcomeKnown,
        ...((cause as any)?.retryable === false ? { retryable: false } : {}),
      });
      return { ok: false };
    }
  };
  const turnDeps = {
    vault: { isLocked: () => false },
    auditLog: { append: async () => {}, list: async () => [], verify: async () => ({ ok: true }) },
    sessions, sessionCache, turnSlots: { stop: () => false }, makeAgentSendCustody,
    pushState: async () => { calls.pushes += 1; }, buildToolContext: async () => ({}),
    applyComposer: async ({ text }: any) => ({ text, refs: [], command: null }),
    commandSources: { list: async () => [] },
    prepareUserAttachmentsWithDocs: async ({ text }: any) => ({ text, attachments: [] }),
    runAgentTurn, runInit: async () => {}, handleSystemCommand: async () => {},
    handleToolsCommand: async () => {}, postChatNote: () => {},
    spawnActor: async () => null, requestReview: async () => null,
    startGoalRun: async (request: any) => seams.withRun(async () => {
      calls.goals.push(request);
    }),
    haltGoalRun: async () => {}, ensureSession: async () => 'root',
    actorRecoveryReady: async () => true,
    settingsStore: { get: () => ({ auditLogMaxEntries: 100 }) },
    contextSnapshots: { snapshotsForMany: () => [], limits: () => ({}) },
    assembleDebugBundle: (value: any) => value, childSessionIdsOf: () => [],
    browser: { runtime: { getManifest: () => ({ version: '0.1.0' }) } }, CHANNEL: 'store',
  };
  return {
    turnDeps, sessionDeps: {},
    isolationDeps: {
      retryActorIsolation: async () => ({ ok: true, capability: { status: 'available' } }),
    },
    actorCount: async () => ({ activeActors: 2 }),
    actorOverview: async () => ({ roots: [{ sessionId: 'actor-root' }] }),
    sessions,
    close: () => { calls.runtimeCloses += 1; },
  };
};

const makeCalls = () => ({
  loads: 0, controllerCreates: 0, turnCalls: 0, semanticCalls: 0,
  modelCalls: 0, withRuns: 0, pushes: 0,
  controllerCloses: 0, runtimeCloses: 0,
  events: [] as any[], failures: [] as any[], goals: [] as any[],
});

describe('native kernel turn owner', () => {
  test('keeps the turn driver, model loop, and legacy worker outside its static graph', async () => {
    const graph = [...await collectStaticModuleGraph(
      EXTENSION_DIR, join(EXTENSION_DIR, 'background/kernel-turn-owner.js'),
    )].map((path) => path.slice(EXTENSION_DIR.length + 1));
    expect(graph).toContain('background/controller-turn-bridge.js');
    expect(graph).toContain('background/kernel-session-turn-routes.js');
    expect(graph).not.toContain('background/service-worker.js');
    expect(graph).not.toContain('peerd-runtime/loop/turn-driver.js');
    expect(graph).not.toContain('peerd-runtime/loop/agent-loop.js');
    expect(graph).not.toContain('offscreen/controller-turn-runtime.js');
  });

  test('loads once, drives the model loop in the sealed controller, and shares its Goal hold', async () => {
    const calls = makeCalls();
    let runtime!: ReturnType<typeof makeRuntime>;
    const owner = createKernelTurnOwner({
      createController: makeControllerFactory(calls),
      loadRuntime: async (seams) => {
        calls.loads += 1;
        runtime = makeRuntime(seams, calls);
        return runtime;
      },
      newId: (() => { let id = 0; return () => `owner-run-${++id}`; })(),
    });

    await expect(owner.routes['agent/send']({ text: 'hello' }))
      .resolves.toEqual({ ok: true });
    await until(() => runtime.sessions.snapshot().messages
      .some((message: any) => message.role === 'assistant' && message.streaming === false));
    expect(calls).toMatchObject({
      loads: 1, controllerCreates: 1, turnCalls: 1, modelCalls: 1, withRuns: 0,
    });
    expect(runtime.sessions.snapshot().messages.at(-1)).toMatchObject({
      role: 'assistant', content: 'sealed reply', streaming: false,
    });
    expect(calls.events.some((event: any) => event.type === 'stop'
      && event.stopReason === 'end_turn')).toBe(true);
    await expect(owner.controller.callSemantic({ route: 'toolbox/read' }))
      .resolves.toEqual({ ok: true, payload: { route: 'toolbox/read' } });
    expect(calls).toMatchObject({ controllerCreates: 1, semanticCalls: 1 });
    await expect(owner.getRelays()).resolves.toEqual({});
    await expect(owner.actorCount()).resolves.toEqual({ activeActors: 2 });
    await expect(owner.actorOverview()).resolves.toEqual({
      roots: [{ sessionId: 'actor-root' }],
    });

    await expect(owner.routes['agent/send']({ text: 'finish it', goal: true }))
      .resolves.toEqual({ ok: true, handled: 'goal' });
    expect(calls.withRuns).toBe(1);
    expect(calls.goals).toEqual([{ sessionId: 'root', goal: 'finish it' }]);
    expect(calls.loads).toBe(1);
    await owner.close();
    expect(calls).toMatchObject({ controllerCloses: 1, runtimeCloses: 1 });
  });

  test('a frozen turn module returns a stable pre-dispatch refusal and later becomes usable', async () => {
    const calls = makeCalls();
    const sessionCache = makeCache();
    let resolve!: (runtime: any) => void;
    const pending = new Promise<any>((done) => { resolve = done; });
    let seams: any;
    const owner = createKernelTurnOwner({
      createController: makeControllerFactory(calls), loadTimeoutMs: 2,
      loadRuntime: async (value) => { calls.loads += 1; seams = value; return pending; },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(owner.routes['agent/send']({
        text: 'not yet', operationId: `send.${Date.now().toString(36)}.frozen-runtime-00`,
        sessionId: 'root',
      })).resolves.toEqual({
        ok: false, error: 'Temporarily unavailable. Try again.',
        code: 'kernel-turn-runtime-load-timeout', outcomeKnown: true,
        phase: 'startup', retryable: true,
      });
    }
    expect(calls.loads).toBe(1);
    expect(sessionCache.values['agentSendReceipts.v1']).toBeUndefined();

    resolve(makeRuntime(seams, calls, sessionCache));
    await expect(owner.routes['actor-isolation/retry']())
      .resolves.toEqual({ ok: true, capability: { status: 'available' } });
    expect(calls.loads).toBe(1);
    await owner.close();
  });

  test('Stop tombstones a send held on first load before any model or render effect', async () => {
    const calls = makeCalls();
    let resolve!: (runtime: any) => void;
    let seams: any;
    const pendingRuntime = new Promise<any>((done) => { resolve = done; });
    const owner = createKernelTurnOwner({
      createController: makeControllerFactory(calls),
      loadRuntime: async (value) => { seams = value; return pendingRuntime; },
    });

    const send = owner.routes['agent/send']({ text: 'never dispatch' });
    await expect(owner.routes['agent/stop']()).resolves.toEqual({ ok: true });
    const runtime = makeRuntime(seams, calls);
    resolve(runtime);

    await expect(send).resolves.toEqual({
      ok: false,
      error: 'agent-send-stopped-before-dispatch',
      code: 'agent-send-stopped-before-dispatch',
      outcomeKnown: true,
      phase: 'pre-dispatch',
      retryable: false,
    });
    expect(calls).toMatchObject({ turnCalls: 0, modelCalls: 0, pushes: 0 });
    expect(runtime.sessions.snapshot().messages).toEqual([]);
    expect(calls.events).toEqual([]);
    await owner.close();
  });

  test('Stop during composer or document work fences the final model admission', async () => {
    for (const stage of ['composer', 'document'] as const) {
      const calls = makeCalls();
      let release!: () => void;
      let workStarted!: () => void;
      const started = new Promise<void>((resolve) => { workStarted = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let runtime!: ReturnType<typeof makeRuntime>;
      const owner = createKernelTurnOwner({
        createController: makeControllerFactory(calls),
        loadRuntime: async (seams) => {
          runtime = makeRuntime(seams, calls);
          if (stage === 'composer') {
            runtime.turnDeps.applyComposer = async ({ text }: any) => {
              workStarted();
              await gate;
              return { text, refs: [], command: null };
            };
          } else {
            runtime.turnDeps.prepareUserAttachmentsWithDocs = async ({ text }: any) => {
              workStarted();
              await gate;
              return { text, attachments: [] };
            };
          }
          return runtime;
        },
      });

      const send = owner.routes['agent/send']({
        text: 'never dispatch',
        operationId: `send.${Date.now().toString(36)}.${crypto.randomUUID()}`,
        sessionId: 'root',
        ...(stage === 'document' ? {
          attachments: [{ name: 'held.txt', mediaType: 'text/plain', data: 'held' }],
        } : {}),
      });
      await started;
      await expect(owner.routes['agent/stop']()).resolves.toEqual({ ok: true });
      release();

      const result = await send;
      expect(result).toMatchObject({
        code: 'agent-send-stopped-before-dispatch', outcomeKnown: true, retryable: false,
      });
      await expect(owner.routes['agent/send']({
        text: 'never dispatch', operationId: result.operationId, sessionId: 'root',
        ...(stage === 'document' ? {
          attachments: [{ name: 'held.txt', mediaType: 'text/plain', data: 'held' }],
        } : {}),
      })).resolves.toMatchObject({
        code: 'agent-send-stopped-before-dispatch', duplicate: true,
      });
      expect(calls).toMatchObject({ turnCalls: 0, modelCalls: 0 });
      expect(runtime.sessions.snapshot().messages).toEqual([]);
      expect(calls.events).toEqual([]);
      await owner.close();
    }
  });

  test('preserves an unknown host-loss shape through terminal UX without replaying the send', async () => {
    const calls = makeCalls();
    const sessionCache = makeCache();
    const owner = createKernelTurnOwner({
      createController: makeControllerFactory(calls, {
        ok: false, error: 'controller host response was lost',
        code: 'controller-turn-transport-failed', outcomeKnown: false, retryable: false,
      }),
      loadRuntime: async (seams) => makeRuntime(seams, calls, sessionCache),
    });
    const id = `send.${Date.now().toString(36)}.host-loss-0000000000`;
    const message = { text: 'one attempt', operationId: id, sessionId: 'root' };

    await expect(owner.routes['agent/send'](message))
      .resolves.toMatchObject({ ok: true, operationId: id });
    await until(() => sessionCache.values['agentSendReceipts.v1']?.[id]?.status === 'settled');
    expect(calls.failures[0]).toMatchObject({
      code: 'controller-turn-transport-failed', outcomeKnown: false, retryable: false,
    });
    expect(calls.events.at(-1)).toMatchObject({
      type: 'turn/error', code: 'controller-turn-transport-failed',
      outcomeKnown: false, retryable: false,
    });
    await expect(owner.routes['agent/send'](message))
      .resolves.toMatchObject({ ok: true, operationId: id, duplicate: true });
    expect(calls.turnCalls).toBe(1);
    await owner.close();
  });

  test('fails closed on invalid assembly and after close', async () => {
    expect(() => createKernelTurnOwner({} as any))
      .toThrow('kernel-turn-owner-config-invalid');
    const calls = makeCalls();
    const owner = createKernelTurnOwner({
      createController: makeControllerFactory(calls),
      loadRuntime: async () => ({} as any),
    });
    await expect(owner.routes['actor/spawn']({ task: 'test' })).resolves.toMatchObject({
      code: 'kernel-turn-runtime-load-failed', outcomeKnown: true, retryable: true,
    });
    await owner.close();
    await expect(owner.routes['agent/stop']()).resolves.toMatchObject({
      code: 'kernel-turn-owner-closed', outcomeKnown: true, retryable: false,
    });
  });
});
