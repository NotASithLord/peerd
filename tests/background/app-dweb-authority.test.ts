import { describe, expect, test } from 'bun:test';
import { createAppDwebAuthority, AppDwebAuthorityChangedError } from '../../extension/background/app-dweb-authority.js';
import { makeKernelAppEditorRoutes } from '../../extension/background/kernel-app-file-reader.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const setup = (overrides: Record<string, any> = {}) => {
  const stored: Record<string, any> = {};
  const calls: string[] = [];
  const storage = {
    get: async () => ({ ...stored }),
    set: async (values: Record<string, any>) => { calls.push('persist'); Object.assign(stored, values); },
  };
  const authority = createAppDwebAuthority({
    storage,
    tabIds: async () => [7],
    stopTab: async () => { calls.push('stop'); },
    closeTab: async () => { calls.push('close'); },
    purgeOwners: async () => { calls.push('purge'); },
    ...overrides,
  });
  return { authority, stored, calls, storage };
};

describe('shared kernel App consent authority', () => {
  test('intentional close does not stale the mutation token but a successor document retires again', async () => {
    const state = setup();
    let closing: Promise<unknown> | undefined;
    const token = await state.authority.run('app-1', async () => {
      closing = state.authority.retire('app-1', 7);
      return state.authority.generation('app-1');
    }, { invalidate: true });
    await closing;
    expect(token).toBe(1);
    expect(state.authority.generation('app-1')).toBe(token);
    state.authority.activateTab('app-1', 7);
    await state.authority.retire('app-1', 7);
    expect(state.authority.generation('app-1')).toBe(2);
  });
  test('persists rotation and drains room owners before changing App bytes', async () => {
    const purge = deferred();
    const state = setup({ purgeOwners: async () => { state.calls.push('purge'); await purge.promise; } });
    const changing = state.authority.run('app-1', async () => { state.calls.push('write'); }, { invalidate: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.calls).toEqual(['persist', 'stop', 'purge']);
    expect(state.stored['app.dweb-generation.app-1']).toBe(1);
    purge.resolve();
    await changing;
    expect(state.calls).toEqual(['persist', 'stop', 'purge', 'write']);
  });

  test('a failed bridge stop closes that tab, purges owners, and refuses the mutation', async () => {
    const state = setup({ stopTab: async () => { throw new Error('bridge unreachable'); } });
    await expect(state.authority.run('app-1', async () => { state.calls.push('write'); }, { invalidate: true }))
      .rejects.toThrow('bridge unreachable');
    expect(state.calls).toEqual(['persist', 'close', 'purge']);
  });

  test('failed persistence cannot dispatch bridge cleanup or mutate bytes', async () => {
    const state = setup({ storage: { get: async () => ({}), set: async () => { throw new Error('storage unavailable'); } } });
    await expect(state.authority.run('app-1', async () => { state.calls.push('write'); }, { invalidate: true }))
      .rejects.toThrow('storage unavailable');
    expect(state.calls).toEqual([]);
  });

  test('a successor kernel refuses an old conflict approval after durable rotation', async () => {
    const state = setup();
    await state.authority.run('app-1', async () => {}, { invalidate: true });
    const successor = setup({ storage: state.storage });
    await expect(successor.authority.run('app-1', async () => {}, { expectedGeneration: 0 }))
      .rejects.toBeInstanceOf(AppDwebAuthorityChangedError);
    expect(await successor.authority.snapshot()).toEqual({ 'app.dweb-generation.app-1': 1 });
  });

  test('cold editor mutation waits behind the same admitted App operation as rich clients', async () => {
    const state = setup();
    const release = deferred();
    const entered = deferred();
    const reading = state.authority.run('app-1', async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const routes = makeKernelAppEditorRoutes({
      vault: { isLocked: () => false },
      catalog: { get: async () => ({ id: 'app-1', entryFile: 'index.html', fileKinds: {} }), setFileKinds: async () => ({}) },
      files: { readBytes: async () => new Uint8Array(), writeText: async () => { state.calls.push('write'); } },
      repositories: { coordinate: async (_ref: any, operation: any) => { state.calls.push('repository'); return operation(); } },
      withAppDwebAuthority: state.authority.run,
      isAppSender: () => true,
    });
    const writing = routes['app/editor-write']({ appId: 'app-1', path: 'main.js', content: 'code' }, {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.calls).toEqual([]);
    release.resolve();
    await reading;
    await expect(writing).resolves.toEqual({ ok: true });
    expect(state.calls).toEqual(['persist', 'stop', 'purge', 'repository', 'write']);
    state.calls.length = 0;
    await expect(routes['app/editor-write']({
      appId: 'app-1', path: 'data/state.json', content: '{}', runtimeData: true,
    }, {})).resolves.toEqual({ ok: true });
    expect(state.calls).toEqual(['repository', 'write']);
    expect(state.authority.generation('app-1')).toBe(1);
    await expect(routes['app/editor-write']({
      appId: 'app-1', path: 'main.js', content: '{}', runtimeData: true,
    }, {})).resolves.toEqual({ ok: false, error: 'app-data-unauthorized' });
  });
});
