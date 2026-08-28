import { describe, expect, test } from 'bun:test';
import { createAppToolAuthority } from '../../extension/background/app-tool-authority.js';
import { executeControllerAppTool } from '../../extension/peerd-runtime/controller-app-tools.js';

const context = (overrides: Record<string, any> = {}) => ({
  session: { sessionId: 'session-1' },
  appClient: {
    update: async (args: any) => ({
      id: args.appId ?? 'app-current', name: args.name ?? 'work',
      entryFile: args.entryFile ?? 'index.html', updatedAt: 2,
    }),
    open: async (args: any) => args.appId,
    search: async () => [],
    delete: async () => true,
    writeFile: async () => ({ bytesWritten: 3 }),
    readFile: async () => 'untrusted text',
    listFiles: async () => [{ path: 'index.html', size: 14 }],
    deleteFile: async () => undefined,
  },
  appRegistry: {
    get: async (id: string) => ({ id, name: 'work' }),
  },
  ...overrides,
});

describe('exact App authority', () => {
  test('Stop during the fresh delete probe prevents every physical delete edge', async () => {
    let releaseProbe!: () => void;
    let probeStarted!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const started = new Promise<void>((resolve) => { probeStarted = resolve; });
    const controller = new AbortController();
    const shared: any = {};
    let reads = 0;
    let deletes = 0;
    const ctx = context({
      actorType: 'app', actorInstanceId: 'app-1',
      appRegistry: {
        get: async () => {
          reads += 1;
          if (reads === 2) {
            probeStarted();
            await probeGate;
          }
          return { id: 'app-1', name: 'work', pinned: false };
        },
      },
      appClient: { delete: async () => { deletes += 1; return true; } },
    });
    const read = createAppToolAuthority({
      binding: { operation: 'turn.app.read', args: { appId: 'app-1' } },
      ctx, signal: controller.signal, shared,
    });
    await read.readApp('app-1');
    const destroy = createAppToolAuthority({
      binding: { operation: 'turn.app.delete', args: { appId: 'app-1' } },
      ctx, signal: controller.signal, shared,
    });
    const pending = destroy.deleteApp('app-1');
    await started;
    controller.abort();
    releaseProbe();
    await expect(pending).rejects.toMatchObject({
      outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
    });
    expect(deletes).toBe(0);
  });

  test('formats an admitted file read without exposing OPFS', async () => {
    const call = { name: 'app_read_file', args: { appId: 'app-1', path: 'index.html' } };
    const authority = createAppToolAuthority({
      binding: { operation: 'turn.app.read-file', args: call.args }, ctx: context(),
    });
    const result = await executeControllerAppTool('app_read_file', call.args, authority);
    expect(result).toMatchObject({ ok: true });
    expect(result.content).toContain('<untrusted_web_content');
    expect(result.content).toContain('untrusted text');
  });

  test('refuses changed file bytes after admission', async () => {
    const authority = createAppToolAuthority({
      binding: {
        operation: 'turn.app.write-file',
        args: { appId: 'app-1', path: 'safe.bin', contentBase64: 'AQID' },
      },
      ctx: context(),
    });
    let failure: any;
    try { await authority.writeFile('app-1', 'safe.bin', { base64: 'BAUG' }); }
    catch (cause) { failure = cause; }
    expect(failure).toMatchObject({ message: 'App authority mismatch', outcomeKnown: true });
  });

  test('returns only bounded App search metadata to the controller', async () => {
    const call = { name: 'app_search', args: { query: 'work' } };
    const authority = createAppToolAuthority({
      binding: { operation: 'turn.app.search', args: call.args },
      ctx: context({
        appClient: {
          search: async () => [{
            app: {
              id: 'app-1', name: 'work', tags: ['demo'], updatedAt: 3,
              ownerSessionId: 'must-not-cross', fileKinds: { 'index.html': 'text' },
            },
            snippet: 'work body', rank: 3,
          }],
        },
      }),
    });
    const hits = await authority.searchApps('work');
    expect(hits).toEqual([{
      app: { id: 'app-1', name: 'work', tags: ['demo'], updatedAt: 3 },
      snippet: 'work body',
    }]);
  });

  test('rechecks existence immediately before destructive deletion', async () => {
    let reads = 0;
    let deleted = false;
    const ctx = context({
        appRegistry: {
          get: async () => reads++ === 0 ? { id: 'app-1', name: 'work' } : null,
        },
        appClient: { delete: async () => { deleted = true; } },
    });
    const shared: any = {};
    const read = createAppToolAuthority({
      binding: { operation: 'turn.app.read', args: { appId: 'app-1' } }, ctx, shared,
    });
    await read.readApp('app-1');
    const destroy = createAppToolAuthority({
      binding: { operation: 'turn.app.delete', args: { appId: 'app-1' } }, ctx, shared,
    });
    await expect(destroy.deleteApp('app-1')).rejects.toMatchObject({
      message: 'App authority mismatch', outcomeKnown: true,
    });
    expect(deleted).toBe(false);
  });

  test('runs code with one fixed App-only capability and owner-bound lease', async () => {
    const calls: any[] = [];
    const leases: any[] = [];
    const call = { name: 'app_code', args: { code: 'return app.observe()', timeoutMs: 5000 } };
    const authority = createAppToolAuthority({
      binding: { operation: 'turn.app.run-code', args: call.args },
      appProgramSemanticToken: 'app-program-token',
      ctx: context({
        jsOffscreenClient: {
          execHeadless: async (code: string, options: any) => {
            calls.push({ code, options });
            options.onExecutionDispatch();
            return { value: 'ok', consoleOutput: [], durationMs: 1 };
          },
        },
        scriptRuns: {
          mintRunId: () => 'run-app-1',
          register: (...args: any[]) => leases.push(['register', ...args]),
          release: (...args: any[]) => leases.push(['release', ...args]),
        },
      }),
      signal: new AbortController().signal,
    });
    const result = await authority.runCode(call.args.code, 5000);
    expect(result.value).toBe('ok');
    expect(calls[0].options).toMatchObject({
      timeoutMs: 5000,
      caps: { app: true, page: false, egress: false, subagent: false, opfs: false },
      ownerSessionId: 'session-1', runId: 'run-app-1',
      appProgramSemanticToken: 'app-program-token',
    });
    expect(leases.map((entry) => entry[0])).toEqual(['register', 'release']);
  });

  test('pins runtime action name and parameters to the admitted call', async () => {
    let relayed = false;
    const authority = createAppToolAuthority({
      binding: {
        operation: 'turn.app.act', args: { action: 'move', params: { x: 1 } },
      },
      ctx: context({
        appAgentCall: async () => { relayed = true; return { ok: true, value: {} }; },
      }),
    });
    let failure: any;
    try { await authority.actRuntime('move', { x: 2 }); }
    catch (cause) { failure = cause; }
    expect(failure).toMatchObject({ message: 'App authority mismatch', outcomeKnown: true });
    expect(relayed).toBe(false);
  });
});
