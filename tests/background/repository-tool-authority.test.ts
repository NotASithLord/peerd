import { describe, expect, test } from 'bun:test';
import { createRepositoryToolAuthority } from '../../extension/background/repository-tool-authority.js';
import { createAppQuiescence } from '../../extension/background/app-quiescence.js';

const signal = new AbortController().signal;

const repositoryContext = (repositories: any, extra: any = {}) => ({
  actorType: 'app', actorInstanceId: 'app-1', repositories, ...extra,
});

describe('repository tool authority', () => {
  test('flushes and closes a live App before a version mutation takes the lock', async () => {
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
    const authority = createRepositoryToolAuthority({
      binding: { operation: 'turn.repository.checkpoint', args: { message: 'checkpoint' } },
      ctx: repositoryContext(repositories, { appQuiescence }), signal,
    });
    await authority.checkpoint('checkpoint');
    expect(order).toEqual(['flush', 'close', 'lock', 'checkpoint', 'unlock', 'reopen']);
  });

  test('does not quiesce an App for fetch but does for push', async () => {
    const order: string[] = [];
    const remote = { url: 'https://github.com/owner/repo.git', host: 'github.com' };
    const networkOptions: any[] = [];
    const repositories = {
      getRemote: async () => remote,
      coordinate: async (_ref: any, operation: () => Promise<any>) => {
        order.push('lock');
        try { return await operation(); }
        finally { order.push('unlock'); }
      },
      fetch: async (_ref: any, options: any) => {
        networkOptions.push(options); order.push('fetch'); return { fetched: true };
      },
      commit: async () => { order.push('checkpoint'); return { created: true }; },
      push: async (_ref: any, options: any) => {
        networkOptions.push(options); order.push('push'); return { ok: true };
      },
    };
    const appQuiescence = {
      run: async (_id: string, operation: () => Promise<any>) => {
        order.push('quiesce');
        const result = await operation();
        order.push('resume');
        return result;
      },
    };

    const ctx = repositoryContext(repositories, { confirm: async () => true, appQuiescence });
    const fetchShared: any = {};
    await createRepositoryToolAuthority({
      binding: { operation: 'turn.repository.read-remote', args: {} },
      ctx, signal, shared: fetchShared,
    }).readRemote();
    await createRepositoryToolAuthority({
      binding: {
        operation: 'turn.repository.confirm-remote',
        args: { op: 'fetch', target: remote.url, branch: undefined },
      },
      ctx, signal, shared: fetchShared,
    }).confirmRemote('fetch', remote.url, undefined);
    await createRepositoryToolAuthority({
      binding: { operation: 'turn.repository.fetch', args: { target: remote.url } },
      ctx, signal, shared: fetchShared,
    }).fetch(remote.url);
    expect(order).toEqual(['lock', 'fetch', 'unlock']);
    expect(networkOptions[0]).toMatchObject({
      expectedRemote: remote.url, signal,
    });

    order.length = 0;
    const pushShared: any = {};
    await createRepositoryToolAuthority({
      binding: { operation: 'turn.repository.read-remote', args: {} },
      ctx, signal, shared: pushShared,
    }).readRemote();
    await createRepositoryToolAuthority({
      binding: {
        operation: 'turn.repository.confirm-remote',
        args: { op: 'push', target: remote.url, branch: undefined },
      },
      ctx, signal, shared: pushShared,
    }).confirmRemote('push', remote.url, undefined);
    await createRepositoryToolAuthority({
      binding: {
        operation: 'turn.repository.push', args: { target: remote.url, branch: undefined },
      },
      ctx, signal, shared: pushShared,
    }).push(remote.url, undefined);
    expect(order).toEqual(['quiesce', 'lock', 'checkpoint', 'push', 'unlock', 'resume']);
    expect(networkOptions[1]).toMatchObject({
      expectedRemote: remote.url, signal,
    });
  });

  test('flushes and reloads a live Notebook after restore', async () => {
    const order: string[] = [];
    const repositories = {
      coordinate: async (_ref: any, operation: () => Promise<any>) => {
        order.push('lock');
        try { return await operation(); }
        finally { order.push('unlock'); }
      },
      restore: async () => { order.push('restore'); return { restored: true }; },
    };
    const tracker = {
      getTabId: () => 17,
      quiesceTab: async () => { order.push('flush'); return true; },
      resumeTab: async () => { order.push('resume'); return true; },
      reloadTab: async () => { order.push('reload'); return true; },
    };
    const ctx = repositoryContext(repositories, {
        actorType: 'notebook', jsTabTracker: tracker, confirm: async () => true,
      });
    const shared: any = {};
    await createRepositoryToolAuthority({
      binding: { operation: 'turn.repository.confirm-restore', args: { to: 'abc123' } },
      ctx, signal, shared,
    }).confirmRestore('abc123');
    const authority = createRepositoryToolAuthority({
      binding: { operation: 'turn.repository.restore', args: { to: 'abc123' } },
      ctx, signal, shared,
    });
    await authority.restore('abc123');
    expect(order).toEqual(['flush', 'lock', 'restore', 'unlock', 'reload']);
  });

  test('rechecks the approved remote under the repository lock', async () => {
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
    const ctx = repositoryContext(repositories, {
        confirm: async () => true,
        appQuiescence: { run: async (_id: string, operation: () => Promise<any>) => operation() },
      });
    const shared: any = {};
    const reader = createRepositoryToolAuthority({
      binding: { operation: 'turn.repository.read-remote', args: {} },
      ctx, signal, shared,
    });
    const approved = await reader.readRemote();
    await createRepositoryToolAuthority({
      binding: {
        operation: 'turn.repository.confirm-remote',
        args: { op: 'push', target: approved.url, branch: undefined },
      },
      ctx, signal, shared,
    }).confirmRemote('push', approved.url, undefined);
    const pusher = createRepositoryToolAuthority({
      binding: {
        operation: 'turn.repository.push', args: { target: approved.url, branch: undefined },
      },
      ctx, signal, shared,
    });
    await expect(pusher.push(approved.url, undefined))
      .rejects.toThrow('remote changed while authorization was pending');
    expect(pushed).toBe(false);
  });

  test('rejects a mismatched named call before touching repository authority', async () => {
    let touched = false;
    const authority = createRepositoryToolAuthority({
      binding: { operation: 'turn.repository.checkpoint', args: { message: 'checkpoint' } },
      ctx: repositoryContext({ status: async () => { touched = true; } }), signal,
    });
    expect(() => authority.readStatus()).toThrow('repository authority mismatch');
    expect(touched).toBe(false);
  });

  test('Stop while queued on the repository lock prevents the mutation', async () => {
    let releaseLock!: () => void;
    let lockEntered!: () => void;
    const lockGate = new Promise<void>((resolve) => { releaseLock = resolve; });
    const entered = new Promise<void>((resolve) => { lockEntered = resolve; });
    const controller = new AbortController();
    let commits = 0;
    const repositories = {
      coordinate: async (_ref: any, operation: () => Promise<any>) => {
        lockEntered();
        await lockGate;
        return operation();
      },
      commit: async () => { commits += 1; return { created: true }; },
    };
    const authority = createRepositoryToolAuthority({
      binding: { operation: 'turn.repository.checkpoint', args: { message: 'checkpoint' } },
      ctx: repositoryContext(repositories, {
        appQuiescence: { run: async (_id: string, operation: () => Promise<any>) => operation() },
      }),
      signal: controller.signal,
    });
    const pending = authority.checkpoint('checkpoint');
    await entered;
    controller.abort();
    releaseLock();
    await expect(pending).rejects.toMatchObject({
      outcomeKnown: true, retryable: false,
    });
    expect(commits).toBe(0);
  });
});
