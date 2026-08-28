import { afterEach, describe, expect, test } from 'bun:test';
import { siteClientWriteTool } from '../../../extension/peerd-runtime/tools/defs/site-client-write.js';
import { createExplicitToolFixture } from './explicit-tool-fixture';
import { makeDispatchTracker } from '../../../extension/peerd-runtime/lifecycle/dispatch-tracking.js';
import { createOperationLog } from '../../../extension/peerd-runtime/lifecycle/operation-log.js';
import { OPERATION_STATES } from '../../../extension/peerd-runtime/lifecycle/operation-state.js';
import { classifyFailure } from '../../../extension/peerd-runtime/observability/failure-classify.js';
import { createSiteClientToolAuthority } from '../../../extension/background/site-client-tool-authority.js';

const fixture = createExplicitToolFixture();
const dispatchToolCall = fixture.dispatch;
const setFixtureTool = fixture.set;

afterEach(fixture.clear);

const call = {
  id: 'write-a',
  name: 'site_client_write',
  args: {
    origin: 'https://a.test', summary: 'own client', endpoints: [], auth: 'none',
    deriver: 'probe', body: 'return { own: true };',
  },
};

const context = (over: Record<string, unknown> = {}) => {
  const authorityContext: any = {
    audit: async () => {},
    hooks: [],
    session: { sessionId: 'bound-a' },
    permission: { mode: 'act', confirmActions: true },
    exposure: 'actor',
    actorType: 'web',
    backing: 'tab',
    actorSurface: 'tools',
    denylist: [],
    canUseSiteClientOrigin: (origin: string) => origin === 'https://a.test',
    ...over,
  };
  const shared = {};
  const authorityFor = (operation: string, args: any) => createSiteClientToolAuthority({
    binding: { operation, args }, ctx: authorityContext,
    signal: authorityContext.abortSignal, shared,
  });
  return {
    ...authorityContext,
    siteClientAuthority: {
      readStoredClient: (origin: string) => authorityFor(
        'turn.site-client.read', { origin },
      ).readStoredClient(origin),
      commitConfirmedClient: (origin: string) => authorityFor(
        'turn.site-client.commit', call.args,
      ).commitConfirmedClient(origin),
    },
  };
};

const trackedLifecycle = () => {
  const values = new Map<string, unknown>();
  const log = createOperationLog({
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      },
    },
    now: () => 1,
  });
  return {
    log,
    tracker: makeDispatchTracker({
      operationLog: log,
      generationId: () => 'site-client-test-generation',
      retryClassFor: () => 'E',
      classifyFailure,
    }),
  };
};

describe('site-client dispatch confirmation ordering', () => {
  test('live-custody refusal happens before any generic or dossier prompt', async () => {
    setFixtureTool(siteClientWriteTool);
    let prompts = 0;
    let storeEffects = 0;
    const result = await dispatchToolCall(call as any, context({
      authorizeSiteClientOrigin: async () => false,
      confirm: async () => { prompts += 1; return 'yes_once'; },
      siteClients: {
        get: async () => { storeEffects += 1; return null; },
        put: async () => { storeEffects += 1; return {}; },
      },
    }) as any);

    expect(result.ok).toBe(false);
    expect((result as any).error).toStartWith('site_client_origin_refused');
    expect((result as any).outcomeKind).toBe('pre-effect-failure');
    expect(prompts).toBe(0);
    expect(storeEffects).toBe(0);
  });

  test('an owned write receives exactly the detailed tool confirmation', async () => {
    setFixtureTool(siteClientWriteTool);
    const prompts: any[] = [];
    let puts = 0;
    const result = await dispatchToolCall(call as any, context({
      authorizeSiteClientOrigin: async (origin: string) => origin === 'https://a.test',
      confirm: async (prompt: any) => { prompts.push(prompt); return 'yes_once'; },
      siteClients: {
        get: async () => null,
        put: async ({ dossier, body }: any) => {
          puts += 1;
          return { ...dossier, sizeBytes: body.length };
        },
      },
    }) as any);

    expect(result.ok).toBe(true);
    expect(puts).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ tool: 'site_client_write', origins: ['https://a.test'] });
    expect(prompts[0].proposal.body).toBe('return { own: true };');
  });

  test('a declined dossier settles failed and does not create unknown-intent friction', async () => {
    setFixtureTool(siteClientWriteTool);
    const { tracker, log } = trackedLifecycle();
    const prompts: any[] = [];
    let puts = 0;
    let answer: 'no' | 'yes_once' = 'no';
    const trackedContext = (turnId: string) => context({
      lifecycle: tracker,
      lifecycleTurnId: turnId,
      lifecycleUserInitiated: true,
      authorizeSiteClientOrigin: async () => true,
      confirm: async (prompt: any) => { prompts.push(prompt); return answer; },
      siteClients: {
        get: async () => null,
        put: async ({ dossier, body }: any) => {
          puts += 1;
          return { ...dossier, sizeBytes: body.length };
        },
      },
    });

    const declined = await dispatchToolCall(call as any, trackedContext('turn-1') as any);
    expect(declined).toMatchObject({
      ok: false,
      error: 'site_client_write_rejected',
      outcomeKind: 'pre-effect-failure',
    });
    expect(puts).toBe(0);
    expect((await log.get('bound-a:write-a'))!.state).toBe(OPERATION_STATES.FAILED);

    answer = 'yes_once';
    const repeated = await dispatchToolCall(
      { ...call, id: 'write-b' } as any,
      trackedContext('turn-2') as any,
    );
    expect(repeated.ok).toBe(true);
    expect(puts).toBe(1);
    expect(prompts).toHaveLength(2);
    expect(prompts.every((prompt) => prompt.kind === 'site_client_write')).toBe(true);
  });

  test.each([
    ['during confirmation', (controller: AbortController) => ({
      confirm: async () => {
        controller.abort();
        return 'yes_once' as const;
      },
      authorizeSiteClientOrigin: async () => true,
      expectedError: 'site_client_write_aborted: the turn stopped during confirmation',
    })],
    ['immediately before mutation', (controller: AbortController) => {
      let confirmed = false;
      return {
        confirm: async () => {
          confirmed = true;
          return 'yes_once' as const;
        },
        authorizeSiteClientOrigin: async () => {
          if (confirmed) controller.abort();
          return true;
        },
        expectedError: 'site_client_write_aborted: the turn stopped before mutation',
      };
    }],
  ])('Stop %s is proven pre-effect and settles failed', async (_label, arrange) => {
    setFixtureTool(siteClientWriteTool);
    const { tracker, log } = trackedLifecycle();
    const controller = new AbortController();
    const arranged = arrange(controller);
    let mutations = 0;
    const result = await dispatchToolCall(call as any, context({
      lifecycle: tracker,
      lifecycleTurnId: 'turn-stop',
      lifecycleUserInitiated: true,
      abortSignal: controller.signal,
      confirm: arranged.confirm,
      authorizeSiteClientOrigin: arranged.authorizeSiteClientOrigin,
      siteClients: {
        get: async () => null,
        put: async () => { mutations += 1; return {}; },
        remove: async () => { mutations += 1; },
      },
    }) as any);

    expect(result).toMatchObject({
      ok: false,
      error: arranged.expectedError,
      outcomeKind: 'pre-effect-failure',
    });
    expect(mutations).toBe(0);
    expect((await log.get('bound-a:write-a'))!.state).toBe(OPERATION_STATES.FAILED);
  });
});
