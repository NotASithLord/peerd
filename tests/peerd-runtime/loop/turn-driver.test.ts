// turn-driver — the agent turn driver extracted from the service worker.
// These tests exist BECAUSE of the extraction: maybeAutoResume's guard logic
// was previously unreachable without a real browser (it lived inline in the SW
// closure). Now it's a factory of injected deps, so the early-return gates can
// be exercised with fakes — values in, behavior out.
//
// We test only the guard paths that bail BEFORE runAgentTurn (setting off,
// no session, vault locked, session busy, not-resumable); the resume path
// itself drives a full turn and belongs to the e2e harness.

import { describe, test, expect } from 'bun:test';
import { inboundActorCallAllowed, makeTurnDriver } from '/peerd-runtime/loop/turn-driver.js';
import { ACTOR_CREDENTIAL_BOUNDARY_FAILURE } from '/peerd-runtime/errors.js';

/** Minimal deps maybeAutoResume touches; the rest stay undefined (never invoked). */
const deps = (/** @type {any} */ over: any = {}) => ({
  settingsStore: { get: () => ({ autoResumeInterruptedTurns: true }) },
  vault: { isLocked: () => false },
  turnSlots: { isBusy: () => false },
  sessions: { get: async () => ({ sessionId: 's1' }) },
  detectInterruptedTurn: () => ({ resumable: false }),
  auditLog: { append: async () => {} },
  postChatNote: () => {},
  ...over,
});

test('makeTurnDriver returns the two entry points', () => {
  const d = makeTurnDriver(deps());
  expect(typeof d.runAgentTurn).toBe('function');
  expect(typeof d.maybeAutoResume).toBe('function');
});

test('the inbound dweb policy rejects forged hidden/signing tool calls', () => {
  expect(inboundActorCallAllowed({
    isActor: true, inbound: true, actorType: 'dweb', name: 'dweb_peers',
  })).toBe(true);
  for (const name of ['a2a_run', 'dweb_share', 'dweb_install', 'message_actor']) {
    expect(inboundActorCallAllowed({
      isActor: true, inbound: true, actorType: 'dweb', name,
    })).toBe(false);
  }
  // The rule is specific to untrusted daemon wakes; ordinary actor turns keep
  // their existing kind/grant gates.
  expect(inboundActorCallAllowed({
    isActor: true, inbound: false, actorType: 'dweb', name: 'a2a_run',
  })).toBe(true);
});

test('maybeAutoResume no-ops when the setting is off (never reads the session)', async () => {
  let read = false;
  const d = makeTurnDriver(deps({
    settingsStore: { get: () => ({ autoResumeInterruptedTurns: false }) },
    sessions: { get: async () => { read = true; return {}; } },
  }));
  await d.maybeAutoResume('s1');
  expect(read).toBe(false);
});

test('maybeAutoResume no-ops on a null sessionId', async () => {
  let read = false;
  const d = makeTurnDriver(deps({ sessions: { get: async () => { read = true; return {}; } } }));
  await d.maybeAutoResume(null);
  expect(read).toBe(false);
});

test('maybeAutoResume no-ops when the vault is locked', async () => {
  let read = false;
  const d = makeTurnDriver(deps({
    vault: { isLocked: () => true },
    sessions: { get: async () => { read = true; return {}; } },
  }));
  await d.maybeAutoResume('s1');
  expect(read).toBe(false);
});

test('maybeAutoResume no-ops when the session is already streaming', async () => {
  let read = false;
  const d = makeTurnDriver(deps({
    turnSlots: { isBusy: () => true },
    sessions: { get: async () => { read = true; return {}; } },
  }));
  await d.maybeAutoResume('s1');
  expect(read).toBe(false);
});

test('maybeAutoResume no-ops when a Goal run owns the session (no double-drive)', async () => {
  let read = false;
  const d = makeTurnDriver(deps({
    // The goal loop re-drives its own interrupted turn on resume; auto-resume
    // must bail BEFORE reading the session so the two can't contend the slot.
    goalActiveFor: (sid: string) => sid === 's1',
    sessions: { get: async () => { read = true; return {}; } },
  }));
  await d.maybeAutoResume('s1');
  expect(read).toBe(false);
});

