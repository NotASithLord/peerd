import { describe, test, expect } from 'bun:test';
import { makeEngineRoutes } from '../../extension/background/routes/engine.js';
import { listOffscreenContexts } from '../../extension/background/offscreen-contexts.js';

class ArtifactTooLargeError extends Error {}
class EnvelopeFormatError extends Error {}
class EnvelopeIntegrityError extends Error {}

const baseDeps = (over: any = {}) => ({
  vault: { isLocked: () => false },
  auditLog: { append: async () => {} },
  pushState: () => {},
  browser: {
    runtime: { getContexts: async () => [], sendMessage: async () => ({ ok: true }) },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  },
  // #53: engine's sw/web-fetch now delegates to the vm-net vmHttpFetch factory
  // (cache + host-bound git-auth + body cap + base64 — those are covered by
  // tests/peerd-engine/vm-net/vm-http-fetch.test.ts). engine.js only validates
  // the url and wraps EgressDeniedError, so the route's own tests inject vmHttpFetch.
  vmHttpFetch: async () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, bodyB64: btoa('hello') }),
  appRegistry: {
    get: async (id: string) => (id === 'a1' ? { id, name: 'App', entryFile: 'index.html' } : null),
    update: async (id: string, patch: any) => (id === 'a1' ? { id, ...patch } : null),
    list: async () => [{ id: 'a1' }],
  },
  vmRegistry: { get: async (id: string) => (id === 'v1' ? { id, name: 'VM' } : null), create: async () => ({ id: 'vNew' }) },
  jsRegistry: { get: async () => null, create: async () => ({ id: 'nNew' }) },
  appClient: {
    open: async () => {},
    create: async () => ({ id: 'imported' }),
    snapshotFiles: async () => ({
      record: { id: 'a1', name: 'App', entryFile: 'index.html', fileKinds: { 'index.html': 'text' } },
      files: { 'index.html': new TextEncoder().encode('<h1>x</h1>') },
    }),
  },
  appTabTracker: { reloadTab: async () => {} },
  opfsHelpers: () => ({ list: async () => [], read: async () => '', readBytes: async () => new Uint8Array(), write: async () => {} }),
  NOTEBOOK_OPFS_ROOT: 'peerd-notebooks',
  IMAGE_PIN_STORAGE_KEY: 'vm.imagePins',
  buildAppExport: async () => ({ env: 'app' }),
  buildNotebookExport: async () => ({ env: 'nb' }),
  buildVmRecipeExport: async () => ({ env: 'vm' }),
  openEnvelope: async () => ({ kind: 'app', name: 'X', entry: 'i.html', files: {}, meta: { tags: [] } }),
  inspectEnvelope: async () => ({ ok: true, summary: 'x' }),
  exportFilename: (name: string, kind: string) => `${name}.${kind}.peerd`,
  ArtifactTooLargeError, EnvelopeFormatError, EnvelopeIntegrityError,
  settingsStore: { get: () => ({ dwebEnabled: false }) },
  DWEB_ENABLED: false,
  withDwebPublication: async (operation: (isCurrent: () => boolean) => Promise<any>) => operation(() => true),
  withAppLifecycle: async (_appId: string, operation: () => Promise<any>) => operation(),
  listOffscreenContexts,
  // The SW always injects the extract post-step (a passthrough when extract is
  // absent — that contract is pinned in tests/shared/fetch-extract.test.ts).
  applyWebExtract: async (resp: any) => resp,
  ...over,
});

