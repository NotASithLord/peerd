import { describe, test, expect } from 'bun:test';
import { makeEngineRoutes } from '../../extension/background/routes/engine.js';

class ArtifactTooLargeError extends Error {}
class EnvelopeFormatError extends Error {}
class EnvelopeIntegrityError extends Error {}

const baseDeps = (over: any = {}) => ({
  vault: { isLocked: () => false },
  auditLog: { append: async () => {} },
  pushState: () => {},
  browser: { storage: { local: { get: async () => ({}), set: async () => {} } } },
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
  appClient: { open: async () => {}, create: async () => ({ id: 'imported' }) },
  appTabTracker: { reloadTab: async () => {} },
  opfsHelpers: () => ({ list: async () => [], read: async () => '', write: async () => {} }),
  NOTEBOOK_OPFS_ROOT: 'peerd-notebooks',
  IMAGE_PIN_STORAGE_KEY: 'vm.imagePins',
  buildAppExport: async () => ({ env: 'app' }),
  buildNotebookExport: async () => ({ env: 'nb' }),
  buildVmRecipeExport: async () => ({ env: 'vm' }),
  openEnvelope: async () => ({ kind: 'app', name: 'X', entry: 'i.html', files: {}, meta: { tags: [] } }),
  inspectEnvelope: async () => ({ ok: true, summary: 'x' }),
  exportFilename: (name: string, kind: string) => `${name}.${kind}.peerd`,
  ArtifactTooLargeError, EnvelopeFormatError, EnvelopeIntegrityError,
  ensureOffscreen: async () => {},
  settingsStore: { get: () => ({ dwebEnabled: false }) },
  DWEB_ENABLED: false,
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
});

describe('app/vm meta + apps Library', () => {
  test('app/get-meta unknown → app-not-found', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['app/get-meta']({ appId: 'zzz' })).toEqual({ ok: false, error: 'app-not-found' });
  });
  test('app/get-meta returns name/entry/dweb', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['app/get-meta']({ appId: 'a1' })).toEqual({ ok: true, name: 'App', entryFile: 'index.html', dweb: null });
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
      appRegistry: { get: async () => ({ id: 'a1', name: 'A', shared: true, dweb: { publisher: 'pub', hash: 'h' } }) },
      appClient: { delete: async () => true },
      browser: { runtime: { sendMessage: async (m: any) => { msg = m; } } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(msg).toEqual({ type: 'dweb/base-host/unshare-app', name: 'A', publisher: 'pub', hash: 'h' });
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
  test('unshare failure never fails the delete', async () => {
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      settingsStore: { get: () => ({ dwebEnabled: true }) },
      appRegistry: { get: async () => ({ id: 'a1', name: 'A', dweb: {} }) },
      appClient: { delete: async () => true },
      browser: { runtime: { sendMessage: async () => { throw new Error('mesh down'); } } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
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
  test('unexpected error rethrown (not swallowed)', async () => {
    const r = makeEngineRoutes(baseDeps({ openEnvelope: async () => { throw new Error('weird'); } }));
    await expect(r['import/apply']({ envelope: {} })).rejects.toThrow('weird');
  });
});
