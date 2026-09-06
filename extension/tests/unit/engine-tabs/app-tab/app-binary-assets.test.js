// @ts-check
// Real-browser coverage for App byte delivery. The direct runner test checks the
// sandbox realm API. The live E2E lane exercises the complete app-tab lifecycle.

import { describe, expect, it } from '../../../framework.js';
import {
  createEditor,
  isBinaryAssetPath,
  opfsHelpers,
} from '/peerd-engine/index.js';
import { createAppClient } from '/background/app-client.js';
import { createAppDataClient, MAX_APP_DATA_BYTES } from '../../../../engine-tabs/app-tab/app-data-client.js';

const VALID_EMPTY_WASM = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const BINARY_TRIPWIRE = [0x00, 0xff, 0xc0, 0x80, 0x7f];

const memoryRegistry = () => {
  const records = new Map();
  /** @type {string[]} */
  const deleted = [];
  let sequence = 0;
  return {
    records,
    deleted,
    create: async (/** @type {any} */ opts) => {
      const record = {
        id: `binary-client-${++sequence}`,
        name: opts.name,
        entryFile: opts.entryFile,
        tags: opts.tags ?? [],
        fileKinds: Object.assign(Object.create(null), opts.fileKinds ?? {}),
      };
      records.set(record.id, record);
      return record;
    },
    get: async (/** @type {string} */ id) => records.get(id) ?? null,
    update: async (/** @type {string} */ id, /** @type {any} */ patch) => {
      const current = records.get(id);
      if (!current) return null;
      const next = { ...current, ...patch };
      records.set(id, next);
      return next;
    },
    delete: async (/** @type {string} */ id) => { deleted.push(id); records.delete(id); return true; },
    setDefaultForSession: async () => {},
    getDefaultForSession: async () => null,
    searchMetadata: async () => [],
    list: async () => Array.from(records.values()),
  };
};

/** @param {Record<string, any>} [overrides] */
const testRepositories = (overrides = {}) => {
  const tails = new Map();
  return {
    coordinate: async (/** @type {{kind:string,id:string}} */ ref, /** @type {() => Promise<any>} */ operation) => {
      const key = `${ref.kind}:${ref.id}`;
      const prior = tails.get(key) ?? Promise.resolve();
      const current = prior.catch(() => {}).then(operation);
      tails.set(key, current);
      try { return await current; }
      finally { if (tails.get(key) === current) tails.delete(key); }
    },
    ...overrides,
  };
};