test('maybeAutoResume does not resume a turn that is not resumable', async () => {
  let noted = false;
  const d = makeTurnDriver(deps({
    detectInterruptedTurn: () => ({ resumable: false }),
    postChatNote: () => { noted = true; },
  }));
  await d.maybeAutoResume('s1');
  // The "Resuming…" note fires only on the resume path — its absence proves
  // the guard bailed before runAgentTurn was entered.
  expect(noted).toBe(false);
});

const turnDeps = (kind: 'chat' | 'actor' | 'spawned', {
  failover = false, boundaryFailure = false, streamBoundaryFailure = false,
  waitForAbort = false, abortDuringFallback = false, uiDisconnected = false,
  waitForActorIsolation = async () => {},
} = {}) => {
  const liveGetSecret = async () => 'sk-live';
  const liveSafeFetch = async () => new Response('ok');
  const rogueGetSecret = async () => 'sk-rogue';
  const rogueSafeFetch = async () => new Response('rogue');
  const rogueSignal = new AbortController().signal;
  const turnAbortController = new AbortController();
  const session = {
    sessionId: 's1', kind, provider: 'anthropic', model: 'claude-test',
    messages: [],
    ...(kind === 'actor' ? { actorType: 'web', instanceId: 'web' } : {}),
  };
  let loopCtx: any = null;
  let toolContextArgs: any = null;
  const modelCalls: any[] = [];
  const modelKeyReads: string[] = [];
  const recordedModelCalls: any[] = [];
  const broadcasts: any[] = [];
  const chatNotes: string[] = [];
  let lateProviderContinuation = 0;
  const audits: any[] = [];
  let releases = 0;
  const settings = {
    reasoningEnabled: false,
    reasoningEffort: 'medium',
    pricingOverrides: {},
    contextWindowOverrides: {},
    spendLimitUsd: 0,
    ollamaHost: 'http://127.0.0.1:11434',
    dwebEnabled: false,
  };
  const identity = (value: any) => value;
  const driver = makeTurnDriver({
    vault: { isLocked: () => false },
    sessionCache: {
      sessionGet: async (key: string) => key === 'currentSessionId' ? 's1' : null,
      sessionSet: async () => {},
    },
    sessions: {
      get: async () => session,
      setCost: async () => {},
    },
    sessionState: { set: () => {} },
    turnSlots: {
      claim: () => ({ controller: turnAbortController, release: () => { releases++; } }),
      isBusy: () => false,
    },
    buildTemporalBlock: () => '',
    memory: { loadAlwaysLoaded: async () => ({ text: '' }) },
    browser: { tabs: { query: async () => [] } },
    originOfTabUrl: () => '',
    skillRegistry: { describeForPrompt: async () => '' },
    renderSystemPrompt: async () => 'system',
    resolveManifestAllow: () => null,
    buildToolContext: async (args: any) => {
      toolContextArgs = args;
      return { permission: {}, actorSurface: 'tools', schemaReply: false };
    },
    filterByDwebActive: identity,
    filterByDwebEnabled: identity,
    filterDescriptorsByManifest: identity,
    mainAgentDescriptors: identity,
    listTools: () => [],
    settingsStore: { get: () => settings },
    DWEB_ENABLED: false,
    filterByGoalActive: identity,
    goalActiveFor: () => false,
    dwebEngagedSessions: new Set(),
    markDwebEngaged: () => {},
    dispatchToolCall: async () => ({ ok: true }),
    maybeNudgeDebuggerGrant: () => {},
    getTool: () => null,
    decideAction: () => null,
    listProviders: () => [],
    costOf: () => ({ usd: 0, known: true }),
    makeTurnCostTracker: () => ({ onUsage: async () => {}, maybeHalt: () => {} }),
    uiConnected: () => !uiDisconnected && (boundaryFailure || streamBoundaryFailure),
    uiPorts: { broadcast: (message: any) => broadcasts.push(message) },
    auditLog: { append: async (entry: any) => { audits.push(entry); } },
    postChatNote: (note: string) => { chatNotes.push(note); },
    resolveFailoverChain: (start: any) => abortDuringFallback
      ? [
        start,
        { provider: 'openrouter', model: 'fallback-model' },
        { provider: 'openai', model: 'last-fallback-model' },
      ]
      : failover ? [start, { provider: 'openrouter', model: 'fallback-model' }]
      : [start],
    shouldFailover: () => failover || abortDuringFallback,
    recordModelCall: (call: any) => recordedModelCalls.push(call),
    callModel: async function* (args: any) {
      modelCalls.push(args);
      if (abortDuringFallback) {
        modelKeyReads.push(args.provider);
        await args.getSecret(args.provider);
        if (args.provider === 'anthropic') throw new Error('primary overloaded');
        if (args.provider === 'openrouter') {
          await new Promise((resolve) => args.signal.addEventListener('abort', resolve, { once: true }));
          throw new DOMException('Aborted', 'AbortError');
        }
      }
      if (failover && args.provider === 'anthropic') throw new Error('primary overloaded');
      if (waitForAbort) {
        await new Promise((resolve) => {
          args.signal.addEventListener('abort', resolve, { once: true });
          setTimeout(resolve, 25);
        });
        if (args.signal.aborted) return;
        lateProviderContinuation += 1;
      }
      yield { type: 'message-stop', stopReason: 'end_turn' };
    },
    runUserTurn: async function* (ctx: any) {
      loopCtx = ctx;
      if (boundaryFailure) {
        await ctx.safeFetch('https://provider.invalid');
        return;
      }
      if (streamBoundaryFailure) {
        yield {
          type: 'error', sessionId: 's1', messageId: 'assistant-1',
          error: ACTOR_CREDENTIAL_BOUNDARY_FAILURE,
        };
        yield { type: 'stop', sessionId: 's1', stopReason: undefined };
        return;
      }
      for await (const _ of ctx.callModel({
        provider: 'rogue-provider',
        model: 'rogue-model',
        messages: [],
        ollamaHost: 'https://rogue.invalid',
        signal: rogueSignal,
        getSecret: rogueGetSecret,
        safeFetch: rogueSafeFetch,
      })) { /* drain */ }
      yield { type: 'stop', sessionId: 's1', stopReason: 'end_turn' };
    },
    getSecret: liveGetSecret,
    safeFetch: liveSafeFetch,
    REASONING_BUDGET_TOKENS: 0,
    REASONING_EFFORT_LEVELS: ['medium'],
    DEFAULT_SETTINGS: { reasoningEffort: 'medium' },
    trimEnricher: { queue: () => {}, drain: async () => {} },
    contextWindowFor: () => null,
    liveContextWindow: () => null,
    currentAppScope: async () => null,
    checkpointMgr: { capture: async () => {} },
    detectInterruptedTurn: () => ({ resumable: false }),
    waitForActorIsolation,
  });
  return {
    driver, modelCalls, modelKeyReads, broadcasts, chatNotes, turnAbortController,
    recordedModelCalls,
    liveGetSecret, liveSafeFetch,
    rogueGetSecret, rogueSafeFetch, rogueSignal,
    audits,
    releases: () => releases,
    loopCtx: () => loopCtx,
    toolContextArgs: () => toolContextArgs,
    lateProviderContinuation: () => lateProviderContinuation,
  };
};

