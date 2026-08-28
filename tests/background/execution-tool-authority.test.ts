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
});
