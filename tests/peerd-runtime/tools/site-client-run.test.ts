import { describe, expect, test } from 'bun:test';
import { siteClientRunTool } from '../../../extension/peerd-runtime/tools/defs/site-client-run.js';
import { executeSiteClientTool } from '../../helpers/site-client-tool.js';

describe('site_client_run code-run custody', () => {
  test('mints one owner-bound live run and threads it through the pinned site job', async () => {
    let options: any = null;
    let registered: any = null;
    let released = '';
    const result = await executeSiteClientTool(siteClientRunTool, {
      origin: 'https://api.example.com', code: 'return await client.list()',
    }, {
      session: { sessionId: 'api-actor-1' },
      canUseSiteClientOrigin: () => true,
      authorizeSiteClientOrigin: async () => true,
      siteClients: {
        get: async () => ({ body: 'return { list: () => site.fetch("/items") };' }),
        recordRun: async () => {},
      },
      jsOffscreenClient: {
        execHeadless: async (_code: string, opts: any) => {
          options = opts;
          return { durationMs: 3, value: [], error: null, codeTrace: [] };
        },
      },
      scriptRuns: {
        mintRunId: () => 'site-run-1',
        register: (...args: any[]) => { registered = args; },
        release: (runId: string) => { released = runId; },
      },
    } as any);
    expect(result.ok).toBe(true);
    expect(registered).toEqual(['site-run-1', undefined, 'api-actor-1', { site: true }]);
    expect(options).toMatchObject({ runId: 'site-run-1', ownerSessionId: 'api-actor-1', siteFetch: 'https://api.example.com' });
    expect(released).toBe('site-run-1');
  });

  test('a pre-aborted turn never starts a worker', async () => {
    let started = false;
    const result = await executeSiteClientTool(siteClientRunTool, { origin: 'https://api.example.com', code: 'return 1' }, {
      session: { sessionId: 'api-actor-1' },
      canUseSiteClientOrigin: () => true,
      authorizeSiteClientOrigin: async () => true,
      siteClients: { get: async () => ({ body: 'return {};' }) },
      abortSignal: { aborted: true },
      scriptRuns: { mintRunId: () => 'x', register: () => {}, release: () => {} },
      jsOffscreenClient: { execHeadless: async () => { started = true; return {}; } },
    } as any);
    expect(result).toEqual({
      ok: false,
      error: 'site_client_run_aborted: the turn was stopped before the run started',
      outcomeKind: 'pre-effect-failure',
    });
    expect(started).toBe(false);
  });

  test('Stop while loading the stored client prevents registration and execution', async () => {
    let finishLoad = (_value: any) => {};
    const load = new Promise((resolve) => { finishLoad = resolve; });
    let markLoading = () => {};
    const loading = new Promise<void>((resolve) => { markLoading = resolve; });
    let registered = false;
    let started = false;
    const controller = new AbortController();
    const pending = executeSiteClientTool(siteClientRunTool, {
      origin: 'https://api.example.com', code: 'return 1',
    }, {
      session: { sessionId: 'api-actor-1' },
      canUseSiteClientOrigin: () => true,
      authorizeSiteClientOrigin: async () => true,
      siteClients: { get: async () => { markLoading(); return load; } },
      abortSignal: controller.signal,
      scriptRuns: {
        mintRunId: () => 'x',
        register: () => { registered = true; },
        release: () => {},
      },
      jsOffscreenClient: {
        execHeadless: async () => { started = true; return {}; },
      },
    } as any);
    await loading;
    controller.abort();
    finishLoad({ body: 'return {};' });
    expect(await pending).toEqual({
      ok: false,
      error: 'site_client_run_aborted: the turn stopped while loading the client',
      outcomeKind: 'pre-effect-failure',
    });
    expect(registered).toBe(false);
    expect(started).toBe(false);
  });

  test('Stop during a live run does not mark the stored client stale', async () => {
    const controller = new AbortController();
    let recordRuns = 0;
    let rejectRun = (_error: Error) => {};
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const running = new Promise((_resolve, reject) => { rejectRun = reject; });
    const pending = executeSiteClientTool(siteClientRunTool, {
      origin: 'https://api.example.com', code: 'return await client.list()',
    }, {
      session: { sessionId: 'api-actor-1' },
      canUseSiteClientOrigin: () => true,
      authorizeSiteClientOrigin: async () => true,
      siteClients: {
        get: async () => ({ body: 'return { list: async () => [] };' }),
        recordRun: async () => { recordRuns++; },
      },
      abortSignal: controller.signal,
      scriptRuns: {
        mintRunId: () => 'site-run-stop', register: () => {}, release: () => {},
      },
      jsOffscreenClient: {
        execHeadless: async () => { markStarted(); return running; },
        abortHeadless: async () => {},
      },
    } as any);
    await started;
    controller.abort();
    rejectRun(new DOMException('stopped', 'AbortError'));
    expect(await pending).toEqual({
      ok: false,
      error: 'site_client_run_aborted: the turn was stopped during the run',
      outcomeKind: 'pre-effect-failure',
    });
    expect(recordRuns).toBe(0);
  });

  test('a caught inner write transport loss remains unknown at the outer authority edge', async () => {
    const pending = executeSiteClientTool(siteClientRunTool, {
      origin: 'https://api.example.com', code: 'try { await client.save() } catch {} return "ok"',
    }, {
      session: { sessionId: 'api-actor-1' },
      canUseSiteClientOrigin: () => true,
      authorizeSiteClientOrigin: async () => true,
      siteClients: {
        get: async () => ({ body: 'return { save: () => site.fetch("/items", {method:"POST"}) };' }),
        recordRun: async () => {},
      },
      scriptRuns: {
        mintRunId: () => 'site-run-unknown', register: () => {}, release: () => {},
      },
      jsOffscreenClient: {
        execHeadless: async () => ({
          value: 'ok', error: 'site write outcome unknown: response lost',
          siteOutcomeUnknown: true, siteOutcomeError: 'response lost',
        }),
      },
    } as any);
    await expect(pending).rejects.toMatchObject({
      message: 'response lost', outcomeKnown: false,
      outcomeKind: 'transport-lost', retryable: false,
    });
  });
});