describe('sw/web-fetch', () => {
  test('rejects empty url', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['sw/web-fetch']({ url: '' })).toEqual({ ok: false, error: 'url-required' });
  });
  test('returns base64 body + status', async () => {
    const r = makeEngineRoutes(baseDeps());
    const res = await r['sw/web-fetch']({ url: 'https://x' });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(atob(res.bodyB64)).toBe('hello');
  });
  test('denylisted egress surfaces a clear error', async () => {
    const err: any = new Error('blocked.example'); err.name = 'EgressDeniedError';
    const r = makeEngineRoutes(baseDeps({ vmHttpFetch: async () => { throw err; } }));
    expect(await r['sw/web-fetch']({ url: 'https://blocked.example' })).toEqual({ ok: false, error: 'denylisted: blocked.example' });
  });
  test('passes a vmHttpFetch error result (e.g. over-cap body) straight through', async () => {
    const r = makeEngineRoutes(baseDeps({ vmHttpFetch: async () => ({ ok: false, error: 'body too large: 53477376B > 52428800B' }) }));
    const res = await r['sw/web-fetch']({ url: 'https://x' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('body too large');
  });

  // Design 02, 2a: the Notebook tab's code-mode bridge widened this route with
  // an `extract` post-step (the SAME shared/fetch-extract.js step the headless
  // host applies locally). The SW composes it as deps.applyWebExtract; the
  // route only threads { resp, extract, url } through — pinned here.
  test('extract rides to the injected applyWebExtract post-step (Notebook tab relay)', async () => {
    let seen: any = null;
    const r = makeEngineRoutes(baseDeps({
      applyWebExtract: async (resp: any, extract: unknown, url: string) => {
        seen = { extract, url };
        return { ...resp, bodyB64: btoa('# md'), extracted: true };
      },
    }));
    const res = await r['sw/web-fetch']({ url: 'https://site.example/post', extract: 'markdown' });
    expect(seen).toEqual({ extract: 'markdown', url: 'https://site.example/post' });
    expect(res.extracted).toBe(true);
    expect(atob(res.bodyB64)).toBe('# md');
  });

  test('without extract the step sees undefined and the response is untouched — the VM path', async () => {
    let seenExtract: unknown = 'sentinel';
    const withStep = makeEngineRoutes(baseDeps({
      applyWebExtract: async (resp: any, extract: unknown) => {
        // the real step is a no-op passthrough when extract is absent
        seenExtract = extract;
        return resp;
      },
    }));
    const raw = await withStep['sw/web-fetch']({ url: 'https://x' });
    expect(atob(raw.bodyB64)).toBe('hello');
    expect(raw.extracted).toBeUndefined();
    expect(seenExtract).toBeUndefined();
  });

  test('a run-scoped fetch needs exact offscreen provenance and a live owner capability', async () => {
    let fetched = false;
    let admissions = 0;
    const controller = new AbortController();
    const routes = makeEngineRoutes(baseDeps({
      vmHttpFetch: async () => { fetched = true; return { ok: true }; },
      isOffscreenSender: (sender: any) => sender?.url === 'offscreen',
      scriptRuns: {
        ownerFor: () => 'owner-1',
        allows: () => true,
        admitOp: () => { admissions += 1; return true; },
        signalFor: () => controller.signal,
      },
    }));
    const forged = await (routes['sw/web-fetch'] as any)({
      url: 'https://example.com', runId: 'run-1', ownerSessionId: 'owner-1',
    }, { url: 'engine-tab' });
    expect(forged).toEqual({ ok: false, error: 'web_fetch_unknown_finished_foreign_or_over_limit_run' });
    expect(fetched).toBe(false);
    expect(admissions).toBe(0);
  });

  test('Stop aborts an admitted run-scoped fetch through the injected HTTP signal', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const routes = makeEngineRoutes(baseDeps({
      vmHttpFetch: async ({ signal }: any) => {
        seenSignal = signal;
        return await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
      isOffscreenSender: (sender: any) => sender?.url === 'offscreen',
      scriptRuns: {
        ownerFor: () => 'owner-1',
        allows: (_runId: string, cap: string) => cap === 'egress',
        admitOp: () => true,
        signalFor: () => controller.signal,
      },
    }));
    const pending = (routes['sw/web-fetch'] as any)({
      url: 'https://example.com', runId: 'run-1', ownerSessionId: 'owner-1',
      deadlineAt: Date.now() + 10_000,
    }, { url: 'offscreen' });
    await Promise.resolve();
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: 'aborted' });
    expect(seenSignal?.aborted).toBe(true);
  });

  test('a Notebook can cancel only its own token-bound module fetch', async () => {
    let seenSignal: AbortSignal | undefined;
    const notebookUrl = 'moz-extension://test/engine-tabs/notebook-tab/index.html#n1';
    const routes = makeEngineRoutes(baseDeps({
      browser: {
        runtime: {
          getURL: (path: string) => `moz-extension://test/${path}`,
          getContexts: async () => [], sendMessage: async () => ({ ok: true }),
        },
        storage: { local: { get: async () => ({}), set: async () => {} } },
      },
      vmHttpFetch: async ({ signal }: any) => {
        seenSignal = signal;
        return await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    }));
    const sender = { tab: { id: 41, url: notebookUrl }, url: notebookUrl };
    const pending = (routes['sw/web-fetch'] as any)({
      url: 'https://modules.example/a.js', noCache: true,
      abortToken: 'token-1', notebookId: 'n1',
    }, sender);
    await Promise.resolve();
    expect(await (routes['sw/web-fetch-abort'] as any)(
      { abortToken: 'token-1', notebookId: 'n2' }, {
        tab: { id: 99, url: 'moz-extension://test/engine-tabs/notebook-tab/index.html#n2' },
        url: 'moz-extension://test/engine-tabs/notebook-tab/index.html#n2',
      },
    )).toEqual({ ok: true, aborted: false });
    expect(await (routes['sw/web-fetch-abort'] as any)(
      { abortToken: 'token-1', notebookId: 'n1' }, sender,
    )).toEqual({ ok: true, aborted: true });
    expect(await pending).toEqual({ ok: false, error: 'aborted' });
    expect(seenSignal?.aborted).toBe(true);

    const deadlinePending = (routes['sw/web-fetch'] as any)({
      url: 'https://modules.example/slow.js', noCache: true,
      abortToken: 'token-2', notebookId: 'n1', deadlineAt: Date.now() + 10,
    }, sender);
    expect(await deadlinePending).toEqual({ ok: false, error: 'aborted' });
    expect(seenSignal?.aborted).toBe(true);
    expect(await (routes['sw/web-fetch-abort'] as any)(
      { abortToken: 'token-2', notebookId: 'n1' }, sender,
    )).toEqual({ ok: true, aborted: false });
  });
});

