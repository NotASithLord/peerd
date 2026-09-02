import { describe, expect, test } from 'bun:test';
import {
  createKernelAppFileReader,
  makeKernelAppEditorRoutes,
} from '../../extension/background/kernel-app-file-reader.js';
import { makeKernelComposerRoutes } from '../../extension/background/kernel-composer-routes.js';

const appFiles = (overrides: Record<string, any> = {}) => ({
  listApp: async () => [],
  listAppInfo: async () => [],
  readText: async () => '',
  readBytes: async () => new Uint8Array(),
  write: async () => {},
  writeText: async () => {},
  deleteFile: async () => {},
  ...overrides,
});

describe('native kernel App file picker', () => {
  test('resolves the active App before crossing the demand-owned file channel', async () => {
    const calls: string[] = [];
    const reader = createKernelAppFileReader({
      idb: { get: async () => ({
        key: 'apps.v1',
        value: {
          schemaVersion: 1,
          apps: { 'app-1': { id: 'app-1' } },
          sessionDefaults: { chat: 'app-1' },
        },
      }) },
      sessionCache: { sessionGet: async () => 'chat' },
      appFiles: appFiles({
        listApp: async (appId: string) => {
          calls.push(appId);
          return ['/index.html', '/assets/logo.png', '/assets/nested/data.json'];
        },
      }),
    });
    await expect(reader.list()).resolves.toEqual([
      '/index.html', '/assets/logo.png', '/assets/nested/data.json',
    ]);
    expect(calls).toEqual(['app-1']);
  });

  test('forwards exact App reads to the authenticated file facade', async () => {
    const calls: any[] = [];
    const reader = createKernelAppFileReader({
      idb: { get: async () => null }, sessionCache: { sessionGet: async () => null },
      appFiles: appFiles({
        readText: async (...args: any[]) => {
          calls.push(args);
          return 'manifest-body';
        },
      }),
    });
    await expect(reader.readText('app-1', 'nested/peerd.json')).resolves.toBe('manifest-body');
    expect(calls).toEqual([['app-1', 'nested/peerd.json']]);
  });

  test('locked and failed reads preserve the empty-picker UX without storage leakage', async () => {
    let reads = 0;
    const routes = makeKernelComposerRoutes({
      browser: { tabs: { query: async () => [] } },
      kv: { list: async () => ({}) }, idb: { get: async () => null },
      sessionCache: { sessionGet: async () => null },
      vault: { isLocked: () => true },
      denylist: {
        ready: async () => ({ ok: true }), blocks: () => false, patterns: () => [],
        snapshot: async () => ({ ok: true, patterns: [] }),
      },
      commands: { list: async () => [] },
      appFiles: { list: async () => { reads += 1; throw new Error('OPFS unavailable'); } },
    });
    await expect(routes['composer/files']()).resolves.toEqual({ ok: true, files: [] });
    expect(reads).toBe(0);
    const unlocked = makeKernelComposerRoutes({
      browser: { tabs: { query: async () => [] } },
      kv: { list: async () => ({}) }, idb: { get: async () => null },
      sessionCache: { sessionGet: async () => null },
      vault: { isLocked: () => false },
      denylist: {
        ready: async () => ({ ok: true }), blocks: () => false, patterns: () => [],
        snapshot: async () => ({ ok: true, patterns: [] }),
      },
      commands: { list: async () => [] },
      appFiles: { list: async () => { reads += 1; throw new Error('OPFS unavailable'); } },
    });
    await expect(unlocked['composer/files']()).resolves.toEqual({ ok: true, files: [] });
    expect(reads).toBe(1);
  });

  test('editor routes preserve bytes, repository ordering, sender authority, and reload UX', async () => {
    const calls: any[] = [];
    let bytes: Uint8Array | null = new TextEncoder().encode('old');
    let kinds: Record<string, 'text' | 'binary'> = { 'index.html': 'text' };
    const files = {
      readText: async () => new TextDecoder().decode(bytes ?? new Uint8Array()),
      readBytes: async () => {
        if (!bytes) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
        return new Uint8Array(bytes);
      },
      listAppInfo: async () => [{ path: '/index.html', size: bytes?.byteLength ?? 0 }],
      writeText: async (_appId: string, path: string, content: string) => {
        calls.push(['writeText', path, content]);
        bytes = new TextEncoder().encode(content);
      },
      write: async (_appId: string, path: string, value: Uint8Array) => {
        calls.push(['restore', path]);
        bytes = new Uint8Array(value);
      },
      deleteFile: async (_appId: string, path: string) => {
        calls.push(['delete', path]);
        if (!bytes) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
        bytes = null;
      },
    } as any;
    const catalog = {
      get: async (id: string) => id === 'app-1'
        ? { id, entryFile: 'main.html', fileKinds: kinds } : null,
      setFileKinds: async (_id: string, next: typeof kinds) => {
        calls.push(['catalog', structuredClone(next)]);
        kinds = structuredClone(next);
        return { id: 'app-1', fileKinds: kinds };
      },
    };
    const routes = makeKernelAppEditorRoutes({
      vault: { isLocked: () => false }, catalog, files,
      repositories: { coordinate: async (_ref: any, operation: () => Promise<any>) => {
        calls.push(['coordinate:start']);
        const value = await operation();
        calls.push(['coordinate:end']);
        return value;
      } },
      isAppSender: (sender: unknown, appId: string) => sender === 'exact-app' && appId === 'app-1',
      reloadApp: async (appId: string) => { calls.push(['reload', appId]); },
    });
    await expect(routes['app/editor/read']({ appId: 'app-1', path: 'index.html' }))
      .resolves.toEqual({ ok: true, content: 'old' });
    await expect(routes['app/editor-write']({
      appId: 'app-1', path: 'data/document.json', content: '{}', runtimeData: true,
    }, 'forged')).resolves.toEqual({ ok: false, error: 'app-data-unauthorized' });
    await expect(routes['app/editor-write']({
      appId: 'app-1', path: '../secret', content: '{}', runtimeData: true,
    }, 'exact-app')).resolves.toEqual({ ok: false, error: 'app-data-unauthorized' });
    await expect(routes['app/editor-write']({
      appId: 'app-1', path: 'data/document.json', content: '{"ok":true}', runtimeData: true,
    }, 'exact-app')).resolves.toEqual({ ok: true });
    expect(calls.slice(0, 4)).toEqual([
      ['coordinate:start'],
      ['writeText', 'data/document.json', '{"ok":true}'],
      ['catalog', { 'index.html': 'text', 'data/document.json': 'text' }],
      ['coordinate:end'],
    ]);
    await expect(routes['app/editor/delete']({ appId: 'app-1', path: 'main.html' }))
      .resolves.toEqual({ ok: false, error: 'refusing to delete entry file: main.html' });
    await expect(routes['app/editor/write']({
      appId: 'app-1', path: 'main.css', content: 'body{}',
    })).resolves.toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toContainEqual(['reload', 'app-1']);
  });

  test('editor routes fail locked before OPFS, catalog mutation, or repository startup', async () => {
    let calls = 0;
    const routes = makeKernelAppEditorRoutes({
      vault: { isLocked: () => true },
      catalog: { get: async () => { calls += 1; }, setFileKinds: async () => null },
      files: {} as any,
      repositories: { coordinate: async () => { calls += 1; } },
      isAppSender: () => true,
    });
    await expect(routes['app/editor/write']({ appId: 'app-1', path: 'a', content: 'b' }))
      .resolves.toEqual({ ok: false, error: 'vault-locked' });
    expect(calls).toBe(0);
  });

  test('editor routes preserve unknown mutation custody and never attempt catalog rollback', async () => {
    let catalogWrites = 0;
    const unknown = Object.assign(new Error('write settlement lost'), {
      code: 'repository-host-timeout', outcomeKnown: false,
    });
    const routes = makeKernelAppEditorRoutes({
      vault: { isLocked: () => false },
      catalog: {
        get: async () => ({ id: 'app-1', entryFile: 'index.html', fileKinds: {} }),
        setFileKinds: async () => { catalogWrites += 1; },
      },
      files: {
        readBytes: async () => { throw Object.assign(new Error('missing'), { name: 'NotFoundError' }); },
        writeText: async () => { throw unknown; },
      },
      repositories: { coordinate: async (_ref: any, operation: () => Promise<any>) => operation() },
      isAppSender: () => true,
    });
    await expect(routes['app/editor/write']({ appId: 'app-1', path: 'main.js', content: 'x' }))
      .resolves.toEqual({
        ok: false,
        code: 'repository-host-timeout',
        error: 'write settlement lost',
        outcomeKnown: false,
        outcomeKind: 'unknown',
      });
    expect(catalogWrites).toBe(0);
  });
});
