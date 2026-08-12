import { describe, expect, test } from 'bun:test';
import { repositoryHistoryTool } from '../../extension/peerd-runtime/tools/defs/app-history.js';
import { repositoryRemoteTool } from '../../extension/peerd-runtime/tools/defs/app-remote.js';
import { repositoryVersionTool } from '../../extension/peerd-runtime/tools/defs/app-version.js';
import { createAppQuiescence } from '../../extension/background/app-quiescence.js';

const actorContext = (repositories: any, extra: any = {}) => ({
  actorType: 'app', actorInstanceId: 'app-1', repositories,
  confirm: async () => 'yes_once', appTabTracker: { getTabId: () => null, reloadTab: async () => {} },
  appQuiescence: { run: async (_appId: string, operation: () => Promise<any>) => operation() },
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

  test('does not reuse approval after the remote changes while consent is pending', async () => {
    let reads = 0;
    let pushed = false;
    const repositories = {
      getRemote: async () => (++reads === 1
        ? { url: 'https://github.com/owner/approved.git', host: 'github.com' }
        : { url: 'https://gitlab.com/attacker/rebound.git', host: 'gitlab.com' }),
      coordinate: async (_ref: any, operation: () => Promise<any>) => operation(),
      commit: async () => ({ created: false }),
      push: async () => { pushed = true; return { ok: true }; },
    };
    const result = await repositoryRemoteTool.execute(
      { op: 'push' }, actorContext(repositories) as any,
    );
    expect(result.ok).toBe(false);
    expect('error' in result && result.error)
      .toContain('remote changed while authorization was pending');
    expect(pushed).toBe(false);
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

  test('flushes and closes a live App before checkpoint takes the repository lock', async () => {
    const order: string[] = [];
    const repositories = {
      coordinate: async (_ref: any, operation: () => Promise<any>) => {
        order.push('lock');
        try { return await operation(); }
        finally { order.push('unlock'); }
      },
      commit: async () => { order.push('checkpoint'); return { oid: 'new' }; },
    };
    const tracker = {
      getTabId: () => 7,
      quiesceTab: async () => { order.push('flush'); return true; },
      resumeTab: async () => { order.push('resume'); return true; },
      closeTab: async () => { order.push('close'); return true; },
      ensureTab: async () => { order.push('reopen'); return 7; },
      reloadTab: async () => true,
    };
    const appQuiescence = createAppQuiescence({
      tracker,
      withLifecycle: async (_appId, operation) => operation(),
      afterClose: async () => {},
    });
    const result = await repositoryVersionTool.execute(
      { op: 'checkpoint' }, actorContext(repositories, { appTabTracker: tracker, appQuiescence }) as any,
    );
    expect(result.ok).toBe(true);
    expect(order).toEqual(['flush', 'close', 'lock', 'checkpoint', 'unlock', 'reopen']);
  });

  test('flushes and closes a live App before checkpoint-and-push', async () => {
    const order: string[] = [];
    const repositories = {
      getRemote: async () => ({ url: 'https://github.com/owner/repo', host: 'github.com' }),
      coordinate: async (_ref: any, operation: () => Promise<any>) => {
        order.push('lock');
        try { return await operation(); }
        finally { order.push('unlock'); }
      },
      commit: async () => { order.push('checkpoint'); return { created: true }; },
      push: async () => { order.push('push'); return { ok: true }; },
    };
    const tracker = {
      getTabId: () => 7,
      quiesceTab: async () => { order.push('flush'); return true; },
      resumeTab: async () => { order.push('resume'); return true; },
      closeTab: async () => { order.push('close'); return true; },
      ensureTab: async () => { order.push('reopen'); return 7; },
      reloadTab: async () => true,
    };
    const appQuiescence = createAppQuiescence({
      tracker,
      withLifecycle: async (_appId, operation) => operation(),
      afterClose: async () => {},
    });
    const result = await repositoryRemoteTool.execute(
      { op: 'push' }, actorContext(repositories, { appTabTracker: tracker, appQuiescence }) as any,
    );
    expect(result.ok).toBe(true);
    expect(order).toEqual(['flush', 'close', 'lock', 'checkpoint', 'push', 'unlock', 'reopen']);
  });

  test('flushes a live Notebook before branch and leaves its tab open', async () => {
    const order: string[] = [];
    const repositories = {
      coordinate: async (_ref: any, operation: () => Promise<any>) => {
        order.push('lock');
        try { return await operation(); } finally { order.push('unlock'); }
      },
      branch: async () => { order.push('branch'); return { branch: 'feature' }; },
    };
    const tracker = {
      getTabId: () => 17,
      quiesceTab: async () => { order.push('flush'); return true; },
      resumeTab: async () => { order.push('resume'); return true; },
      reloadTab: async () => { order.push('reload'); return true; },
      closeTab: async () => { order.push('close'); return true; },
    };
    const result = await repositoryVersionTool.execute(
      { op: 'branch', name: 'feature' },
      actorContext(repositories, { actorType: 'notebook', jsTabTracker: tracker }) as any,
    );
    expect(result.ok).toBe(true);
    expect(order).toEqual(['flush', 'lock', 'branch', 'unlock', 'resume']);
  });

  test('flushes then reloads the same live Notebook after restore', async () => {
    const order: string[] = [];
    const repositories = {
      coordinate: async (_ref: any, operation: () => Promise<any>) => {
        order.push('lock');
        try { return await operation(); } finally { order.push('unlock'); }
      },
      restore: async () => { order.push('restore'); return { restored: true }; },
    };
    const tracker = {
      getTabId: () => 17,
      quiesceTab: async () => { order.push('flush'); return true; },
      resumeTab: async () => { order.push('resume'); return true; },
      reloadTab: async () => { order.push('reload'); return true; },
    };
    const result = await repositoryVersionTool.execute(
      { op: 'restore', to: 'abc123' },
      actorContext(repositories, { actorType: 'notebook', jsTabTracker: tracker }) as any,
    );
    expect(result.ok).toBe(true);
    expect(order).toEqual(['flush', 'lock', 'restore', 'unlock', 'reload']);
  });

  test('flushes a live Notebook before checkpoint-and-push', async () => {
    const order: string[] = [];
    const remote = { url: 'https://github.com/owner/repo.git', host: 'github.com' };
    const repositories = {
      getRemote: async () => remote,
      coordinate: async (_ref: any, operation: () => Promise<any>) => {
        order.push('lock');
        try { return await operation(); } finally { order.push('unlock'); }
      },
      commit: async () => { order.push('checkpoint'); return { created: true }; },
      push: async () => { order.push('push'); return { ok: true }; },
    };
    const tracker = {
      getTabId: () => 17,
      quiesceTab: async () => { order.push('flush'); return true; },
      resumeTab: async () => { order.push('resume'); return true; },
    };
    const result = await repositoryRemoteTool.execute(
      { op: 'push' },
      actorContext(repositories, { actorType: 'notebook', jsTabTracker: tracker }) as any,
    );
    expect(result.ok).toBe(true);
    expect(order).toEqual(['flush', 'lock', 'checkpoint', 'push', 'unlock', 'resume']);
  });
});