describe('App storage binary contract', () => {
  it('classifies a Git-imported working tree and keeps unknown binary assets byte-exact', async () => {
    const registry = memoryRegistry();
    /** @type {{ client: ReturnType<typeof createAppClient> | null }} */
    const holder = { client: null };
    const repositories = testRepositories({
      clone: async (/** @type {any} */ ref, /** @type {any} */ options) => {
        const files = holder.client?.opfsForApp(ref.id);
        if (!files) throw new Error('App client is unavailable');
        await files.write('peerd.json', JSON.stringify({
          schema: 1, kind: 'app', entry: 'index.html',
          agent: { kind: 'bound-app', profile: 'developer', surface: 'code' },
          capabilities: [],
        }));
        await files.write('index.html', '<h1>Git App</h1>');
        await files.write('model.custom', new Uint8Array(BINARY_TRIPWIRE));
        return {
          remote: { url: options.url, host: 'github.com' },
          oid: 'abc123', branch: 'main', dirty: false,
        };
      },
      destroy: async () => {},
    });
    const client = createAppClient({
      registry: /** @type {any} */ (registry),
      tracker: /** @type {any} */ ({ reloadTab: async () => {} }),
      repositories: /** @type {any} */ (repositories),
    });
    holder.client = client;
    const result = await client.createFromGit({
      url: 'https://github.com/example/app.git', allowDweb: false,
    });
    if (!result?.record) throw new Error('Git import did not create an App record');
    try {
      expect(result.record.fileKinds['peerd.json']).toBe('text');
      expect(result.record.fileKinds['index.html']).toBe('text');
      expect(result.record.fileKinds['model.custom']).toBe('binary');
      expect(Array.from(await client.readFileBytes({ appId: result.record.id, path: 'model.custom' })))
        .toEqual(BINARY_TRIPWIRE);
    } finally {
      await client.opfsForApp(result.record.id).nuke();
    }
  });

  it('stores base64 as raw bytes and refuses text reads of binary assets', async () => {
    const registry = memoryRegistry();
    const client = createAppClient({
      registry: /** @type {any} */ (registry),
      tracker: /** @type {any} */ ({ reloadTab: async () => {} }),
      repositories: /** @type {any} */ (testRepositories()),
    });
    const record = await client.create({
      name: 'Binary storage',
      files: {
        'index.html': '<h1>x</h1>',
        'asset.bin': { base64: 'AP/AgH8=' },
      },
      entryFile: 'index.html',
    });
    expect(Array.from(await client.readFileBytes({ appId: record.id, path: 'asset.bin' })))
      .toEqual(BINARY_TRIPWIRE);
    let code = '';
    try { await client.readFile({ appId: record.id, path: 'asset.bin' }); }
    catch (error) { code = /** @type {{ code?: string }} */ (error).code ?? ''; }
    expect(code).toBe('binary_asset_not_text');
    await client.opfsForApp(record.id).nuke();
  });

  it('removes the catalog record and partial OPFS tree when create fails', async () => {
    const registry = memoryRegistry();
    const client = createAppClient({
      registry: /** @type {any} */ (registry),
      tracker: /** @type {any} */ ({ reloadTab: async () => {} }),
      repositories: /** @type {any} */ (testRepositories()),
    });
    let failed = false;
    try {
      await client.create({
        name: 'Rollback',
        // The first path creates a file where the second needs a directory.
        files: { 'index.html': '<h1>x</h1>', dir: 'file', 'dir/child.js': 'x' },
        entryFile: 'index.html',
      });
    } catch { failed = true; }
    expect(failed).toBe(true);
    expect(registry.records.size).toBe(0);
    expect(registry.deleted.length).toBe(1);
    await opfsHelpers(['peerd-apps', 'binary-client-1']).nuke();
  });

  it('validates entry changes before writes and rolls bytes back on metadata failure', async () => {
    const registry = memoryRegistry();
    const client = createAppClient({
      registry: /** @type {any} */ (registry),
      tracker: /** @type {any} */ ({ reloadTab: async () => {} }),
      repositories: /** @type {any} */ (testRepositories()),
    });
    const record = await client.create({
      name: 'Atomic', files: { 'index.html': 'old', 'app.js': 'old-js' }, entryFile: 'index.html',
    });
    let invalidFailed = false;
    try {
      await client.update({ appId: record.id, path: 'new.js', content: 'new', entryFile: 'missing.html' });
    } catch { invalidFailed = true; }
    expect(invalidFailed).toBe(true);
    expect(await client.readFile({ appId: record.id, path: 'index.html' })).toBe('old');
    expect((await client.listFiles({ appId: record.id })).some((file) => file.path.replace(/^\/+/, '') === 'new.js')).toBe(false);

    const updateRecord = registry.update;
    let failOnce = true;
    registry.update = async (id, patch) => {
      if (failOnce) { failOnce = false; throw new Error('catalog unavailable'); }
      return updateRecord(id, patch);
    };
    /** @type {any} */
    let metadataFailure = null;
    try {
      await client.update({
        appId: record.id, html: 'changed', path: 'app.js', content: 'changed-js',
      });
    }
    catch (error) { metadataFailure = error; }
    expect({
      performed: metadataFailure?.performed,
      outcomeKnown: metadataFailure?.outcomeKnown,
      outcomeKind: metadataFailure?.outcomeKind,
      retryable: metadataFailure?.retryable,
    }).toEqual({
      performed: false, outcomeKnown: true,
      outcomeKind: 'pre-effect-failure', retryable: true,
    });
    expect(await client.readFile({ appId: record.id, path: 'index.html' })).toBe('old');
    expect(await client.readFile({ appId: record.id, path: 'app.js' })).toBe('old-js');
    await client.opfsForApp(record.id).nuke();
  });

  it('marks an unproven App metadata rollback unknown and nonretryable', async () => {
    const registry = memoryRegistry();
    const client = createAppClient({
      registry: /** @type {any} */ (registry),
      tracker: /** @type {any} */ ({ reloadTab: async () => {} }),
      repositories: /** @type {any} */ (testRepositories()),
    });
    const record = await client.create({
      name: 'Rollback loss', files: { 'index.html': 'old' }, entryFile: 'index.html',
    });
    registry.update = async () => { throw new Error('catalog unavailable'); };
    /** @type {any} */
    let failure = null;
    try { await client.writeFile({ appId: record.id, path: 'index.html', content: 'changed' }); }
    catch (error) { failure = error; }
    expect({
      performed: failure?.performed,
      outcomeKnown: failure?.outcomeKnown,
      outcomeKind: failure?.outcomeKind,
      retryable: failure?.retryable,
    }).toEqual({
      performed: true, outcomeKnown: false,
      outcomeKind: 'host-lost', retryable: false,
    });
    expect(await client.readFile({ appId: record.id, path: 'index.html' })).toBe('old');
    await client.opfsForApp(record.id).nuke();
  });

  it('marks a complete App-tree replacement rollback as proven no-effect', async () => {
    const registry = memoryRegistry();
    const client = createAppClient({
      registry: /** @type {any} */ (registry),
      tracker: /** @type {any} */ ({ reloadTab: async () => {} }),
      repositories: /** @type {any} */ (testRepositories()),
    });
    const record = await client.create({
      name: 'Replace rollback', files: { 'index.html': 'old' }, entryFile: 'index.html',
    });
    const updateRecord = registry.update;
    let failOnce = true;
    registry.update = async (id, patch) => {
      if (failOnce) { failOnce = false; throw new Error('catalog unavailable'); }
      return updateRecord(id, patch);
    };
    /** @type {any} */
    let failure = null;
    try {
      await client.replaceFiles({
        appId: record.id, files: { 'index.html': 'changed' }, entryFile: 'index.html',
      });
    } catch (error) { failure = error; }
    expect({
      performed: failure?.performed,
      outcomeKnown: failure?.outcomeKnown,
      outcomeKind: failure?.outcomeKind,
      retryable: failure?.retryable,
    }).toEqual({
      performed: false, outcomeKnown: true,
      outcomeKind: 'pre-effect-failure', retryable: true,
    });
    expect(await client.readFile({ appId: record.id, path: 'index.html' })).toBe('old');
    await client.opfsForApp(record.id).nuke();
  });

  it('distinguishes proven and unproven delete-file compensation', async () => {
    const completedRegistry = memoryRegistry();
    const completed = createAppClient({
      registry: /** @type {any} */ (completedRegistry),
      tracker: /** @type {any} */ ({ reloadTab: async () => {} }),
      repositories: /** @type {any} */ (testRepositories()),
    });
    const completedRecord = await completed.create({
      name: 'Delete rollback',
      files: { 'index.html': 'old', 'extra.txt': 'keep' }, entryFile: 'index.html',
    });
    const normalUpdate = completedRegistry.update;
    let failOnce = true;
    completedRegistry.update = async (id, patch) => {
      if (failOnce) { failOnce = false; throw new Error('catalog unavailable'); }
      return normalUpdate(id, patch);
    };
    /** @type {any} */ let completedFailure = null;
    try { await completed.deleteFile({ appId: completedRecord.id, path: 'extra.txt' }); }
    catch (error) { completedFailure = error; }
    expect({
      performed: completedFailure?.performed,
      outcomeKnown: completedFailure?.outcomeKnown,
      outcomeKind: completedFailure?.outcomeKind,
      retryable: completedFailure?.retryable,
    }).toEqual({
      performed: false, outcomeKnown: true,
      outcomeKind: 'pre-effect-failure', retryable: true,
    });
    expect(await completed.readFile({ appId: completedRecord.id, path: 'extra.txt' })).toBe('keep');
    await completed.opfsForApp(completedRecord.id).nuke();

    const incompleteRegistry = memoryRegistry();
    const incomplete = createAppClient({
      registry: /** @type {any} */ (incompleteRegistry),
      tracker: /** @type {any} */ ({ reloadTab: async () => {} }),
      repositories: /** @type {any} */ (testRepositories()),
    });
    const incompleteRecord = await incomplete.create({
      name: 'Delete rollback loss',
      files: { 'index.html': 'old', 'extra.txt': 'keep' }, entryFile: 'index.html',
    });
    incompleteRegistry.update = async () => { throw new Error('catalog unavailable'); };
    /** @type {any} */ let incompleteFailure = null;
    try { await incomplete.deleteFile({ appId: incompleteRecord.id, path: 'extra.txt' }); }
    catch (error) { incompleteFailure = error; }
    expect({
      performed: incompleteFailure?.performed,
      outcomeKnown: incompleteFailure?.outcomeKnown,
      outcomeKind: incompleteFailure?.outcomeKind,
      retryable: incompleteFailure?.retryable,
    }).toEqual({
      performed: true, outcomeKnown: false,
      outcomeKind: 'host-lost', retryable: false,
    });
    expect(await incomplete.readFile({ appId: incompleteRecord.id, path: 'extra.txt' })).toBe('keep');
    await incomplete.opfsForApp(incompleteRecord.id).nuke();
  });

  it('marks an unproven complete-tree replacement rollback unknown', async () => {
    const registry = memoryRegistry();
    const client = createAppClient({
      registry: /** @type {any} */ (registry),
      tracker: /** @type {any} */ ({ reloadTab: async () => {} }),
      repositories: /** @type {any} */ (testRepositories()),
    });
    const record = await client.create({
      name: 'Replace rollback loss', files: { 'index.html': 'old' }, entryFile: 'index.html',
    });
    registry.update = async () => { throw new Error('catalog unavailable'); };
    /** @type {any} */ let failure = null;
    try {
      await client.replaceFiles({
        appId: record.id, files: { 'index.html': 'changed' }, entryFile: 'index.html',
      });
    } catch (error) { failure = error; }
    expect({
      performed: failure?.performed,
      outcomeKnown: failure?.outcomeKnown,
      outcomeKind: failure?.outcomeKind,
      retryable: failure?.retryable,
    }).toEqual({
      performed: true, outcomeKnown: false,
      outcomeKind: 'host-lost', retryable: false,
    });
    expect(await client.readFile({ appId: record.id, path: 'index.html' })).toBe('old');
    await client.opfsForApp(record.id).nuke();
  });

  it('changes durable kind when a deleted unknown binary is recreated as text', async () => {
    const registry = memoryRegistry();
    const client = createAppClient({
      registry: /** @type {any} */ (registry),
      tracker: /** @type {any} */ ({ reloadTab: async () => {} }),
      repositories: /** @type {any} */ (testRepositories()),
    });
    const record = await client.create({
      name: 'Kinds',
      files: { 'index.html': 'x', 'model.custom': { base64: 'QUJD' } },
      entryFile: 'index.html',
    });
    expect(registry.records.get(record.id).fileKinds['model.custom']).toBe('binary');
    await client.deleteFile({ appId: record.id, path: 'model.custom' });
    await client.writeFile({ appId: record.id, path: 'model.custom', content: 'text now' });
    expect(registry.records.get(record.id).fileKinds['model.custom']).toBe('text');
    expect(await client.readFile({ appId: record.id, path: 'model.custom' })).toBe('text now');
    await client.opfsForApp(record.id).nuke();
  });

  it('preserves a prototype-looking binary path through storage and snapshots', async () => {
    const registry = memoryRegistry();
    const client = createAppClient({
      registry: /** @type {any} */ (registry),
      tracker: /** @type {any} */ ({ reloadTab: async () => {} }),
      repositories: /** @type {any} */ (testRepositories()),
    });
    // Object.fromEntries creates own data properties, including this hostile
    // path, without invoking the legacy Object.prototype setter.
    const files = Object.fromEntries([
      ['index.html', '<h1>x</h1>'],
      ['__proto__', { base64: 'QUJD' }],
    ]);
    const fileKinds = Object.fromEntries([
      ['index.html', 'text'],
      ['__proto__', 'binary'],
    ]);
    const record = await client.create({
      name: 'Prototype path', files, fileKinds, entryFile: 'index.html',
    });
    const snapshot = await client.snapshotFiles({ appId: record.id });
    expect(Object.hasOwn(snapshot.files, '__proto__')).toBe(true);
    const prototypeBytes = Object.getOwnPropertyDescriptor(snapshot.files, '__proto__')?.value;
    const prototypeKind = Object.getOwnPropertyDescriptor(snapshot.record.fileKinds, '__proto__')?.value;
    expect(Array.from(prototypeBytes ?? [])).toEqual([65, 66, 67]);
    expect(prototypeKind).toBe('binary');
    await client.opfsForApp(record.id).nuke();
  });

  it('waits for an active mutation before taking an export snapshot', async () => {
    const registry = memoryRegistry();
    const client = createAppClient({
      registry: /** @type {any} */ (registry),
      tracker: /** @type {any} */ ({ reloadTab: async () => {} }),
      repositories: /** @type {any} */ (testRepositories()),
    });
    const record = await client.create({
      name: 'Snapshot', files: { 'index.html': 'old' }, entryFile: 'index.html',
    });
    const updateRecord = registry.update;
    /** @type {() => void} */
    let releaseUpdate = () => {};
    /** @type {() => void} */
    let markUpdateEntered = () => {};
    const updateEntered = new Promise((resolve) => { markUpdateEntered = () => resolve(undefined); });
    const updateReleased = new Promise((resolve) => { releaseUpdate = () => resolve(undefined); });
    registry.update = async (id, patch) => {
      markUpdateEntered();
      await updateReleased;
      return updateRecord(id, patch);
    };

    const write = client.writeFile({
      appId: record.id, path: 'index.html', content: 'new', reload: false,
    });
    await updateEntered;
    let snapshotSettled = false;
    const snapshotPromise = client.snapshotFiles({ appId: record.id }).then((snapshot) => {
      snapshotSettled = true;
      return snapshot;
    });
    await Promise.resolve();
    expect(snapshotSettled).toBe(false);
    releaseUpdate();
    await write;
    const snapshot = await snapshotPromise;
    expect(new TextDecoder().decode(snapshot.files['index.html'])).toBe('new');
    expect(snapshot.record.fileKinds['index.html']).toBe('text');
    await client.opfsForApp(record.id).nuke();
  });
});

