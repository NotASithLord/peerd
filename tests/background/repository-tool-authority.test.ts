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
      call: { name: 'repo_version', args: { op: 'checkpoint' } },
      ctx: repositoryContext(repositories, { appQuiescence }), signal,
    });
    await authority.checkpoint('checkpoint');
    expect(order).toEqual(['flush', 'close', 'lock', 'checkpoint', 'unlock', 'reopen']);
  });

  test('does not quiesce an App for fetch but does for push', async () => {
    const order: string[] = [];
    const remote = { url: 'https://github.com/owner/repo.git', host: 'github.com' };
    const repositories = {
      getRemote: async () => remote,
      coordinate: async (_ref: any, operation: () => Promise<any>) => {
        order.push('lock');
        try { return await operation(); }
        finally { order.push('unlock'); }
      },
      fetch: async () => { order.push('fetch'); return { fetched: true }; },
      commit: async () => { order.push('checkpoint'); return { created: true }; },
      push: async () => { order.push('push'); return { ok: true }; },
    };
    const appQuiescence = {
      run: async (_id: string, operation: () => Promise<any>) => {
        order.push('quiesce');
        const result = await operation();
        order.push('resume');
        return result;
      },
    };

    const fetchAuthority = createRepositoryToolAuthority({
      call: { name: 'repo_remote', args: { op: 'fetch' } },
      ctx: repositoryContext(repositories, { confirm: async () => true, appQuiescence }), signal,
    });
    await fetchAuthority.readRemote();
    await fetchAuthority.confirmRemote('fetch', remote.url, undefined);
    await fetchAuthority.fetch(remote.url);
    expect(order).toEqual(['lock', 'fetch', 'unlock']);

    order.length = 0;
    const pushAuthority = createRepositoryToolAuthority({
      call: { name: 'repo_remote', args: { op: 'push' } },
      ctx: repositoryContext(repositories, { confirm: async () => true, appQuiescence }), signal,
    });
    await pushAuthority.readRemote();
    await pushAuthority.confirmRemote('push', remote.url, undefined);
    await pushAuthority.push(remote.url, undefined);
    expect(order).toEqual(['quiesce', 'lock', 'checkpoint', 'push', 'unlock', 'resume']);
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
    const authority = createRepositoryToolAuthority({
      call: { name: 'repo_version', args: { op: 'restore', to: 'abc123' } },
      ctx: repositoryContext(repositories, {
        actorType: 'notebook', jsTabTracker: tracker, confirm: async () => true,
      }),
      signal,
    });
    await authority.confirmRestore('abc123');
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
    const authority = createRepositoryToolAuthority({
      call: { name: 'repo_remote', args: { op: 'push' } },
      ctx: repositoryContext(repositories, {
        confirm: async () => true,
        appQuiescence: { run: async (_id: string, operation: () => Promise<any>) => operation() },
      }),
      signal,
    });
    const approved = await authority.readRemote();
    await authority.confirmRemote('push', approved.url, undefined);
    await expect(authority.push(approved.url, undefined))
      .rejects.toThrow('remote changed while authorization was pending');
    expect(pushed).toBe(false);
  });

  test('rejects a mismatched named call before touching repository authority', async () => {
    let touched = false;
    const authority = createRepositoryToolAuthority({
      call: { name: 'repo_version', args: { op: 'checkpoint' } },
      ctx: repositoryContext({ status: async () => { touched = true; } }), signal,
    });
    expect(() => authority.readStatus()).toThrow('repository authority mismatch');
    expect(touched).toBe(false);
  });
});