describe('app/vm meta + apps Library', () => {
  test('app/get-meta unknown → app-not-found', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['app/get-meta']({ appId: 'zzz' })).toEqual({ ok: false, error: 'app-not-found' });
  });
  test('app/get-meta returns name, entry, file kinds, and dweb metadata', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['app/get-meta']({ appId: 'a1' })).toEqual({
      ok: true,
      name: 'App',
      entryFile: 'index.html',
      fileKinds: {},
      dweb: null,
    });
  });
  test('vm/get-meta requires a string id', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['vm/get-meta']({ vmId: 5 })).toEqual({ ok: false, error: 'vmId-required' });
  });
  test('apps/list refused when locked', async () => {
    const r = makeEngineRoutes(baseDeps({ vault: { isLocked: () => true } }));
    expect(await r['apps/list']()).toEqual({ ok: false, error: 'vault-locked' });
  });
  test('apps/favorite requires a boolean', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['apps/favorite']({ appId: 'a1', favorite: 'yes' })).toEqual({ ok: false, error: 'favorite-boolean-required' });
  });
  test('apps/rename trims + caps the name', async () => {
    const r = makeEngineRoutes(baseDeps());
    const res = await r['apps/rename']({ appId: 'a1', name: '  Renamed  ' });
    expect(res).toEqual({ ok: true, app: { id: 'a1', name: 'Renamed' } });
  });
});