/** @returns {Promise<any>} */
const runDirectRunner = () => new Promise((resolve, reject) => {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px';
  /** @type {MessagePort | null} */
  let runnerPort = null;
  const cleanup = () => {
    clearTimeout(timer);
    runnerPort?.close();
    window.removeEventListener('message', onMessage);
    iframe.remove();
  };
  const timer = setTimeout(() => {
    cleanup();
    reject(new Error('runner binary-asset handshake timed out'));
  }, 8000);
  const html = `<script>
    Promise.resolve().then(async () => {
      const bytes = window.peerd.assets.bytes('asset.bin');
      const wasm = window.peerd.assets.bytes('./empty.wasm');
      const instantiated = await WebAssembly.instantiate(wasm);
      parent.postMessage({
        type: 'runner-binary-result',
        bytes: Array.from(bytes),
        has: window.peerd.assets.has('empty.wasm'),
        missing: window.peerd.assets.bytes('missing.bin'),
        list: window.peerd.assets.list().sort(),
        exports: Object.keys(instantiated.instance.exports),
      }, '*');
    }).catch((error) => parent.postMessage({ type: 'runner-binary-error', error: String(error) }, '*'));
  <\/script>`;
  /** @param {MessageEvent} event */
  const onMessage = (event) => {
    if (event.source !== iframe.contentWindow) return;
    if (event.data?.type === 'runner-binary-error') {
      cleanup();
      reject(new Error(event.data.error));
    } else if (event.data?.type === 'runner-binary-result') {
      cleanup();
      resolve(event.data);
    }
  };
  window.addEventListener('message', onMessage);
  iframe.addEventListener('load', () => {
    const channel = new MessageChannel();
    runnerPort = channel.port1;
    runnerPort.addEventListener('message', (event) => {
      if (event.data?.type !== 'runner-ready') return;
      const asset = new Uint8Array(BINARY_TRIPWIRE).buffer;
      const wasm = new Uint8Array(VALID_EMPTY_WASM).buffer;
      runnerPort?.postMessage({
        type: 'app-body', html, entry: 'index.html',
        assets: { 'asset.bin': asset, 'empty.wasm': wasm },
      }, [asset, wasm]);
    });
    runnerPort.start();
    iframe.contentWindow?.postMessage({ type: 'runner-init' }, '*', [channel.port2]);
  }, { once: true });
  iframe.src = '/engine-tabs/app-tab/runner.html';
  document.body.appendChild(iframe);
});

