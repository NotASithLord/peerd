import { describe, expect, test } from 'bun:test';
import { createExecutionToolAuthority } from '../../extension/background/execution-tool-authority.js';

const planFor = (kind: 'notebook'|'pod') => ({
  kind, name: 'Work', gitUrl: 'https://github.com/example/work.git',
});

describe('exact execution creation rollback', () => {
  test.each(['notebook', 'pod'] as const)(
    'a rejected %s clone confirmation removes the provisional engine and repository',
    async (kind) => {
      const deleted: string[] = [];
      const destroyed: any[] = [];
      let clones = 0;
      let tabs = 0;
      const registry = {
        create: async () => ({ id: `${kind}-1`, name: 'Work' }),
        delete: async (id: string) => { deleted.push(id); return true; },
        setDefaultForSession: async () => {},
      };
      const tracker = {
        ensureTab: async () => { tabs += 1; },
        getTabId: () => null,
      };
      const repositories = {
        clone: async () => { clones += 1; return {}; },
        destroy: async (...args: any[]) => { destroyed.push(args); },
      };
      const ctx: any = {
        session: { sessionId: 'chat-1' }, repositories,
        confirm: async () => { throw new Error('prompt transport lost'); },
        ...(kind === 'notebook'
          ? { jsRegistry: registry, jsTabTracker: tracker }
          : { podRegistry: registry, podTabTracker: tracker }),
      };
      const plan = planFor(kind);
      const authority = createExecutionToolAuthority({
        binding: { operation: `turn.execution.create-${kind}`, args: { plan } }, ctx,
      });
      const result = kind === 'notebook'
        ? await authority.createNotebook(plan)
        : await authority.createPod(plan);
      expect(result).toEqual({ ok: false, error: 'git_confirmation_failed' });
      expect({ deleted, clones, tabs }).toEqual({
        deleted: [`${kind}-1`], clones: 0, tabs: 0,
      });
      expect(destroyed).toEqual([[
        { kind, id: `${kind}-1` }, { worktree: true },
      ]]);
    },
  );

  test('failed cleanup after a confirmation transport loss remains performed and unknown', async () => {
    const plan = planFor('notebook');
    const authority = createExecutionToolAuthority({
      binding: { operation: 'turn.execution.create-notebook', args: { plan } },
      ctx: {
        session: { sessionId: 'chat-1' },
        jsRegistry: {
          create: async () => ({ id: 'notebook-1', name: 'Work' }),
          delete: async () => false,
        },
        jsTabTracker: { ensureTab: async () => {}, getTabId: () => null },
        repositories: { destroy: async () => { throw new Error('cleanup lost'); } },
        confirm: async () => { throw new Error('prompt transport lost'); },
      },
    });
    await expect(authority.createNotebook(plan)).rejects.toMatchObject({
      performed: true, outcomeKnown: false, retryable: false,
    });
  });

  test('Act revocation during clone confirmation removes the provisional Notebook without cloning', async () => {
    const plan = planFor('notebook');
    const deleted: string[] = [];
    const destroyed: any[] = [];
    let clones = 0;
    let mode = 'act';
    const authority = createExecutionToolAuthority({
      binding: { operation: 'turn.execution.create-notebook', args: { plan } },
      ctx: {
        session: { sessionId: 'chat-1' },
        jsRegistry: {
          create: async () => ({ id: 'notebook-1', name: 'Work' }),
          delete: async (id: string) => { deleted.push(id); return true; },
        },
        jsTabTracker: { ensureTab: async () => {} },
        repositories: {
          clone: async () => { clones += 1; return {}; },
          destroy: async (...args: any[]) => { destroyed.push(args); },
        },
        confirm: async () => { mode = 'plan'; return 'yes_once'; },
        readAuthorityPermission: async () => ({ mode }),
      },
    });
    expect(await authority.createNotebook(plan)).toEqual({
      ok: false, error: 'plan_mode_refused',
    });
    expect({ clones, deleted, destroyed }).toEqual({
      clones: 0,
      deleted: ['notebook-1'],
      destroyed: [[{ kind: 'notebook', id: 'notebook-1' }, { worktree: true }]],
    });
  });

  test('Act revocation during App Git confirmation prevents createFromGit', async () => {
    const plan = {
      kind: 'app', name: 'Work', gitUrl: 'https://github.com/example/work.git',
    };
    let imports = 0;
    let mode = 'act';
    const authority = createExecutionToolAuthority({
      binding: { operation: 'turn.execution.create-app', args: { plan } },
      ctx: {
        session: { sessionId: 'chat-1' },
        appClient: {
          createFromGit: async () => { imports += 1; return { record: { id: 'app-1' } }; },
        },
        confirm: async () => { mode = 'plan'; return 'yes_once'; },
        readAuthorityPermission: async () => ({ mode }),
      },
    });
    expect(await authority.createApp(plan)).toEqual({
      ok: false, code: 'plan_mode_refused', error: 'plan_mode_refused',
      outcomeKind: 'pre-effect-failure', retryable: false,
    });
    expect(imports).toBe(0);
  });

  test('creation failures use the consolidated sandbox tool name', async () => {
    const podPlan = planFor('pod');
    const pod = createExecutionToolAuthority({
      binding: { operation: 'turn.execution.create-pod', args: { plan: podPlan } },
      ctx: {
        session: { sessionId: 'chat-1' },
        podRegistry: {
          create: async () => ({ id: 'pod-1', name: 'Work' }),
          delete: async () => true,
        },
        podTabTracker: { ensureTab: async () => {}, getTabId: () => null },
        repositories: {
          clone: async () => { throw new Error('clone refused'); },
          destroy: async () => {},
        },
        confirm: async () => true,
        readAuthorityPermission: async () => ({ mode: 'act' }),
      },
    });
    expect(await pod.createPod(podPlan)).toEqual({
      ok: false, error: 'sandbox_create_failed: pod: clone refused',
    });

    const appPlan = { kind: 'app', name: 'Work' };
    const app = createExecutionToolAuthority({
      binding: { operation: 'turn.execution.create-app', args: { plan: appPlan } },
      ctx: {
        session: { sessionId: 'chat-1' },
        appClient: { create: async () => { throw new Error('private backend detail'); } },
      },
    });
    expect(await app.createApp(appPlan)).toEqual({
      ok: false, error: 'sandbox_create_failed: app',
      outcomeKind: 'pre-effect-failure', retryable: true,
    });
  });

  test.each(['notebook', 'pod'] as const)(
    '%s rollback requires the registry to attest that its provisional record was deleted',
    async (kind) => {
      const plan = planFor(kind);
      const registry = {
        create: async () => ({ id: `${kind}-1`, name: 'Work' }),
        delete: async () => false,
      };
      const authority = createExecutionToolAuthority({
        binding: { operation: `turn.execution.create-${kind}`, args: { plan } },
        ctx: {
          session: { sessionId: 'chat-1' },
          repositories: { destroy: async () => {} },
          confirm: async () => false,
          ...(kind === 'notebook'
            ? { jsRegistry: registry, jsTabTracker: { ensureTab: async () => {} } }
            : { podRegistry: registry, podTabTracker: { ensureTab: async () => {} } }),
        },
      });
      const call = kind === 'notebook'
        ? authority.createNotebook(plan) : authority.createPod(plan);
      await expect(call).rejects.toMatchObject({
        performed: true, outcomeKnown: false, retryable: false,
      });
    },
  );

  test('WebVM rollback requires an affirmative registry deletion result', async () => {
    const plan = { kind: 'webvm', name: 'Work' };
    const authority = createExecutionToolAuthority({
      binding: { operation: 'turn.execution.create-webvm', args: { plan } },
      ctx: {
        session: { sessionId: 'chat-1' },
        vmRegistry: {
          create: async () => ({ id: 'vm-1', name: 'Work' }),
          delete: async () => false,
        },
        vmTabTracker: {
          ensureTab: async () => { throw new Error('tab failed'); },
          getTabId: () => null,
        },
      },
    });
    await expect(authority.createWebVm(plan)).rejects.toMatchObject({
      performed: true, outcomeKnown: false, retryable: false,
    });
  });

  test.each([
    ['nested host loss', {
      durationMs: 1, value: undefined,
      error: 'nested host operation outcome unknown',
      outcomeKnown: false, outcomeKind: 'transport-lost', retryable: false,
    }, false],
    ['ordinary user-code failure', {
      durationMs: 1, value: undefined, error: 'ReferenceError: missing is not defined',
    }, true],
  ] as const)('headless script preserves %s custody', async (_label, jobResult, expectedOk) => {
    const code = 'return missing';
    const authority = createExecutionToolAuthority({
      binding: { operation: 'turn.execution.run-script', args: { code } },
      ctx: {
        session: { sessionId: 'chat-1', kind: 'chat' },
        jsOffscreenClient: { execHeadless: async () => jobResult },
      },
    });
    const result = await authority.runHeadlessScript({
      code, actors: false, provider: false, workspace: false, timeoutMs: null,
    });
    expect(result.ok).toBe(expectedOk);
    if (expectedOk) {
      expect(result).toMatchObject({ ok: true, result: { error: jobResult.error } });
    } else {
      expect(result).toMatchObject({
        ok: false, error: 'script_nested_host_outcome_unknown',
        performed: true, outcomeKnown: false,
        outcomeKind: 'transport-lost', retryable: false,
      });
    }
  });

  test('delegating script binds its live operation feed to the exact model call', async () => {
    let options: any = null;
    const authority = createExecutionToolAuthority({
      binding: {
        operation: 'turn.execution.run-script',
        args: { code: "return actors.call('web', 'read')" },
      },
      ctx: {
        session: { sessionId: 'chat-1', kind: 'chat' },
        toolUseId: 'script-call-1',
        messageActor: async () => ({}),
        operationGrant: new Set(['turn.actor.message']),
        jsOffscreenClient: {
          execHeadless: async (_code: string, value: any) => {
            options = value;
            return { durationMs: 1, value: 'done', usedActors: true };
          },
        },
        scriptRuns: {
          mintRunId: () => 'run-1', register: () => {}, release: () => {}, opsFor: () => [],
        },
      },
    });
    const result = await authority.runHeadlessScript({
      code: "return actors.call('web', 'read')",
      actors: true, provider: false, workspace: false, timeoutMs: null,
    });
    expect(result.ok).toBe(true);
    expect(options).toMatchObject({
      runId: 'run-1', ownerSessionId: 'chat-1', ownerToolUseId: 'script-call-1', actors: true,
      timeoutMs: 270_000,
    });
  });
});
