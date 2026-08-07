// @ts-check
// Browser-runtime proof for the bound-actor fallback custody shape. This runs
// the production turn driver, session store, and agent loop in a page realm,
// with injected shell dependencies and a fake provider. Live service-worker
// wiring still needs a packaged Firefox actor smoke test.

import { describe, it, expect } from '../../framework.js';
import {
  ACTOR_CREDENTIAL_BOUNDARY_FAILURE, createSessionStore, makeTurnDriver, runUserTurn,
} from '/peerd-runtime/index.js';
import { makeMockIdb } from '../../mocks/idb.js';

/** @param {any} value */
const identity = (value) => value;

describe('bound actor fallback credential custody', () => {
  it('keeps credentials out of the real loop and restores them at the model boundary', async () => {
    const sessions = createSessionStore({
      idb: makeMockIdb(),
      now: () => 1_000,
      makeId: (() => { let id = 0; return () => `actor-credential-${++id}`; })(),
    });
    const actor = await sessions.create({
      kind: 'actor', actorType: 'web', instanceId: 'web',
      provider: 'anthropic', model: 'claude-test',
    });
    const liveGetSecret = async () => 'browser-key-canary';
    const liveSafeFetch = async () => new Response('ok');
    /** @type {Record<string, any> | null} */
    let loopCtx = null;
    /** @type {Record<string, any>[]} */
    const modelCalls = [];
    /** @type {Record<string, any>[]} */
    const broadcasts = [];
    let tripBoundary = false;
    const settings = {
      reasoningEnabled: false,
      reasoningEffort: 'medium',
      pricingOverrides: {},
      contextWindowOverrides: {},
      spendLimitUsd: 0,
      ollamaHost: '',
      dwebEnabled: false,
    };
    const driver = makeTurnDriver({
      vault: { isLocked: () => false },
      sessionCache: {
        /** @param {string} key */
        sessionGet: async (key) => key === 'currentSessionId' ? actor.sessionId : null,
        sessionSet: async () => {},
      },
      sessions,
      sessionState: { set: () => {} },
      turnSlots: {
        claim: () => ({ controller: new AbortController(), release: () => {} }),
        isBusy: () => false,
      },
      buildTemporalBlock: () => '',
      memory: { loadAlwaysLoaded: async () => ({ text: '' }) },
      browser: { tabs: { query: async () => [] } },
      originOfTabUrl: () => '',
      skillRegistry: { describeForPrompt: async () => '' },
      renderSystemPrompt: async () => 'actor system',
      resolveManifestAllow: () => null,
      buildToolContext: async () => ({ permission: {}, actorSurface: 'tools', schemaReply: false }),
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
      uiConnected: () => true,
      uiPorts: { broadcast: (/** @type {any} */ message) => broadcasts.push(message) },
      auditLog: { append: async () => {} },
      postChatNote: () => {},
      /** @param {any} start */
      resolveFailoverChain: (start) => [start],
      shouldFailover: () => false,
      /** @param {Record<string, any>} args */
      async *callModel(args) {
        modelCalls.push(args);
        expect(await args.getSecret('anthropic')).toBe('browser-key-canary');
        expect((await args.safeFetch('https://example.com')).status).toBe(200);
        yield { type: 'text-delta', text: 'actor completed' };
        yield { type: 'message-stop', stopReason: 'end_turn' };
      },
      /** @param {any} ctx */
      runUserTurn: (ctx) => {
        loopCtx = ctx;
        if (tripBoundary) {
          return runUserTurn({
            ...ctx,
            async *callModel() {
              await ctx.getSecret('anthropic');
            },
          });
        }
        return runUserTurn(ctx);
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
    });

    const result = await driver.runAgentTurn({
      sessionId: actor.sessionId,
      userText: 'inspect the page',
    });
    expect(result).toEqual({ ok: true, stopReason: 'end_turn' });
    expect(modelCalls.length).toBe(1);
    expect(modelCalls[0].getSecret).toBe(liveGetSecret);
    expect(modelCalls[0].safeFetch).toBe(liveSafeFetch);
    const captured = /** @type {Record<string, any>} */ (/** @type {unknown} */ (loopCtx));
    await expect(() => captured.getSecret('anthropic'))
      .toThrow((error) => error?.name === 'ActorCredentialBoundaryError'
        && error?.capability === 'secret');
    await expect(() => captured.safeFetch('https://example.com'))
      .toThrow((error) => error?.name === 'ActorCredentialBoundaryError'
        && error?.capability === 'provider-network');
    const stored = await sessions.get(actor.sessionId);
    expect(stored?.messages.at(-1)?.content).toBe('actor completed');

    // Production-path regression: runUserTurn consumes the model iterator and
    // catches the named error itself. The refusal must be mapped before that
    // event crosses into the driver, and the driver must report a failed turn.
    tripBoundary = true;
    const refused = await driver.runAgentTurn({
      sessionId: actor.sessionId,
      userText: 'try direct credential access',
      display: { parentToolUseId: 'boundary-tool', kind: 'web', instanceId: 'web' },
    });
    expect(refused).toEqual({ ok: false, stopReason: undefined });
    expect(broadcasts.some((message) => message.type === 'turn/error'
      && message.error === ACTOR_CREDENTIAL_BOUNDARY_FAILURE)).toBe(true);
    expect(broadcasts.some((message) => message.type === 'turn/actor-done'
      && message.parentToolUseId === 'boundary-tool' && message.ok === false)).toBe(true);
    const afterRefusal = await sessions.get(actor.sessionId);
    expect(String((/** @type {any} */ (afterRefusal?.messages.at(-1)))?.error))
      .toContain('model request was not run');
    expect(JSON.stringify(afterRefusal).includes('refused direct secret access')).toBe(false);
  });
});