/** @returns {Promise<any>} */
const runDirectData = () => new Promise((resolve, reject) => {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px';
  const values = new Map();
  /** @type {MessagePort | null} */
  let runnerPort = null;
  const cleanup = () => {
    clearTimeout(timer);
    runnerPort?.close();
    window.removeEventListener('message', onMessage);
    iframe.remove();
  };
  const timer = setTimeout(() => {
    cleanup();
    reject(new Error('runner data handshake timed out'));
  }, 8000);
  const html = `<script>
    Promise.resolve().then(async () => {
      await window.peerd.data.set('document', { text: 'hello', version: 1 });
      const value = await window.peerd.data.get('document');
      const keys = await window.peerd.data.list();
      await window.peerd.data.delete('document');
      const missing = await window.peerd.data.get('document');
      parent.postMessage({ type: 'runner-data-result', value, keys, missing }, '*');
    }).catch((error) => parent.postMessage({ type: 'runner-data-error', error: String(error) }, '*'));
  <\/script>`;
  /** @param {MessageEvent} event */
  const onMessage = (event) => {
    if (event.source !== iframe.contentWindow) return;
    if (event.data?.peerd === 'app:data:request') {
      const { id, op, key } = event.data;
      /** @type {any} */ let value = true;
      if (op === 'set') values.set(key, JSON.parse(event.data.json));
      else if (op === 'get') value = values.get(key) ?? null;
      else if (op === 'list') value = [...values.keys()].sort();
      else if (op === 'delete') values.delete(key);
      iframe.contentWindow?.postMessage({ peerd: 'app:data:result', id, ok: true, value }, '*');
      return;
    }
    if (event.data?.type === 'runner-data-error') {
      cleanup();
      reject(new Error(event.data.error));
    } else if (event.data?.type === 'runner-data-result') {
      cleanup();
      resolve(event.data);
    }
  };
  window.addEventListener('message', onMessage);
  iframe.addEventListener('load', () => {
    const channel = new MessageChannel();
    runnerPort = channel.port1;
    runnerPort.addEventListener('message', (event) => {
      if (event.data?.type !== 'runner-ready') return;
      runnerPort?.postMessage({ type: 'app-body', html, entry: 'index.html', assets: {} });
    });
    runnerPort.start();
    iframe.contentWindow?.postMessage({ type: 'runner-init' }, '*', [channel.port2]);
  }, { once: true });
  iframe.src = '/engine-tabs/app-tab/runner.html';
  document.body.appendChild(iframe);
});