describe('apps/delete', () => {
  test('unknown id → app-not-found', async () => {
    const r = makeEngineRoutes(baseDeps({ appClient: { delete: async () => false } }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: false, error: 'app-not-found' });
  });
  test('deletes locally without an unshare when dweb is off', async () => {
    let unshared = false;
    const r = makeEngineRoutes(baseDeps({
      appRegistry: { get: async () => ({ id: 'a1', name: 'A', shared: true }) },
      appClient: { delete: async () => true },
      browser: { runtime: { sendMessage: async () => { unshared = true; } }, storage: { local: { get: async () => ({}) } } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(unshared).toBe(false); // DWEB_ENABLED false → no offscreen round-trip
  });
  test('un-shares a shared app when dweb is on', async () => {
    let msg: any = null;
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      settingsStore: { get: () => ({ dwebEnabled: true }) },
      appRegistry: { get: async () => ({ id: 'a1', name: 'A', shared: true, dweb: { publisher: 'pub', hash: 'h', slug: 'custom-a', local: true } }) },
      appClient: { delete: async () => true },
      listOffscreenContexts: async () => [{}],
      browser: { runtime: { getContexts: async () => [{}], sendMessage: async (m: any) => { msg = m; return { ok: true }; } } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(msg).toEqual({
      type: 'dweb/base-host/unshare-app', appId: 'a1', name: 'A', slug: 'custom-a',
      publisher: 'pub', unpublish: true, hash: 'h', hashes: ['h'],
    });
  });
  test('disabled dweb still revokes a networked App from a surviving host before delete', async () => {
    const events: string[] = [];
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      settingsStore: { get: () => ({ dwebEnabled: false }) },
      appRegistry: { get: async () => ({ id: 'a1', name: 'A', shared: true, dweb: { local: true, hash: 'h' } }) },
      appClient: { delete: async () => { events.push('delete'); return true; } },
      listOffscreenContexts: async () => [{}],
      browser: { runtime: {
        getContexts: async () => [{}],
        sendMessage: async () => { events.push('unshare'); return { ok: true }; },
      } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(events).toEqual(['unshare', 'delete']);
  });
  test('disabled dweb deletes safely without creating an absent offscreen host', async () => {
    let sent = false;
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      settingsStore: { get: () => ({ dwebEnabled: false }) },
      appRegistry: { get: async () => ({ id: 'a1', name: 'A', shared: true, dweb: { hash: 'h' } }) },
      appClient: { delete: async () => true },
      listOffscreenContexts: async () => [],
      browser: { runtime: {
        getContexts: async () => [],
        sendMessage: async () => { sent = true; return { ok: true }; },
      } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(sent).toBe(false);
  });
  test('Firefox deletes a networked App without probing the absent offscreen API', async () => {
    let sent = false;
    let probed = false;
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      appRegistry: { get: async () => ({ id: 'a1', name: 'A', shared: true, dweb: { hash: 'h' } }) },
      appClient: { delete: async () => true },
      browser: { runtime: {
        getContexts: async () => { probed = true; throw new Error('OFFSCREEN_DOCUMENT is unsupported'); },
        sendMessage: async () => { sent = true; return { ok: true }; },
      } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(probed).toBe(false);
    expect(sent).toBe(false);
  });
  test('un-shares both discovery and room-published versions on delete', async () => {
    let msg: any = null;
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      settingsStore: { get: () => ({ dwebEnabled: true }) },
      appRegistry: { get: async () => ({
        id: 'a1', name: 'A', shared: true,
        dweb: {
          publisher: 'pub', hash: 'main', room_hash: 'room', slug: 'a',
          pending_unserve_hashes: ['older-share'],
          pending_seed_unserve_hashes: ['older-seed'],
        },
      }) },
      appClient: { delete: async () => true },
      listOffscreenContexts: async () => [{}],
      browser: { runtime: { getContexts: async () => [{}], sendMessage: async (message: any) => { msg = message; return { ok: true }; } } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(msg.hashes).toEqual(['main', 'room', 'older-share', 'older-seed']);
  });
  test('deleting an installed App does not tombstone the peer discovery card', async () => {
    let msg: any = null;
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      appRegistry: { get: async () => ({
        id: 'a1', name: 'A', dweb: { publisher: 'peer', hash: 'main', slug: 'a' },
      }) },
      appClient: { delete: async () => true },
      listOffscreenContexts: async () => [{}],
      browser: { runtime: {
        getContexts: async () => [{}],
        sendMessage: async (message: any) => { msg = message; return { ok: true }; },
      } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(msg).toMatchObject({ publisher: 'peer', hash: 'main', unpublish: false });
  });
  test('does NOT unshare a purely-local app even with dweb fully on', async () => {
    let sent = false;
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      settingsStore: { get: () => ({ dwebEnabled: true }) },
      appRegistry: { get: async () => ({ id: 'a1', name: 'A' }) }, // neither dweb nor shared
      appClient: { delete: async () => true },
      browser: { runtime: { sendMessage: async () => { sent = true; } } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(sent).toBe(false); // the (record.dweb || record.shared) gate must skip the offscreen round-trip
  });
  test('unshare failure preserves the local App and its revocation metadata', async () => {
    let deleted = false;
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      settingsStore: { get: () => ({ dwebEnabled: true }) },
      appRegistry: { get: async () => ({ id: 'a1', name: 'A', dweb: {} }) },
      appClient: { delete: async () => { deleted = true; return true; } },
      listOffscreenContexts: async () => [{}],
      browser: { runtime: { getContexts: async () => [{}], sendMessage: async () => { throw new Error('mesh down'); } } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({
      ok: false,
      error: 'Could not stop sharing, so your local App was kept. Try again when the dweb is available.',
    });
    expect(deleted).toBe(false);
  });
});

describe('export/artifact', () => {
  test('id required', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['export/artifact']({ kind: 'app', id: '' })).toEqual({ ok: false, error: 'id-required' });
  });
  test('unknown kind rejected', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['export/artifact']({ kind: 'spaceship', id: 'a1' })).toEqual({ ok: false, error: 'unknown-kind' });
  });
  test('app export returns filename + envelope', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['export/artifact']({ kind: 'app', id: 'a1' })).toEqual({ ok: true, filename: 'App.app.peerd', envelope: { env: 'app' } });
  });
  test('app export preserves every file as bytes, including an unknown suffix', async () => {
    const raw = new Uint8Array([0xff, 0x00, 0xc0]);
    let exported: any = null;
    const r = makeEngineRoutes(baseDeps({
      buildAppExport: async ({ files }: any) => { exported = files; return { env: 'app' }; },
      appClient: {
        snapshotFiles: async () => ({
          record: { name: 'App', entryFile: 'index.html', fileKinds: { 'index.html': 'text', 'model.custom': 'binary' } },
          files: { 'index.html': new TextEncoder().encode('<h1>x</h1>'), 'model.custom': raw },
        }),
      },
    }));
    expect((await r['export/artifact']({ kind: 'app', id: 'a1' })).ok).toBe(true);
    expect(Array.from(exported['model.custom'])).toEqual(Array.from(raw));
  });
  test('vm export without an image pin refuses', async () => {
    const r = makeEngineRoutes(baseDeps());
    const res = await r['export/artifact']({ kind: 'vm', id: 'v1' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no-image-pin');
  });
});

describe('import/apply', () => {
  test('format error mapped to message', async () => {
    const r = makeEngineRoutes(baseDeps({ openEnvelope: async () => { throw new EnvelopeFormatError('bad envelope'); } }));
    expect(await r['import/apply']({ envelope: {} })).toEqual({ ok: false, error: 'bad envelope' });
  });
  test('integrity error mapped to message', async () => {
    const r = makeEngineRoutes(baseDeps({ openEnvelope: async () => { throw new EnvelopeIntegrityError('hash mismatch'); } }));
    expect(await r['import/apply']({ envelope: {} })).toEqual({ ok: false, error: 'hash mismatch' });
  });
  test('app import mints a fresh id', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['import/apply']({ envelope: {} })).toEqual({ ok: true, kind: 'app', id: 'imported' });
  });
  test('app import passes raw bytes to storage without classifying the suffix', async () => {
    const raw = new Uint8Array([0xff, 0x00, 0xc0]);
    let received: any = null;
    const r = makeEngineRoutes(baseDeps({
      appClient: { create: async (opts: any) => { received = opts.files; return { id: 'imported' }; } },
      openEnvelope: async () => ({
        kind: 'app', name: 'X', entry: 'index.html', meta: { tags: [] },
        files: { 'index.html': new TextEncoder().encode('<h1>x</h1>'), 'model.custom': raw },
      }),
    }));
    expect((await r['import/apply']({ envelope: {} })).ok).toBe(true);
    expect(received['index.html']).toBeInstanceOf(Uint8Array);
    expect(Array.from(received['model.custom'])).toEqual(Array.from(raw));
  });
  test('unexpected error rethrown (not swallowed)', async () => {
    const r = makeEngineRoutes(baseDeps({ openEnvelope: async () => { throw new Error('weird'); } }));
    await expect(r['import/apply']({ envelope: {} })).rejects.toThrow('weird');
  });
});
