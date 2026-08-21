// @ts-check
// Lazy App-file implementation for the authenticated repository host. This
// module owns no catalog/vault authority and can touch only one validated App
// directory per call. Git credentials remain unavailable in this realm.

import { inferAppFileKind } from '/peerd-engine/app-assets.js';
import { buildAppManifest, parseAppManifest } from '/peerd-engine/app-manifest.js';

const MAX_APP_FILES = 256;
const MAX_APP_TOTAL_BYTES = 50_000_000;
const MAX_APP_PATH_CHARS = 512;
const APP_ID = /^app-[a-z0-9-]{1,92}$/;

/** @param {AbortSignal|undefined} signal */
const checkAbort = (signal) => {
  if (signal?.aborted) throw signal.reason ?? new Error('App file operation cancelled');
};

/** @param {unknown} value */
const appIdOf = (value) => {
  const ref = /** @type {{kind?:unknown,id?:unknown}|null} */ (
    value && typeof value === 'object' && !Array.isArray(value) ? value : null
  );
  if (ref?.kind !== 'app' || typeof ref.id !== 'string' || ref.id.length > 96
      || !APP_ID.test(ref.id)) throw new Error('invalid App file reference');
  return ref.id;
};

/** @param {unknown} value */
const safeParts = (value) => {
  if (typeof value !== 'string' || !value || value.length > MAX_APP_PATH_CHARS
      || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error('unsafe App path');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('unsafe App path');
  }
  return parts;
};

/**
 * @param {{getRootDirectory?:()=>Promise<FileSystemDirectoryHandle>}} [deps]
 */