describe('App runner binary assets', () => {
  it('exposes transferred bytes and instantiates valid WASM', async () => {
    const result = await runDirectRunner();
    expect(result.bytes).toEqual(BINARY_TRIPWIRE);
    expect(result.has).toBe(true);
    expect(result.missing).toBe(null);
    expect(result.list).toEqual(['asset.bin', 'empty.wasm']);
    expect(result.exports).toEqual([]);
  });
});

describe('App runner durable data', () => {
  it('exposes a bounded JSON API without an OPFS handle', async () => {
    const result = await runDirectData();
    expect(result.value).toEqual({ text: 'hello', version: 1 });
    expect(result.keys).toEqual(['document']);
    expect(result.missing).toBe(null);
  });

  it('maps safe App-local JSON writes onto the existing mutation routes', async () => {
    const root = ['peerd-apps', 'app-data-client-test'];
    const opfs = opfsHelpers(root);
    await opfs.nuke();
    /** @type {any[]} */
    const calls = [];
    const data = createAppDataClient({
      appId: 'app-data-client-test', opfs,
      send: async (/** @type {any} */ message) => {
        calls.push(message);
        if (message.type === 'app/editor-write') await opfs.write(message.path, message.content);
        else if (message.type === 'app/editor-delete') await opfs.delete(message.path);
        return { ok: true };
      },
    });
    expect(await data.request('set', 'document', '{"text":"hello"}')).toEqual({ ok: true, value: true });
    expect(await data.request('get', 'document')).toEqual({ ok: true, value: { text: 'hello' } });
    expect(await data.request('list')).toEqual({ ok: true, value: ['document'] });
    expect(await data.request('set', '../escape', '{}')).toEqual({ ok: false, error: 'invalid App data key' });
    expect(await data.request('set', 'large', `"${'x'.repeat(MAX_APP_DATA_BYTES)}"`))
      .toEqual({ ok: false, error: 'App data value is too large' });
    expect(await data.request('delete', 'document')).toEqual({ ok: true, value: true });
    expect(await data.request('get', 'document')).toEqual({ ok: true, value: null });
    expect(calls).toEqual([
      { type: 'app/editor-write', appId: 'app-data-client-test', path: 'data/document.json', content: '{"text":"hello"}', runtimeData: true },
      { type: 'app/editor-delete', appId: 'app-data-client-test', path: 'data/document.json', runtimeData: true },
    ]);
    await opfs.nuke();
  });
});

