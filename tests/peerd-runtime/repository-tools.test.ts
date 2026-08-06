import { describe, expect, test } from 'bun:test';
import { repositoryHistoryTool } from '../../extension/peerd-runtime/tools/defs/app-history.js';
import { repositoryRemoteTool } from '../../extension/peerd-runtime/tools/defs/app-remote.js';
import { repositoryVersionTool } from '../../extension/peerd-runtime/tools/defs/app-version.js';

const actorContext = (repositories: any, extra: any = {}) => ({
  actorType: 'app', actorInstanceId: 'app-1', repositories,
  confirm: async () => 'yes_once', appTabTracker: { getTabId: () => null, reloadTab: async () => {} },
  ...extra,
});

describe('repository actor tools', () => {
  test('propagates a remote push rejection as a failed tool call', async () => {
    const repositories = {
      getRemote: async () => ({ url: 'https://github.com/owner/repo', host: 'github.com' }),
      coordinate: async (_ref: any, operation: () => Promise<any>) => operation(),
      commit: async () => ({ created: false }),
      push: async () => ({ ok: false, error: 'non-fast-forward' }),
    };
    const result = await repositoryRemoteTool.execute({ op: 'push' }, actorContext(repositories) as any);
    expect(result).toEqual({ ok: false, error: 'git_push_rejected: non-fast-forward' });
  });

  test('refuses arbitrary/private refs before a model-facing diff', async () => {
    let diffCalled = false;
    const repositories = {
      status: async () => ({ branch: 'main' }),
      history: async () => [{ oid: 'a'.repeat(40), message: 'visible' }],
      getRemote: async () => null,
      diff: async () => { diffCalled = true; return { files: [], patch: '' }; },
    };
    const result = await repositoryHistoryTool.execute(
      { includeDiff: true, from: 'refs/peerd/safety/private' }, actorContext(repositories) as any,
    );
    expect(result).toEqual({ ok: false, error: 'diff_from_must_be_a_visible_commit' });
    expect(diffCalled).toBe(false);
  });

  test('creates a branch before committing the dirty working tree', async () => {
    let committed = false;
    const repositories = {
      coordinate: async (_ref: any, operation: () => Promise<any>) => operation(),
      commit: async () => { committed = true; },
      branch: async () => ({ branch: 'feature', checkedOut: true }),
    };
    const result = await repositoryVersionTool.execute(
      { op: 'branch', name: 'feature' }, actorContext(repositories) as any,
    );
    expect(result.ok).toBe(true);
    expect(committed).toBe(false);
  });
});
