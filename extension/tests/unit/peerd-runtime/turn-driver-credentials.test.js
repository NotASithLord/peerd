// @ts-check
// Browser-runtime proof that a bound actor cannot enter the privileged turn
// driver. Live service-worker wiring is covered by the packaged Firefox smoke.

import { describe, it, expect } from '../../framework.js';
import { createSessionStore, makeTurnAuthorityDriver } from '/peerd-runtime/index.js';
import { makeMockIdb } from '../../mocks/idb.js';

/** @param {any} value */
const identity = (value) => value;

describe('bound actor background-heap refusal', () => {
  it('refuses before the real loop or provider can run', async () => {
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
    const audits = [];
    let releases = 0;
    const settings = {
      reasoningEnabled: false,
      reasoningEffort: 'medium',
      pricingOverrides: {},
      contextWindowOverrides: {},
      spendLimitUsd: 0,
      ollamaHost: '',
      dwebEnabled: false,
    };
    const driver = makeTurnAuthorityDriver({
      vault: { isLocked: () => false },
      sessionCache: {
        /** @param {string} key */
        sessionGet: async (key) => key === 'currentSessionId' ? actor.sessionId : null,
        sessionSet: async () => {},
      },
      sessions,
      turnSlots: {
        claim: () => ({ controller: new AbortController(), release: () => { releases++; } }),
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
      uiConnected: () => false,
      uiPorts: { broadcast: () => {} },
      auditLog: { append: async (/** @type {any} */ entry) => { audits.push(entry); } },
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
      runUserTurn: (/** @type {any} */ ctx) => { loopCtx = ctx; return /** @type {any} */ ([]); },
      getSecret: liveGetSecret,
      safeFetch: liveSafeFetch,
      REASONING_BUDGET_TOKENS: 0,
      REASONING_EFFORT_LEVELS: ['medium'],
      DEFAULT_SETTINGS: { reasoningEffort: 'medium' },
      trimEnricher: { queue: () => {}, drain: async () => {} },
      contextWindowFor: () => null,
      liveContextWindow: () => null,
      detectInterruptedTurn: () => ({ resumable: false }),
    });

    const result = await driver.runAgentTurn({
      sessionId: actor.sessionId,
      userText: 'inspect the page',
    });
    expect(result).toBe(undefined);
    expect(modelCalls.length).toBe(0);
    expect(loopCtx).toBe(null);
    expect(releases).toBe(1);
    expect(audits.some((entry) => entry.type === 'actor_background_turn_refused'
      && entry.details?.performed === false)).toBe(true);
    const stored = await sessions.get(actor.sessionId);
    expect(stored?.messages.length).toBe(0);
  });
});
