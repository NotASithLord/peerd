// @ts-check
// Native App metadata/file authority; Git computation remains demand-owned.

import {
  KERNEL_APP_CATALOG_KEY,
  kernelSessionAppId,
} from './kernel-app-catalog.js';

/** @param {unknown} row @param {string} sessionId */
export const resolveKernelSessionAppId = kernelSessionAppId;

/** @param {any} deps */
export const createKernelAppFileReader = ({ idb, sessionCache, appFiles }) => {
  if (typeof idb?.get !== 'function' || typeof sessionCache?.sessionGet !== 'function'
      || typeof appFiles?.listApp !== 'function'
      || typeof appFiles?.listAppInfo !== 'function'
      || typeof appFiles?.readText !== 'function'
      || typeof appFiles?.readBytes !== 'function'
      || typeof appFiles?.write !== 'function'
      || typeof appFiles?.writeText !== 'function'
      || typeof appFiles?.deleteFile !== 'function') {
    throw new TypeError('kernel-app-file-reader-config-invalid');
  }
  const list = async () => {
    const sessionId = await sessionCache.sessionGet('currentSessionId');
    if (typeof sessionId !== 'string' || !sessionId) return [];
    const appId = resolveKernelSessionAppId(
      await idb.get('apps', KERNEL_APP_CATALOG_KEY), sessionId,
    );
    return appId ? appFiles.listApp(appId) : [];
  };
  return Object.freeze({ list, ...appFiles });
};

/** @param {any} deps */
export const makeKernelAppEditorRoutes = ({
  vault, catalog, files, repositories, isAppSender, reloadApp = () => {},
}) => {
  const fail = (/** @type {any} */ cause) => ({
    ok: false,
    code: String(cause?.code ?? 'app-file-operation-failed').slice(0, 80),
    error: cause?.message ?? String(cause),
    ...(cause?.outcomeKnown === false ? { outcomeKnown: false, outcomeKind: 'unknown' } : {}),
  });
  const get = async (/** @type {unknown} */ id) => {
    if (vault.isLocked()) return { error: 'vault-locked' };
    if (typeof id !== 'string') return { error: 'appId-required' };
    const record = await catalog.get(id);
    return record ? { id, record } : { error: 'app-not-found' };
  };
  const view = (/** @type {'read'|'list'} */ kind) => async (/** @type {any} */ message = {}) => {
    const checked = await get(message.appId);
    if (!checked.record) return { ok: false, error: checked.error };
    if (kind === 'read' && typeof message.path !== 'string') {
      return { ok: false, error: 'appId-and-path-required' };
    }
    try {
      return kind === 'read'
        ? { ok: true, content: await files.readText(checked.id, message.path) }
        : { ok: true, files: await files.listAppInfo(checked.id) };
    } catch (cause) { return fail(cause); }
  };
  const edit = (/** @type {boolean} */ remove, /** @type {boolean} */ exact,
    /** @type {boolean} */ reload) => async (
    /** @type {any} */ message = {}, /** @type {unknown} */ sender = undefined,
  ) => {
    const { appId, path, content, runtimeData = false } = message;
    const checked = await get(appId);
    if (!checked.record) return { ok: false, error: checked.error };
    if (exact && !isAppSender(sender, checked.id)) {
      return { ok: false, error: 'app-data-unauthorized' };
    }
    if (typeof path !== 'string' || (!remove && typeof content !== 'string')) {
      return { ok: false, error: remove ? 'appId-and-path-required' : 'appId-path-content-required' };
    }
    if (runtimeData && !/^data\/[a-z0-9][a-z0-9._-]{0,63}\.json$/i.test(path)) {
      return { ok: false, error: 'app-data-unauthorized' };
    }
    if (remove && path === checked.record.entryFile) {
      return { ok: false, error: `refusing to delete entry file: ${path}` };
    }
    try {
      await repositories.coordinate({ kind: 'app', id: checked.id }, async () => {
        let prior;
        try { prior = await files.readBytes(checked.id, path); }
        catch (cause) {
          const missing = /** @type {any} */ (cause)?.name === 'NotFoundError';
          if (!(remove && runtimeData && missing) && !missing) throw cause;
        }
        if (remove && prior === undefined) return;
        if (remove) await files.deleteFile(checked.id, path);
        else await files.writeText(checked.id, path, content);
        const kinds = { ...(checked.record.fileKinds ?? {}) };
        if (remove) delete kinds[path]; else kinds[path] = 'text';
        try {
          if (!await catalog.setFileKinds(checked.id, kinds)) throw new Error('app-not-found');
        } catch (cause) {
          if (prior !== undefined) await files.write(checked.id, path, prior);
          else await files.deleteFile(checked.id, path).catch(() => {});
          throw cause;
        }
      });
      if (reload) Promise.resolve(reloadApp(checked.id)).catch(() => {});
      return { ok: true };
    } catch (cause) { return fail(cause); }
  };
  return Object.freeze({
    'app/editor/read': view('read'),
    'app/editor/list': view('list'),
    'app/editor/write': edit(false, false, true),
    'app/editor/delete': edit(true, false, true),
    'app/editor-write': edit(false, true, false),
    'app/editor-delete': edit(true, true, false),
  });
};
