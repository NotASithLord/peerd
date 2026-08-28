import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import { createKernelTurnOwner } from '../../extension/background/kernel-turn-owner.js';
import { runControllerTurn } from '../../extension/offscreen/controller-turn-runtime.js';
import { makeAgentSendCustody } from '../../extension/peerd-egress/background.js';
import { makeScriptedProviderAuthority } from '../peerd-provider/model-egress-fixture';

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
    sessionId: 'root', provider: 'anthropic', model: 'claude-sonnet-4-6',
    depth: 0, messages: [],
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
      renderSystemPrompt: async () => 'PINNED-SYSTEM',
      projectTurnTools: async () => ({ tools: [], operations: [] }),
      planToolsCommand: async () => ({ action: 'note', note: 'planned' }),
      composeTurn: async ({ text }: any) => ({
        text, command: null, commandFound: false, refs: [],
      }),
      withRun: async (operation: () => Promise<void>) => {
        calls.withRuns += 1;
        await operation();
      },
      release: () => { calls.controllerCloses += 1; },
    };
  };

const makeRuntime = (seams: any, calls: Record<string, any>, sessionCache = makeCache()) => {
  const sessions = makeSessions();
  const runAgentTurn = async (args: any) => {
    try {
      for await (const event of seams.runUserTurn({
        sessionId: args.sessionId ?? 'root', userText: args.userText,
        sessions, tools: [], allowedOperations: [], refreshTools: async () => ({
          tools: [], operations: [],
        }),
        classifyToolCall: () => null, toolDispatch: async () => ({ ok: true }),
        getSystemPrompt: () => seams.renderSystemPrompt({ actorType: 'orchestrator' }),
        appendAudit: async () => {}, enrichTrimSummary: () => {},
        signal: new AbortController().signal, reasoning: { enabled: false },
        previousTurnAt: null, turnNow: 1_700_000_000_000,
        activeTabContext: null, protectedTabContext: null, recoveryBlock: '',
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
    spawnActor: async () => null,
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
  loads: 0, controllerCreates: 0, turnCalls: 0,
  modelCalls: 0, withRuns: 0, pushes: 0,
  controllerCloses: 0, runtimeCloses: 0,
  events: [] as any[], failures: [] as any[], goals: [] as any[],
});

const providerAuthorityFor = (calls: Record<string, any>) =>
  makeScriptedProviderAuthority(() => async function* () {
    calls.modelCalls += 1;
    yield { type: 'text-delta', text: 'sealed reply' };
    yield { type: 'message-stop', stopReason: 'end_turn' };
  }) as any;

describe('native kernel turn owner', () => {
  test('keeps the semantic driver, model loop, and legacy worker outside its static graph', async () => {
    const graph = [...await collectStaticModuleGraph(
      EXTENSION_DIR, join(EXTENSION_DIR, 'background/kernel-turn-owner.js'),
    )].map((path) => path.slice(EXTENSION_DIR.length + 1));
    expect(graph).toContain('background/controller-turn-bridge.js');
    expect(graph).toContain('background/kernel-session-turn-routes.js');
    expect(graph).not.toContain('background/service-worker.js');
    expect(graph).not.toContain('peerd-runtime/loop/turn-driver.js');
    expect(graph).toContain('peerd-runtime/loop/turn-authority-driver.js');
    expect(graph).not.toContain('peerd-runtime/loop/agent-loop.js');
    expect(graph).not.toContain('offscreen/controller-turn-runtime.js');
  });

  test('loads once, drives the model loop in the sealed controller, and shares its Goal hold', async () => {
    const calls = makeCalls();
    let runtime!: ReturnType<typeof makeRuntime>;
    const owner = createKernelTurnOwner({
      createController: makeControllerFactory(calls),
      providerEgress: providerAuthorityFor(calls),
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

  test('publishes relays only after the current handoff reconciles', async () => {
    const calls = makeCalls();
    let releaseReconcile!: () => void;
    let reconcileStarted!: () => void;
    const reconciling = new Promise<void>((resolve) => { reconcileStarted = resolve; });
    const reconcileGate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
    const events: string[] = [];
    let owner!: ReturnType<typeof createKernelTurnOwner>;
    owner = createKernelTurnOwner({
      createController: makeControllerFactory(calls),
      loadRuntime: async (seams) => ({
        ...makeRuntime(seams, calls),
        relays: {
          eventOwners: {
            reconcile: async () => {
              events.push('snapshot');
              reconcileStarted();
              await reconcileGate;
            },
            tabsOnUpdated: async () => { events.push('tab'); },
          },
        },
      }),
      onLoaded: async (runtime) => runtime.relays.eventOwners.reconcile(),
    });

    const count = owner.actorCount();
    const overview = owner.actorOverview();
    await reconciling;
    expect(owner.relays).toBeNull();
    releaseReconcile();

    await expect(count).resolves.toEqual({ activeActors: 2 });
    await expect(overview).resolves.toEqual({ roots: [{ sessionId: 'actor-root' }] });
    await owner.relays?.eventOwners.tabsOnUpdated();
    expect(events).toEqual(['snapshot', 'tab']);
    await owner.close();
  });

  test('discards a failed handoff exactly once and retries with a fresh runtime', async () => {
    const calls = makeCalls();
    const closes: number[] = [];
    let attempts = 0;
    const owner = createKernelTurnOwner({
      createController: makeControllerFactory(calls),
      loadRuntime: async (seams) => {
        attempts += 1;
        const runtime = makeRuntime(seams, calls);
        return {
          ...runtime,
          close: () => { closes.push(attempts); },
        };
      },
      onLoaded: async () => {
        if (attempts === 1) throw new Error('reconcile-failed');
      },
    });

    await expect(owner.actorCount()).resolves.toMatchObject({
      code: 'kernel-turn-runtime-load-failed', outcomeKnown: true, retryable: true,
    });
    expect(owner.relays).toBeNull();
    await expect(owner.actorCount()).resolves.toEqual({ activeActors: 2 });
    expect(attempts).toBe(2);
    expect(closes).toEqual([1]);

    await owner.close();
    expect(closes).toEqual([1, 2]);
  });

  test('close during a held handoff closes once and prevents post-close dispatch', async () => {
    const calls = makeCalls();
    let handoffStarted!: () => void;
    const handoff = new Promise<void>((resolve) => { handoffStarted = resolve; });
    let dispatches = 0;
    const owner = createKernelTurnOwner({
      createController: makeControllerFactory(calls),
      loadRuntime: async (seams) => {
        const runtime = makeRuntime(seams, calls);
        runtime.isolationDeps.retryActorIsolation = async () => {
          dispatches += 1;
          return { ok: true, capability: { status: 'available' } };
        };
        return runtime;
      },
      onLoaded: async () => {
        handoffStarted();
        await new Promise(() => {});
      },
    });

    const request = owner.routes['actor-isolation/retry']();
    await handoff;
    await owner.close();

    await expect(request).resolves.toMatchObject({
      code: 'kernel-turn-owner-closed', outcomeKnown: true, retryable: false,
    });
    expect(dispatches).toBe(0);
    expect(calls).toMatchObject({ runtimeCloses: 1, controllerCloses: 1 });
  });

  test('retires a timed-out handoff and retries fresh without waiting for cleanup', async () => {
    const calls = makeCalls();
    let releaseFirst!: () => void;
    const firstHandoff = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const closes: number[] = [];
    let attempts = 0;
    const owner = createKernelTurnOwner({
      createController: makeControllerFactory(calls), loadTimeoutMs: 2,
      loadRuntime: async (seams) => {
        attempts += 1;
        const attempt = attempts;
        return {
          ...makeRuntime(seams, calls),
          relays: { attempt },
          close: () => {
            closes.push(attempt);
            return attempt === 1 ? new Promise<void>(() => {}) : undefined;
          },
        };
      },
      onLoaded: async (runtime) => {
        if (runtime.relays.attempt === 1) await firstHandoff;
      },
    });

    const timedOutCount = owner.actorCount();
    const timedOutOverview = owner.actorOverview();
    await expect(timedOutCount).resolves.toMatchObject({
      code: 'kernel-turn-runtime-load-timeout', outcomeKnown: true, retryable: true,
    });
    await expect(timedOutOverview).resolves.toMatchObject({
      code: 'kernel-turn-runtime-load-timeout', outcomeKnown: true, retryable: true,
    });
    expect(owner.relays).toBeNull();
    expect(closes).toEqual([1]);

    await expect(owner.actorCount()).resolves.toEqual({ activeActors: 2 });
    expect(owner.relays).toEqual({ attempt: 2 });
    releaseFirst();
    await Promise.resolve();
    expect(owner.relays).toEqual({ attempt: 2 });

    await owner.close();
    expect(owner.relays).toBeNull();
    expect(closes).toEqual([1, 2]);
    expect(calls.controllerCloses).toBe(1);
  }, 1_000);

  test('a frozen turn module returns a stable pre-dispatch refusal and later becomes usable', async () => {
    const calls = makeCalls();
    const sessionCache = makeCache();
    let resolve!: (runtime: any) => void;
    const pending = new Promise<any>((done) => { resolve = done; });
    let firstSeams: any;
    const owner = createKernelTurnOwner({
      createController: makeControllerFactory(calls), loadTimeoutMs: 2,
      loadRuntime: async (seams) => {
        calls.loads += 1;
        if (calls.loads === 1) {
          firstSeams = seams;
          return pending;
        }
        return makeRuntime(seams, calls, sessionCache);
      },
    });

    await expect(owner.routes['agent/send']({
      text: 'not yet', operationId: `send.${Date.now().toString(36)}.frozen-runtime-00`,
      sessionId: 'root',
    })).resolves.toEqual({
      ok: false, error: 'Temporarily unavailable. Try again.',
      code: 'kernel-turn-runtime-load-timeout', outcomeKnown: true,
      phase: 'startup', retryable: true,
    });
    expect(sessionCache.values['agentSendReceipts.v1']).toBeUndefined();

    await expect(owner.routes['actor-isolation/retry']())
      .resolves.toEqual({ ok: true, capability: { status: 'available' } });
    expect(calls.loads).toBe(2);
    resolve(makeRuntime(firstSeams, calls, sessionCache));
    await until(() => calls.runtimeCloses === 1);
    expect(calls.loads).toBe(2);
    await owner.close();
    expect(calls.runtimeCloses).toBe(2);
  });

  test('never adopts one runtime object across timeout generations', async () => {
    const calls = makeCalls();
    let resolve!: (runtime: any) => void;
    const shared = new Promise<any>((done) => { resolve = done; });
    let loads = 0;
    const owner = createKernelTurnOwner({
      createController: makeControllerFactory(calls), loadTimeoutMs: 10,
      loadRuntime: async (seams) => {
        loads += 1;
        return loads < 3 ? shared : makeRuntime(seams, calls);
      },
    });
    await expect(owner.actorCount()).resolves.toMatchObject({
      code: 'kernel-turn-runtime-load-timeout', outcomeKnown: true,
    });
    const second = owner.actorCount();
    await until(() => loads === 2);
    resolve(makeRuntime({}, calls));
    await expect(second).resolves.toMatchObject({
      code: 'kernel-turn-runtime-load-failed', outcomeKnown: true,
    });
    await expect(owner.actorCount()).resolves.toEqual({ activeActors: 2 });
    expect(loads).toBe(3);
    expect(calls.runtimeCloses).toBe(1);
    await owner.close();
    expect(calls.runtimeCloses).toBe(2);
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
    expect(() => createKernelTurnOwner({
      createController: () => ({
        callTurn: async () => ({ ok: true }),
        renderSystemPrompt: async () => '',
        withRun: async (operation: () => Promise<any>) => operation(),
      } as any),
      loadRuntime: async () => ({} as any),
    })).toThrow('kernel-turn-controller-invalid');
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
