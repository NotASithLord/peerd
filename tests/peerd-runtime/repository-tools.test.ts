import { describe, expect, test } from 'bun:test';
import { repositoryHistoryTool } from '../../extension/peerd-runtime/tools/defs/app-history.js';
import { repositoryRemoteTool } from '../../extension/peerd-runtime/tools/defs/app-remote.js';
import { repositoryVersionTool } from '../../extension/peerd-runtime/tools/defs/app-version.js';

const actorContext = (repositoryAuthority: any, extra: any = {}) => ({
  actorType: 'app', actorInstanceId: 'app-1', repositoryAuthority, ...extra,
});

const remoteAuthority = (extra: any = {}) => ({
  readRemote: async () => ({ url: 'https://github.com/owner/repo', host: 'github.com' }),
  confirmRemote: async () => 'yes_once',
  ...extra,
});

describe('repository actor tools', () => {
  test('propagates a remote push rejection as a failed tool call', async () => {
    const result = await repositoryRemoteTool.execute({ op: 'push' }, actorContext(
      remoteAuthority({ push: async () => ({ ok: false, error: 'non-fast-forward' }) }),
    ) as any);
    expect(result).toEqual({ ok: false, error: 'git_push_rejected: non-fast-forward' });
  });

  test('preserves unknown push custody and instructs the orchestrator not to retry', async () => {
    const failure = Object.assign(new Error('raw transport detail must not be rendered'), {
      code: 'repository-host-timeout', outcomeKnown: false,
    });
    const result = await repositoryRemoteTool.execute({ op: 'push' }, actorContext(
      remoteAuthority({ push: async () => { throw failure; } }),
    ) as any);
    expect(result).toMatchObject({
      ok: false,
      error: 'repo_remote_outcome_unknown',
      code: 'repository-host-timeout',
      outcomeKnown: false,
      outcomeKind: 'transport-lost',
      retryable: false,
      structured: {
        code: 'repository-host-timeout',
        outcomeKnown: false,
        retryable: false,
        reconciliation: 'repo_history',
      },
    });
    expect('content' in result && result.content).toContain('Do not retry automatically');
    expect(JSON.stringify(result)).not.toContain('raw transport detail');
  });

  test('preserves unknown checkpoint custody after Firefox lifetime loss', async () => {
    const failure = Object.assign(new Error('event page disappeared'), {
      code: 'repository-firefox-lifetime-lost', outcomeKnown: false, outcomeKind: 'host-lost',
    });
    const result = await repositoryVersionTool.execute(
      { op: 'checkpoint', message: 'checkpoint' },
      actorContext({ checkpoint: async () => { throw failure; } }) as any,
    );
    expect(result).toMatchObject({
      ok: false,
      error: 'repo_version_outcome_unknown',
      code: 'repository-firefox-lifetime-lost',
      outcomeKnown: false,
      outcomeKind: 'host-lost',
      retryable: false,
    });
    expect('content' in result && result.content).toContain('repo_history');
  });

  test('keeps a read timeout known-safe and preserves its code', async () => {
    const failure = Object.assign(new Error('Repository service took too long to respond.'), {
      code: 'repository-host-timeout', outcomeKnown: true,
    });
    const result = await repositoryHistoryTool.execute({}, actorContext({
      readStatus: async () => { throw failure; },
      readHistory: async () => [],
      readRemote: async () => null,
    }) as any);
    expect(result).toMatchObject({
      ok: false,
      code: 'repository-host-timeout',
      outcomeKnown: true,
      retryable: true,
    });
    expect('error' in result && result.error).toContain('repo_history_failed');
  });

  test('refuses arbitrary/private refs before asking authority for a diff', async () => {
    let diffCalled = false;
    const result = await repositoryHistoryTool.execute(
      { includeDiff: true, from: 'refs/peerd/safety/private' },
      actorContext({
        readStatus: async () => ({ branch: 'main' }),
        readHistory: async () => [{ oid: 'a'.repeat(40), message: 'visible' }],
        readRemote: async () => null,
        readDiff: async () => { diffCalled = true; return { files: [], patch: '' }; },
      }) as any,
    );
    expect(result).toEqual({ ok: false, error: 'diff_from_must_be_a_visible_commit' });
    expect(diffCalled).toBe(false);
  });

  test('selects the exact branch operation without adding a checkpoint', async () => {
    let branch = '';
    const result = await repositoryVersionTool.execute(
      { op: 'branch', name: 'feature' },
      actorContext({ branch: async (name: string) => {
        branch = name;
        return { branch: name, checkedOut: true };
      } }) as any,
    );
    expect(result.ok).toBe(true);
    expect(branch).toBe('feature');
  });

  test('requires authority confirmation before restore', async () => {
    const order: string[] = [];
    const result = await repositoryVersionTool.execute(
      { op: 'restore', to: 'abc123' },
      actorContext({
        confirmRestore: async (to: string) => { order.push(`confirm:${to}`); return 'yes_once'; },
        restore: async (to: string) => { order.push(`restore:${to}`); return { restored: true }; },
      }, { actorType: 'notebook' }) as any,
    );
    expect(result.ok).toBe(true);
    expect(order).toEqual(['confirm:abc123', 'restore:abc123']);
  });
});