describe('runAgentTurn credential custody', () => {
  test('a turn cannot snapshot actor isolation before durable host health is ready', async () => {
    let releaseReady = () => {};
    const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
    const fixture = turnDeps('chat', { waitForActorIsolation: () => ready });
    const running = fixture.driver.runAgentTurn({ sessionId: 's1', userText: 'hello' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.modelCalls).toEqual([]);
    expect(fixture.toolContextArgs()).toBeNull();
    releaseReady();
    await running;
    expect(fixture.modelCalls).toHaveLength(1);
  });

  test('a bound actor session is refused before the background loop, tools, or model', async () => {
    const fixture = turnDeps('actor');
    expect(await fixture.driver.runAgentTurn({ sessionId: 's1', userText: 'inspect the page' }))
      .toBeUndefined();

    expect(fixture.loopCtx()).toBeNull();
    expect(fixture.toolContextArgs()).toBeNull();
    expect(fixture.modelCalls).toEqual([]);
    expect(fixture.recordedModelCalls).toEqual([]);
    expect(fixture.releases()).toBe(1);
    expect(fixture.audits).toContainEqual({
      type: 'actor_background_turn_refused',
      sessionId: 's1',
      details: { reason: 'dedicated_worker_required', performed: false },
    });
  });

  test('a spawned actor session is refused before the background loop, tools, or model', async () => {
    const fixture = turnDeps('spawned');
    expect(await fixture.driver.runAgentTurn({ sessionId: 's1', userText: 'continue delegated work' }))
      .toBeUndefined();

    expect(fixture.loopCtx()).toBeNull();
    expect(fixture.toolContextArgs()).toBeNull();
    expect(fixture.modelCalls).toEqual([]);
    expect(fixture.recordedModelCalls).toEqual([]);
    expect(fixture.releases()).toBe(1);
    expect(fixture.audits).toContainEqual({
      type: 'actor_background_turn_refused',
      sessionId: 's1',
      details: { reason: 'dedicated_worker_required', performed: false },
    });
  });

  test('the custody refusal keeps stable model-facing recovery language', () => {
    expect(ACTOR_CREDENTIAL_BOUNDARY_FAILURE).toContain('model request was not run');
    expect(ACTOR_CREDENTIAL_BOUNDARY_FAILURE).toContain('Do not retry automatically');
    expect(ACTOR_CREDENTIAL_BOUNDARY_FAILURE).toContain('Ask the user to reload peerd');
    expect(ACTOR_CREDENTIAL_BOUNDARY_FAILURE).not.toContain('no egress');
  });

  test('a production loop error event fails a chat turn', async () => {
    const fixture = turnDeps('chat', { streamBoundaryFailure: true });
    expect(await fixture.driver.runAgentTurn({
      sessionId: 's1', userText: 'inspect the page',
    })).toEqual({ ok: false, stopReason: undefined });

    expect(fixture.broadcasts).toContainEqual(expect.objectContaining({
      type: 'turn/error', error: ACTOR_CREDENTIAL_BOUNDARY_FAILURE,
    }));
    expect(fixture.broadcasts.some((message) => message.type === 'turn/actor-done')).toBe(false);
  });

  test('a production loop error fails a background turn with no UI broadcasts', async () => {
    const fixture = turnDeps('chat', {
      streamBoundaryFailure: true,
      uiDisconnected: true,
    });
    expect(await fixture.driver.runAgentTurn({
      sessionId: 's1', userText: 'inspect the page',
    })).toEqual({ ok: false, stopReason: undefined });
    expect(fixture.broadcasts).toEqual([]);
  });

  test('chat cancellation reaches the exact broker signal with no late provider continuation', async () => {
    const fixture = turnDeps('chat', { waitForAbort: true });
    const running = fixture.driver.runAgentTurn({ sessionId: 's1', userText: 'inspect the page' });
    for (let attempt = 0; attempt < 20 && fixture.modelCalls.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(fixture.modelCalls).toHaveLength(1);
    expect(fixture.modelCalls[0].signal).toBe(fixture.turnAbortController.signal);
    fixture.turnAbortController.abort();
    await running;
    expect(fixture.lateProviderContinuation()).toBe(0);
  });

  test('Stop on a fallback never calls or keys the next candidate', async () => {
    const fixture = turnDeps('chat', { abortDuringFallback: true });
    const running = fixture.driver.runAgentTurn({ sessionId: 's1', userText: 'inspect the page' });
    for (let attempt = 0; attempt < 20 && fixture.modelCalls.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(fixture.modelCalls.map((call) => call.provider)).toEqual(['anthropic', 'openrouter']);
    fixture.turnAbortController.abort();
    await running;
    expect(fixture.modelCalls.map((call) => call.provider)).toEqual(['anthropic', 'openrouter']);
    expect(fixture.modelKeyReads).toEqual(['anthropic', 'openrouter']);
    expect(fixture.chatNotes).toHaveLength(1);
    expect(fixture.chatNotes[0]).not.toContain('openai');
  });

  test('a main loop keeps the live credential closures', async () => {
    const fixture = turnDeps('chat');
    await fixture.driver.runAgentTurn({ sessionId: 's1', userText: 'hello' });

    expect(fixture.loopCtx().getSecret).toBe(fixture.liveGetSecret);
    expect(fixture.loopCtx().safeFetch).toBe(fixture.liveSafeFetch);
    expect(fixture.modelCalls[0].getSecret).toBe(fixture.liveGetSecret);
    expect(fixture.modelCalls[0].safeFetch).toBe(fixture.liveSafeFetch);
  });

  test('an actor session cannot reach a failover provider in the background heap', async () => {
    const fixture = turnDeps('actor', { failover: true });
    await fixture.driver.runAgentTurn({ sessionId: 's1', userText: 'inspect the page' });

    expect(fixture.modelCalls).toEqual([]);
    expect(fixture.recordedModelCalls).toEqual([]);
  });
});