describe('App editor binary asset UX', () => {
  it('shows a read-only row and does not open the asset as text', async () => {
    const root = ['peerd-apps', 'binary-editor-test'];
    const opfs = opfsHelpers(root);
    await opfs.nuke();
    await opfs.write('index.html', '<h1>x</h1>');
    await opfs.write('engine.wasm', new Uint8Array(VALID_EMPTY_WASM));
    const mount = document.createElement('div');
    mount.style.cssText = 'position:fixed;left:-9999px;width:600px;height:400px';
    document.body.appendChild(mount);
    let blockedPath = '';
    const editor = await createEditor({
      mountEl: mount,
      opfsBase: root,
      pinnedFile: 'index.html',
      isReadOnlyFile: isBinaryAssetPath,
      onReadOnlyFile: (path) => { blockedPath = path; },
    });
    const row = Array.from(mount.querySelectorAll('.pe-node'))
      .find((node) => node.textContent?.includes('engine.wasm'));
    expect(row instanceof HTMLElement).toBe(true);
    expect(row?.classList.contains('is-readonly')).toBe(true);
    /** @type {HTMLElement} */ (row).click();
    expect(blockedPath).toBe('engine.wasm');
    expect(editor.getActiveFile()).toBe('index.html');
    editor.destroy();
    mount.remove();
    await opfs.nuke();
  });

  it('uses one roving tree stop and exposes hierarchy and selection state', async () => {
    const root = ['peerd-apps', 'binary-editor-a11y'];
    const opfs = opfsHelpers(root);
    await opfs.nuke();
    await opfs.write('index.html', '<h1>x</h1>');
    await opfs.write('lib/a.js', 'a');
    await opfs.write('z.js', 'z');
    const mount = document.createElement('div');
    mount.style.cssText = 'position:fixed;left:-9999px;width:600px;height:400px';
    document.body.appendChild(mount);
    const editor = await createEditor({ mountEl: mount, opfsBase: root, pinnedFile: 'index.html' });
    const rows = Array.from(mount.querySelectorAll('[role="treeitem"]'));
    expect(rows.filter((row) => /** @type {HTMLElement} */ (row).tabIndex === 0).length).toBe(1);
    const directory = rows.find((row) => /** @type {HTMLElement} */ (row).dataset.kind === 'dir');
    expect(directory?.getAttribute('aria-expanded')).toBe('true');
    const selected = rows.find((row) => row.getAttribute('aria-selected') === 'true');
    expect(/** @type {HTMLElement} */ (selected).dataset.path).toBe('index.html');
    /** @type {HTMLElement} */ (selected).focus();
    selected?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement === selected).toBe(false);
    editor.destroy();
    mount.remove();
    await opfs.nuke();
  });

  it('keeps the delete target on the same file when deletion fails', async () => {
    const root = ['peerd-apps', 'binary-editor-delete-failure'];
    const opfs = opfsHelpers(root);
    await opfs.nuke();
    await opfs.write('index.html', 'entry');
    await opfs.write('z.js', 'z');
    const mount = document.createElement('div');
    mount.style.cssText = 'position:fixed;left:-9999px;width:600px;height:400px';
    document.body.appendChild(mount);
    /** @type {string[]} */
    const deleteAttempts = [];
    const editor = await createEditor({
      mountEl: mount,
      opfsBase: root,
      pinnedFile: 'index.html',
      deleteFile: async (path) => {
        deleteAttempts.push(path);
        throw new Error('storage unavailable');
      },
    });
    const row = /** @type {HTMLElement} */ (mount.querySelector('[data-path="z.js"]'));
    const deleteButton = /** @type {HTMLButtonElement} */ (mount.querySelector('.pe-delete'));
    row.focus();
    row.dispatchEvent(new FocusEvent('focus'));
    expect(deleteButton.getAttribute('aria-label')).toBe('Delete z.js');
    const originalConfirm = globalThis.confirm;
    const originalAlert = globalThis.alert;
    globalThis.confirm = () => true;
    globalThis.alert = () => {};
    try {
      deleteButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      deleteButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      globalThis.confirm = originalConfirm;
      globalThis.alert = originalAlert;
    }
    expect(deleteButton.getAttribute('aria-label')).toBe('Delete z.js');
    expect(deleteAttempts).toEqual(['z.js', 'z.js']);
    editor.destroy();
    mount.remove();
    await opfs.nuke();
  });

  it('does not autosave programmatic loads and keeps failed edits open', async () => {
    const root = ['peerd-apps', 'binary-editor-save-failure'];
    const opfs = opfsHelpers(root);
    await opfs.nuke();
    await opfs.write('index.html', '<h1>x</h1>');
    await opfs.write('other.js', 'old');
    const mount = document.createElement('div');
    mount.style.cssText = 'position:fixed;left:-9999px;width:600px;height:400px';
    document.body.appendChild(mount);
    let writes = 0;
    let saveErrors = 0;
    let shouldFail = true;
    /** @type {boolean[]} */
    const dirtyStates = [];
    const editor = await createEditor({
      mountEl: mount,
      opfsBase: root,
      pinnedFile: 'index.html',
      writeFile: async (path, content) => {
        writes += 1;
        if (shouldFail) throw new Error('storage full');
        await opfs.write(path, content);
      },
      onSaveError: () => { saveErrors += 1; },
      onDirtyChange: (dirty) => { dirtyStates.push(dirty); },
    });
    await editor.switchToFile('other.js');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(writes).toBe(0);
    expect(editor.getActiveFile()).toBe('other.js');
    let rejected = false;
    try { await editor.replaceActiveWith('unsaved change'); } catch { rejected = true; }
    expect(rejected).toBe(true);
    expect(editor.getActiveContent()).toBe('unsaved change');
    expect(saveErrors).toBe(1);
    expect(editor.hasUnsavedChanges()).toBe(true);
    await editor.switchToFile('index.html');
    expect(editor.getActiveFile()).toBe('other.js');
    expect(editor.getActiveContent()).toBe('unsaved change');
    expect(saveErrors).toBe(2);
    shouldFail = false;
    await editor.switchToFile('index.html');
    expect(editor.hasUnsavedChanges()).toBe(false);
    expect(editor.getActiveFile()).toBe('index.html');
    expect(await opfs.read('other.js')).toBe('unsaved change');
    expect(dirtyStates).toEqual([true, false]);
    editor.destroy();
    mount.remove();
    await opfs.nuke();
  });

  it('saves the latest revision when an edit arrives during a write', async () => {
    const root = ['peerd-apps', 'binary-editor-save-race'];
    const opfs = opfsHelpers(root);
    await opfs.nuke();
    await opfs.write('index.html', 'old');
    const mount = document.createElement('div');
    mount.style.cssText = 'position:fixed;left:-9999px;width:600px;height:400px';
    document.body.appendChild(mount);
    /** @type {() => void} */
    let markFirstStarted = () => {};
    /** @type {() => void} */
    let releaseFirst = () => {};
    const firstStarted = new Promise((resolve) => { markFirstStarted = () => resolve(undefined); });
    const firstReleased = new Promise((resolve) => { releaseFirst = () => resolve(undefined); });
    /** @type {string[]} */
    const persisted = [];
    let activeWrites = 0;
    let maxConcurrentWrites = 0;
    const editor = await createEditor({
      mountEl: mount,
      opfsBase: root,
      pinnedFile: 'index.html',
      writeFile: async (_path, content) => {
        activeWrites += 1;
        maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
        persisted.push(content);
        try {
          if (persisted.length === 1) {
            markFirstStarted();
            await firstReleased;
          }
        } finally {
          activeWrites -= 1;
        }
      },
    });
    const first = editor.replaceActiveWith('first revision');
    await firstStarted;
    const second = editor.replaceActiveWith('second revision');
    const third = editor.replaceActiveWith('third revision');
    releaseFirst();
    await Promise.all([first, second, third]);
    expect(persisted).toEqual(['first revision', 'third revision']);
    expect(maxConcurrentWrites).toBe(1);
    expect(editor.getActiveContent()).toBe('third revision');
    editor.destroy();
    mount.remove();
    await opfs.nuke();
  });

  it('rejects an external active-file write while the user buffer is dirty', async () => {
    const root = ['peerd-apps', 'binary-editor-external-conflict'];
    const opfs = opfsHelpers(root);
    await opfs.nuke();
    await opfs.write('index.html', 'old');
    const mount = document.createElement('div');
    mount.style.cssText = 'position:fixed;left:-9999px;width:600px;height:400px';
    document.body.appendChild(mount);
    /** @type {() => void} */
    let markWriteStarted = () => {};
    /** @type {() => void} */
    let releaseWrite = () => {};
    const writeStarted = new Promise((resolve) => { markWriteStarted = () => resolve(undefined); });
    const writeReleased = new Promise((resolve) => { releaseWrite = () => resolve(undefined); });
    /** @type {string[]} */
    const persisted = [];
    const editor = await createEditor({
      mountEl: mount,
      opfsBase: root,
      pinnedFile: 'index.html',
      writeFile: async (_path, content) => {
        persisted.push(content);
        markWriteStarted();
        await writeReleased;
      },
    });
    const userSave = editor.replaceActiveWith('user draft');
    await writeStarted;
    const externalWrite = editor.writeExternalActiveFile('index.html', 'agent replacement');
    releaseWrite();
    const [conflict] = await Promise.all([externalWrite, userSave]);
    expect(conflict).toEqual({ handled: true, conflict: true, path: 'index.html' });
    expect(persisted).toEqual(['user draft']);
    expect(editor.getActiveContent()).toBe('user draft');
    editor.destroy();
    mount.remove();
    await opfs.nuke();
  });

  it('layers user edits made after an external active-file write begins', async () => {
    const root = ['peerd-apps', 'binary-editor-external-followup'];
    const opfs = opfsHelpers(root);
    await opfs.nuke();
    await opfs.write('index.html', 'old');
    const mount = document.createElement('div');
    mount.style.cssText = 'position:fixed;left:-9999px;width:600px;height:400px';
    document.body.appendChild(mount);
    /** @type {() => void} */
    let markWriteStarted = () => {};
    /** @type {() => void} */
    let releaseWrite = () => {};
    const writeStarted = new Promise((resolve) => { markWriteStarted = () => resolve(undefined); });
    const writeReleased = new Promise((resolve) => { releaseWrite = () => resolve(undefined); });
    /** @type {string[]} */
    const persisted = [];
    const editor = await createEditor({
      mountEl: mount,
      opfsBase: root,
      pinnedFile: 'index.html',
      writeFile: async (_path, content) => {
        persisted.push(content);
        if (persisted.length === 1) {
          markWriteStarted();
          await writeReleased;
        }
      },
    });
    const externalWrite = editor.writeExternalActiveFile('index.html', 'agent replacement');
    await writeStarted;
    const userSave = editor.replaceActiveWith('agent replacement + user edit');
    releaseWrite();
    const [result] = await Promise.all([externalWrite, userSave]);
    expect(result).toEqual({ handled: true, conflict: false, path: 'index.html' });
    expect(persisted).toEqual(['agent replacement', 'agent replacement + user edit']);
    expect(editor.getActiveContent()).toBe('agent replacement + user edit');
    expect(editor.hasUnsavedChanges()).toBe(false);
    editor.destroy();
    mount.remove();
    await opfs.nuke();
  });

  it('does not recreate an active file when deletion overlaps a save', async () => {
    const root = ['peerd-apps', 'binary-editor-delete-race'];
    const opfs = opfsHelpers(root);
    await opfs.nuke();
    await opfs.write('index.html', 'entry');
    await opfs.write('other.js', 'old');
    const mount = document.createElement('div');
    mount.style.cssText = 'position:fixed;left:-9999px;width:600px;height:400px';
    document.body.appendChild(mount);
    /** @type {() => void} */
    let markFirstStarted = () => {};
    /** @type {() => void} */
    let releaseFirst = () => {};
    /** @type {() => void} */
    let markDeleted = () => {};
    const firstStarted = new Promise((resolve) => { markFirstStarted = () => resolve(undefined); });
    const firstReleased = new Promise((resolve) => { releaseFirst = () => resolve(undefined); });
    const deleted = new Promise((resolve) => { markDeleted = () => resolve(undefined); });
    /** @type {string[]} */
    const persisted = [];
    const editor = await createEditor({
      mountEl: mount,
      opfsBase: root,
      pinnedFile: 'index.html',
      initialFile: 'other.js',
      writeFile: async (_path, content) => {
        persisted.push(content);
        if (persisted.length === 1) {
          markFirstStarted();
          await firstReleased;
        }
      },
      deleteFile: async (path) => {
        await opfs.delete(path);
        markDeleted();
      },
    });
    const first = editor.replaceActiveWith('first revision');
    await firstStarted;
    const second = editor.replaceActiveWith('second revision');
    const originalConfirm = globalThis.confirm;
    globalThis.confirm = () => true;
    try {
      const row = /** @type {HTMLElement} */ (mount.querySelector('[data-path="other.js"]'));
      row.focus();
      /** @type {HTMLButtonElement} */ (mount.querySelector('.pe-delete')).click();
      releaseFirst();
      await Promise.all([first, second, deleted]);
    } finally { globalThis.confirm = originalConfirm; }
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(persisted).toEqual(['first revision']);
    expect((await opfs.list()).some((file) => file.path.replace(/^\/+/, '') === 'other.js')).toBe(false);
    editor.destroy();
    mount.remove();
    await opfs.nuke();
  });

  it('does not report a discarded save after confirmed deletion succeeds', async () => {
    const root = ['peerd-apps', 'binary-editor-delete-failed-save'];
    const opfs = opfsHelpers(root);
    await opfs.nuke();
    await opfs.write('index.html', 'entry');
    await opfs.write('other.js', 'old');
    const mount = document.createElement('div');
    mount.style.cssText = 'position:fixed;left:-9999px;width:600px;height:400px';
    document.body.appendChild(mount);
    /** @type {() => void} */
    let markSaveStarted = () => {};
    /** @type {() => void} */
    let releaseSave = () => {};
    /** @type {() => void} */
    let markDeleted = () => {};
    const saveStarted = new Promise((resolve) => { markSaveStarted = () => resolve(undefined); });
    const saveReleased = new Promise((resolve) => { releaseSave = () => resolve(undefined); });
    const deleted = new Promise((resolve) => { markDeleted = () => resolve(undefined); });
    let saveErrors = 0;
    const editor = await createEditor({
      mountEl: mount,
      opfsBase: root,
      pinnedFile: 'index.html',
      initialFile: 'other.js',
      writeFile: async () => {
        markSaveStarted();
        await saveReleased;
        throw new Error('stale write failed');
      },
      deleteFile: async (path) => {
        await opfs.delete(path);
        markDeleted();
      },
      onSaveError: () => { saveErrors += 1; },
    });
    const save = editor.replaceActiveWith('discard me');
    await saveStarted;
    const originalConfirm = globalThis.confirm;
    globalThis.confirm = () => true;
    try {
      const row = /** @type {HTMLElement} */ (mount.querySelector('[data-path="other.js"]'));
      row.focus();
      row.dispatchEvent(new FocusEvent('focus'));
      /** @type {HTMLButtonElement} */ (mount.querySelector('.pe-delete')).click();
      releaseSave();
      await Promise.all([save.catch(() => {}), deleted]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally { globalThis.confirm = originalConfirm; }
    expect(saveErrors).toBe(0);
    expect(editor.getActiveFile()).toBe('index.html');
    expect(editor.hasUnsavedChanges()).toBe(false);
    editor.destroy();
    mount.remove();
    await opfs.nuke();
  });
});