export const createRepositoryAppFileService = ({
  getRootDirectory = () => globalThis.navigator.storage.getDirectory(),
} = {}) => {
  const appDirectory = async (/** @type {string} */ appId, create = false) => {
    let directory = await getRootDirectory();
    directory = await directory.getDirectoryHandle('peerd-apps', { create });
    return directory.getDirectoryHandle(appId, { create });
  };
  /** @param {string} appId @param {string} path @param {boolean} create */
  const parent = async (appId, path, create) => {
    const parts = safeParts(path);
    let directory = await appDirectory(appId, create);
    for (const part of parts.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(part, { create });
    }
    const filename = parts.at(-1);
    if (!filename) throw new Error('unsafe App path');
    return { directory, filename };
  };
  /** @param {string} appId @param {AbortSignal|undefined} signal */
  const scan = async (appId, signal) => {
    /** @type {{path:string,size:number}[]} */ const files = [];
    let total = 0;
    try {
      const directory = await appDirectory(appId);
      /** @param {any} current @param {string} prefix */
      const walk = async (current, prefix) => {
        checkAbort(signal);
        for await (const entry of current.values()) {
          checkAbort(signal);
          const path = `${prefix}/${entry.name}`;
          if (entry.kind === 'directory') await walk(entry, path);
          else if (entry.kind === 'file') {
            const size = (await entry.getFile()).size;
            total += size;
            files.push({ path, size });
            if (files.length > MAX_APP_FILES || total > MAX_APP_TOTAL_BYTES) {
              throw new Error('App exceeds the storage limits');
            }
          }
        }
      };
      await walk(directory, '');
      return files;
    } catch (cause) {
      if (/** @type {{name?:unknown}} */ (cause)?.name === 'NotFoundError') return [];
      throw cause;
    }
  };
  /** @param {any} ref @param {{path?:unknown,encoding?:unknown,signal?:AbortSignal}} [options] */
  const appRead = async (ref, options = {}) => {
    const appId = appIdOf(ref);
    const path = safeParts(options.path).join('/');
    checkAbort(options.signal);
    const { directory, filename } = await parent(appId, path, false);
    const file = await (await directory.getFileHandle(filename)).getFile();
    if (file.size > MAX_APP_TOTAL_BYTES) throw new Error('App file exceeds the storage limit');
    checkAbort(options.signal);
    if (options.encoding === 'text') return file.text();
    if (options.encoding !== 'bytes') throw new Error('invalid App file encoding');
    return new Uint8Array(await file.arrayBuffer());
  };
  /** @param {any} ref @param {{sizes?:unknown,signal?:AbortSignal}} [options] */
  const appList = async (ref, options = {}) => {
    const files = await scan(appIdOf(ref), options.signal);
    return options.sizes === true ? files : files.map((entry) => entry.path);
  };
  /** @param {any} ref @param {{signal?:AbortSignal}} [options] */
  const appInspect = async (ref, options = {}) => {
    const appId = appIdOf(ref);
    const paths = (await scan(appId, options.signal)).map(({ path }) => path.replace(/^\/+/, ''));
    /** @type {Record<string,'text'|'binary'>} */ const fileKinds = {};
    let manifest = null;
    for (const path of paths) {
      const bytes = /** @type {Uint8Array} */ (await appRead(
        ref, { path, encoding: 'bytes', signal: options.signal },
      ));
      fileKinds[path] = inferAppFileKind(path, bytes);
      if (path === 'peerd.json' && fileKinds[path] === 'text') {
        manifest = new TextDecoder().decode(bytes);
      }
    }
    if (paths.includes('peerd.json') && fileKinds['peerd.json'] !== 'text') {
      throw new Error('peerd.json must be text');
    }
    if (paths.includes('peerd.json') && typeof manifest !== 'string') {
      throw new Error('peerd.json must be text');
    }
    const contract = paths.includes('peerd.json')
      ? parseAppManifest(/** @type {string} */ (manifest))
      : paths.includes('index.html')
        ? parseAppManifest(JSON.stringify(buildAppManifest({ entry: 'index.html' })))
        : (() => { throw new Error('repository is not an App: add peerd.json or index.html'); })();
    if (!paths.includes(contract.entry)) throw new Error(`peerd.json entry is missing: ${contract.entry}`);
    if (fileKinds[contract.entry] !== 'text') throw new Error(`entryFile must be text: ${contract.entry}`);
    return { fileKinds, contract };
  };
  /** @param {any} ref @param {{path?:unknown,value?:unknown,signal?:AbortSignal}} [options] */
  const appWrite = async (ref, options = {}) => {
    const appId = appIdOf(ref);
    const path = safeParts(options.path).join('/');
    const bytes = typeof options.value === 'string'
      ? new TextEncoder().encode(options.value) : options.value;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_APP_TOTAL_BYTES) {
      throw new Error('App file exceeds the storage limit');
    }
    const existing = await scan(appId, options.signal);
    const canonical = `/${path}`;
    const priorEntry = existing.find((entry) => entry.path === canonical);
    const prior = priorEntry?.size ?? 0;
    if (!priorEntry && existing.length >= MAX_APP_FILES) throw new Error('App has too many files');
    const total = existing.reduce((sum, entry) => sum + entry.size, 0) - prior + bytes.byteLength;
    if (total > MAX_APP_TOTAL_BYTES) throw new Error('App is too large');
    checkAbort(options.signal);
    const { directory, filename } = await parent(appId, path, true);
    const writable = await (await directory.getFileHandle(filename, { create: true })).createWritable();
    const onAbort = () => { void writable.abort(options.signal?.reason).catch(() => {}); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      checkAbort(options.signal);
      await writable.write(Uint8Array.from(bytes));
      checkAbort(options.signal);
      await writable.close();
      return { written: true, size: bytes.byteLength };
    } catch (cause) {
      try { await writable.abort(); } catch { /* preserve original failure */ }
      throw cause;
    } finally { options.signal?.removeEventListener('abort', onAbort); }
  };
  /** @param {any} ref @param {{path?:unknown,signal?:AbortSignal}} [options] */
  const appDelete = async (ref, options = {}) => {
    const appId = appIdOf(ref);
    const path = safeParts(options.path).join('/');
    checkAbort(options.signal);
    const { directory, filename } = await parent(appId, path, false);
    await directory.removeEntry(filename);
    checkAbort(options.signal);
    return { deleted: true };
  };
  return Object.freeze({ appRead, appList, appInspect, appWrite, appDelete });
};
