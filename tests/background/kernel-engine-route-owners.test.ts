import { describe, expect, test } from 'bun:test';
import {
  makeKernelAppDeleteRoutes,
  makeKernelArtifactRoutes,
  makeKernelPodRoutes,
  makeKernelWebFetchRoutes,
} from '../../extension/background/kernel-engine-route-owners.js';

class ArtifactTooLargeError extends Error {}
class EnvelopeFormatError extends Error {}
class EnvelopeIntegrityError extends Error {}

const deps = (over: any = {}) => ({
  isAllowed: () => true,
  vault: { isLocked: () => false },
  auditLog: { append: async () => {} },
  pushState: () => {},
  browser: {
    runtime: {
      getURL: (path: string) => `moz-extension://peerd/${path}`,
      getContexts: async () => [], sendMessage: async () => ({ ok: true }),
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  },
  vmHttpFetch: async () => ({ ok: true, status: 200, bodyB64: btoa('ok') }),
  appRegistry: {
    get: async (id: string) => id === 'app-1' ? { id, name: 'App' } : null,
    list: async () => [], update: async () => null,
  },
  vmRegistry: { get: async () => null, create: async () => ({ id: 'vm-new' }) },
  jsRegistry: { get: async () => null, create: async () => ({ id: 'notebook-new' }) },
  podRegistry: {
    get: async (id: string) => id === 'pod-1'
      ? { id, name: 'Pod', persistent: true } : null,
  },
  podTabTracker: { getTabId: (id: string) => id === 'pod-1' ? 9 : null },
  appClient: {
    create: async () => ({ id: 'app-new' }), delete: async () => true,
    snapshotFiles: async () => ({ record: { name: 'App' }, files: {} }),
  },
  appTabTracker: { getTabId: () => null, parseIdFromUrl: () => null },
  appQuiescence: { run: async (_id: string, operation: Function) => operation() },
  opfsHelpers: () => ({
    list: async () => [], read: async () => '', readBytes: async () => new Uint8Array(),
    write: async () => {},
  }),
  NOTEBOOK_OPFS_ROOT: 'notebooks', IMAGE_PIN_STORAGE_KEY: 'pins',
  artifactEngine: {
    buildAppExport: async () => ({ kind: 'app-envelope' }),
    buildNotebookExport: async () => ({}), buildVmRecipeExport: async () => ({}),
    openEnvelope: async () => ({
      kind: 'app', name: 'Imported', entry: 'index.html', files: {}, fileKinds: {},
      meta: { tags: [] },
    }),
    inspectEnvelope: async () => ({ ok: true, summary: 'safe' }),
    exportFilename: (name: string) => `${name}.peerd`,
  },
  ArtifactTooLargeError, EnvelopeFormatError, EnvelopeIntegrityError,
  settingsStore: { get: () => ({}) }, DWEB_ENABLED: false,
  applyWebExtract: async (response: any) => response,
  withDwebPublication: async (operation: Function) => operation(),
  withAppLifecycle: async (_id: string, operation: Function) => operation(),
  listOffscreenContexts: async () => [],
  scriptRuns: null,
  isOffscreenSender: () => false,
  awaitDenylistPolicy: async () => {}, assertOpfsWritable: async () => {},
  repositories: { coordinate: async (_ref: any, operation: Function) => operation() },
  parseAppManifest: () => ({}), podGitRemoteOperation: () => null,
  getCurrentSessionId: async () => null, onAppDeleted: async () => {},
  ...over,
});

describe('kernel engine route owners', () => {
  test('refuses provenance before loading rich engine dependencies', async () => {
    let loads = 0;
    const pod = makeKernelPodRoutes({
      isAllowed: () => false,
      load: async () => { loads += 1; return deps(); },
    });
    expect(await pod['pod/get-meta']({ podId: 'pod-1' }, { tab: { id: 9 } }))
      .toEqual({ ok: false, error: 'pod-route-unauthorized', outcomeKnown: true });
    expect(loads).toBe(0);
  });

  test('pod metadata remains instance-pinned and a lost POST is outcome-unknown', async () => {
    const pod = makeKernelPodRoutes(deps({
      vmHttpFetch: async () => { throw new Error('connection lost'); },
    }));
    expect(await pod['pod/get-meta']({ podId: 'pod-1' }, { tab: { id: 8 } }))
      .toEqual({ ok: false, error: 'pod-sender-not-instance-pinned' });
    expect(await pod['pod/get-meta']({ podId: 'pod-1' }, { tab: { id: 9 } }))
      .toEqual({
        ok: true, record: { id: 'pod-1', name: 'Pod', persistent: true },
      });
    expect(await pod['pod/web-fetch']({
      podId: 'pod-1', url: 'https://example.test/write', method: 'POST',
    }, { tab: { id: 9 } })).toMatchObject({
      ok: false, code: 'engine-network-outcome-unknown', outcomeKnown: false,
    });
  });

  test('web-fetch keeps sender/run custody and preserves unknown network outcomes', async () => {
    const routes = makeKernelWebFetchRoutes(deps({
      isAllowed: (_route: string, _message: any, sender: any) => sender?.url === 'vm',
      vmHttpFetch: async () => { throw new Error('lost'); },
    }));
    expect(await routes['sw/web-fetch']({ url: 'https://example.test' }, { url: 'other' }))
      .toEqual({ ok: false, error: 'web-fetch-route-unauthorized', outcomeKnown: true });
    expect(await routes['sw/web-fetch']({
      url: 'https://example.test', method: 'POST',
    }, { url: 'vm' })).toMatchObject({ ok: false, outcomeKnown: false });
  });

  test('artifact reads preserve the factory contract and imports fence uncertain writes', async () => {
    const routes = makeKernelArtifactRoutes(deps());
    expect(await routes['export/artifact']({ kind: 'app', id: 'app-1' }, {}))
      .toEqual({ ok: true, filename: 'App.peerd', envelope: { kind: 'app-envelope' } });
    expect(await routes['import/inspect']({ envelope: {} }, {}))
      .toEqual({ ok: true, summary: 'safe' });
    expect(await routes['import/apply']({ envelope: {} }, {}))
      .toEqual({ ok: true, kind: 'app', id: 'app-new' });

    const lost = makeKernelArtifactRoutes(deps({
      appClient: {
        create: async () => { throw new Error('commit reply lost'); },
        snapshotFiles: async () => ({ record: { name: 'App' }, files: {} }),
      },
    }));
    expect(await lost['import/apply']({ envelope: {} }, {})).toMatchObject({
      ok: false, code: 'artifact-import-outcome-unknown', outcomeKnown: false,
    });
  });

  test('artifact write refusal is known and app deletion loss cannot be replayed blindly', async () => {
    const refused = makeKernelArtifactRoutes(deps({
      canWrite: () => { throw new Error('profile is read-only'); },
    }));
    await expect(refused['import/apply']({ envelope: {} }, {}))
      .rejects.toThrow('profile is read-only');

    let guards = 0;
    const partial = makeKernelArtifactRoutes(deps({
      canWrite: () => {
        guards += 1;
        if (guards === 2) throw new Error('profile became read-only');
      },
      artifactEngine: {
        ...deps().artifactEngine,
        openEnvelope: async () => ({
          kind: 'notebook', name: 'Imported', entry: '',
          files: { 'index.js': new TextEncoder().encode('') }, fileKinds: {}, meta: {},
        }),
      },
    }));
    expect(await partial['import/apply']({ envelope: {} }, {})).toMatchObject({
      ok: false, code: 'artifact-import-outcome-unknown', outcomeKnown: false,
    });

    const deleted = makeKernelAppDeleteRoutes(deps({
      appClient: { delete: async () => { throw new Error('lost'); } },
    }));
    expect(await deleted['apps/delete']({ appId: 'app-1' }, {})).toMatchObject({
      ok: false, code: 'app-delete-outcome-unknown', outcomeKnown: false,
    });

    const missing = makeKernelAppDeleteRoutes(deps({
      appClient: { delete: async () => false },
    }));
    expect(await missing['apps/delete']({ appId: 'app-1' }, {}))
      .toEqual({ ok: false, error: 'app-not-found' });

    let sends = 0;
    let deletes = 0;
    const deleteRefused = makeKernelAppDeleteRoutes(deps({
      canWrite: () => { throw new Error('profile is read-only'); },
      DWEB_ENABLED: true,
      appRegistry: { get: async () => ({ id: 'app-1', shared: true }) },
      listOffscreenContexts: async () => [{}],
      browser: {
        runtime: {
          getURL: (path: string) => `moz-extension://peerd/${path}`,
          getContexts: async () => [],
          sendMessage: async () => { sends += 1; return { ok: true }; },
        },
        storage: { local: { get: async () => ({}), set: async () => {} } },
      },
      appClient: { delete: async () => { deletes += 1; return true; } },
    }));
    await expect(deleteRefused['apps/delete']({ appId: 'app-1' }, {}))
      .rejects.toThrow('profile is read-only');
    expect({ sends, deletes }).toEqual({ sends: 0, deletes: 0 });
  });
});
