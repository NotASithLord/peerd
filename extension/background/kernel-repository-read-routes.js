// @ts-check
// Native App Git custody; Git implementation remains demand-owned.

import {
  createGitCredentialRoutes,
} from '../shared/repository-channel.js';
import {
  ensureDpopJkt,
  loadDpopJkt,
  makeDpopKeyStore,
  makeOriginCredentialRoutes,
} from '../peerd-egress/kernel-storage.js';

/** @param {unknown} cause @param {string} action @param {boolean} [known] */
const failed = (cause, action, known) => {
  const detail = /** @type {{code?:string,outcomeKnown?:boolean,message?:string}} */ (cause);
  const outcomeKnown = known ?? detail?.outcomeKnown !== false;
  return {
    ok: false,
    code: detail?.code ?? 'repository-operation-failed',
    outcomeKnown,
    retryable: outcomeKnown,
    error: outcomeKnown
      ? `Peerd could not ${action}. Try again.`
      : `Peerd could not confirm the result of trying to ${action}. Refresh Git history to reconcile before trying again.`,
  };
};

/** @param {any} deps */
export const makeKernelGitCredentialRoutes = ({ vault, auditLog, isLockedError }) => {
  return createGitCredentialRoutes({
    vault, isLockedError,
    audit: (event) => { void auditLog.append(event).catch(() => {}); },
  });
};

/**
 * Origin API-key custody (Settings -> API integrations) with the full DPoP
 * key lifecycle: provisioning mints the nonextractable keypair, listing reads
 * the public jkt without minting, revoking retires both credential halves.
 * why learnKeyedOrigin is a seam: the legacy worker feeds the origin lock's
 * live sensitivity cache off this exact audit event; the web-actor migration
 * slice must plug its cache in here or a mid-session credential stays
 * classified ORDINARY (issue 251).
 * @param {any} deps
 */
export const makeKernelOriginCredentialRoutes = ({
  vault, auditLog, isLockedError, idb,
  learnKeyedOrigin = (/** @type {string} */ _origin) => {},
}) => {
  const dpopKeyStore = makeDpopKeyStore({ get: idb.get, put: idb.put, del: idb.del });
  const dpopKeyDeps = {
    ...dpopKeyStore,
    audit: (/** @type {any} */ event) => { void auditLog.append(event).catch(() => {}); },
  };
  return makeOriginCredentialRoutes({
    vault, isLockedError,
    ensureDpopKey: (origin) => ensureDpopJkt(origin, dpopKeyDeps),
    readDpopJkt: (origin) => loadDpopJkt(origin, dpopKeyStore),
    deleteDpopKey: (origin) => dpopKeyStore.remove(origin),
    audit: (event) => {
      void auditLog.append(event).catch(() => {});
      if (event?.type === 'origin_credential_added'
          && typeof event?.details?.origin === 'string') {
        learnKeyedOrigin(event.details.origin);
      }
    },
  });
};

/** @param {any} deps */
export const makeKernelRepositoryReadRoutes = (deps) => {
  const {
    browser, vault, catalog, repositories, auditLog, appTabUrl,
    appFiles = repositories.appFiles, sessionCache = null, allowDweb = false,
    quiesceTimeoutMs = 5_000, setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    wait = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = deps;
  if (!browser?.tabs || !vault || !catalog || !repositories || !auditLog
      || typeof appTabUrl !== 'string' || !appTabUrl
      || !Number.isFinite(quiesceTimeoutMs) || quiesceTimeoutMs <= 0) {
    throw new TypeError('kernel-repository-route-config-invalid');
  }
  /** @param {unknown} appId */
  const appRef = async (appId) => {
    if (typeof appId !== 'string') return { error: 'appId-required' };
    if (vault.isLocked()) return { error: 'vault-locked' };
    if (!await catalog.get(appId)) return { error: 'app-not-found' };
    return { appId, ref: { kind: 'app', id: appId } };
  };
  /** @param {Promise<any>} work */
  const boundedQuiesce = (work) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (/** @type {unknown} */ value, /** @type {boolean} */ ok) => {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timer);
      if (ok) resolve(value); else reject(value);
    };
    const timer = setTimeoutFn(() => finish(new Error(
      'App editor did not finish saving before the Git operation.'), false), quiesceTimeoutMs);
    work.then((value) => finish(value, true), (cause) => finish(cause, false));
  });
  /** @param {string} appId @param {()=>Promise<any>} operation */
  const withQuiescedApp = async (appId, operation, close = true) => {
    const tabs = await browser.tabs.query({ url: `${appTabUrl}#${appId}*` });
    if (tabs.length > 1) throw new Error('multiple App tabs claim this repository');
    const tab = tabs[0];
    if (typeof tab?.id !== 'number') return operation();
    const reply = await boundedQuiesce(Promise.resolve(browser.tabs.sendMessage(
      tab.id, { type: 'app/quiesce', action: 'acquire', appId },
    )));
    if (!reply?.ok) throw new Error(reply?.error ?? 'App editor could not be frozen');
    if (!close) {
      try { return await operation(); }
      finally {
        await browser.tabs.sendMessage(tab.id, {
          type: 'app/quiesce', action: 'release', appId,
        }).catch(() => browser.tabs.reload?.(tab.id));
      }
    }
    const url = typeof tab.url === 'string' ? tab.url : `${appTabUrl}#${appId}`;
    await browser.tabs.remove(tab.id);
    await wait(100);
    try { return await operation(); }
    finally { await browser.tabs.create({ url, active: false }).catch(() => {}); }
  };
  /** @param {string} appId @param {()=>Promise<any>} operation */
  const coordinate = (appId, operation) => repositories.coordinate(
    { kind: 'app', id: appId }, operation,
  );
  /** @param {string} appId @param {()=>Promise<any>} operation */
  const quiesce = (appId, operation, close = true) => withQuiescedApp(
    appId, () => coordinate(appId, operation), close,
  );
  /** @param {any} event */
  const audit = (event) => auditLog.append(event).catch(() => {});

  /** @param {string} action @param {(checked:{appId:string,ref:{kind:string,id:string}},message:any)=>Promise<any>} operation */
  const appRoute = (action, operation) => async (/** @type {any} */ message = {}) => {
    const checked = await appRef(message.appId);
    if (!checked.ref) return { ok: false, error: checked.error };
    try { return await operation(/** @type {any} */ (checked), message); }
    catch (cause) { return failed(cause, action); }
  };
  return Object.freeze({
    'apps/repository/status': appRoute('load Git history', async ({ appId, ref }) => {
      const [status, remote, branches] = await Promise.all([
        repositories.statusApp(appId), repositories.getAppRemote(appId), repositories.branches(ref),
      ]);
      return { ok: true, status, remote, branches };
    }),
    'apps/repository/history': appRoute('load Git history', async ({ appId }, { depth }) => ({
      ok: true,
      commits: await repositories.historyApp(appId, {
        depth: Number.isInteger(depth) ? Math.max(1, Math.min(100, depth)) : 20,
        includeSafety: true,
      }),
    })),
    'apps/repository/diff': appRoute('load this Git diff', async ({ appId }, { from, to }) => {
      if (from !== undefined && typeof from !== 'string') return { ok: false, error: 'repository-from-invalid' };
      if (to !== undefined && to !== null && typeof to !== 'string') return { ok: false, error: 'repository-to-invalid' };
      return { ok: true, diff: await repositories.diffApp(appId, {
        from: from || 'HEAD', to: to || null,
      }) };
    }),
    'apps/repository/commit': appRoute('save the Git checkpoint', async ({ appId }, { message }) => {
      const result = await quiesce(appId, () => repositories.commitApp(appId, {
        message: typeof message === 'string' ? message : 'manual edit',
      }), false);
      audit({ type: 'git_commit_created', details: {
        kind: 'app', appId, oid: result.oid, changed: result.changed.length,
      } });
      return { ok: true, result };
    }),
    'apps/repository/restore': appRoute('restore this Git version', async ({ appId }, { to }) => {
      if (typeof to !== 'string') return { ok: false, error: 'appId-and-to-required' };
      const result = await quiesce(appId, () => repositories.restoreApp(appId, { to }));
      audit({ type: 'git_version_restored', details: { kind: 'app', appId, to, oid: result.oid } });
      return { ok: true, result };
    }),
    'apps/repository/branch': appRoute('create this Git branch', async ({ appId, ref }, {
      name, checkout = true,
    }) => {
      if (typeof name !== 'string') return { ok: false, error: 'appId-and-name-required' };
      const operation = () => repositories.branch(ref, { name, checkout: checkout !== false });
      return { ok: true, result: await (checkout === false
        ? coordinate(appId, operation) : quiesce(appId, operation)) };
    }),
    'apps/repository/checkout': appRoute('switch this Git branch', async ({ appId, ref }, { name }) => {
      if (typeof name !== 'string') return { ok: false, error: 'appId-and-name-required' };
      return { ok: true, result: await quiesce(appId,
        () => repositories.checkout(ref, { name })) };
    }),
    'apps/repository/link': appRoute('link this Git remote', async ({ appId, ref }, { url }) => {
      if (typeof url !== 'string') return { ok: false, error: 'appId-and-url-required' };
      const remote = await coordinate(appId, () => repositories.setRemote(ref, { url }));
      audit({ type: 'git_remote_linked', details: { kind: 'app', appId, host: remote.host, url: remote.url } });
      return { ok: true, remote };
    }),
    'apps/repository/fetch': appRoute('fetch this Git remote', async ({ appId, ref }) => {
      const result = await coordinate(appId, () => repositories.fetch(ref));
      audit({ type: 'git_remote_fetched', details: { kind: 'app', appId, host: result.remote.host } });
      return { ok: true, result };
    }),
    'apps/repository/push': appRoute('push this Git branch', async ({ appId, ref }, { branch }) => {
      if (branch !== undefined && typeof branch !== 'string') {
        return { ok: false, error: 'repository-branch-invalid' };
      }
      const result = await quiesce(appId, async () => {
        await repositories.commitApp(appId, { message: 'checkpoint before push' });
        return repositories.push(ref, { ref: branch });
      }, false);
      if (!result.ok) return {
        ok: false, error: 'The remote rejected this push. Fetch and reconcile before trying again.',
        outcomeKnown: true,
      };
      audit({ type: 'git_remote_pushed', details: {
        kind: 'app', appId, host: result.remote.host, branch: result.branch,
      } });
      return { ok: true, result };
    }),
    'apps/import-git': async (/** @type {any} */ message = {}) => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      if (typeof appFiles?.inspectApp !== 'function') {
        return { ok: false, error: 'browser Git is unavailable' };
      }
      let sessionId = null;
      let record = null;
      try {
        sessionId = await sessionCache?.sessionGet?.('currentSessionId') ?? null;
        record = await catalog.createImported({ name: message.name, ownerSessionId: sessionId });
        const ref = { kind: 'app', id: record.id };
        const repository = await repositories.clone(ref, {
          url: message.url,
          ...(typeof message.ref === 'string' && message.ref ? { ref: message.ref } : {}),
          depth: Math.min(500, Math.max(1, Number(message.depth) || 50)),
        });
        const { fileKinds, contract } = await appFiles.inspectApp(record.id);
        if (contract.capabilities.includes('dweb') && !allowDweb) {
          throw new Error('this dwapp requires a preview build with the dweb enabled');
        }
        const updated = await catalog.patch(record.id, {
          entryFile: contract.entry, fileKinds,
          ...(contract.capabilities.includes('dweb')
            ? { dweb: { uri: null, publisher: null, hash: null, local: true } } : {}),
        });
        if (!updated) throw new Error('App import catalog record disappeared');
        record = updated;
        if (typeof sessionId === 'string') await catalog.setDefaultForSession(sessionId, record.id);
        return { ok: true, record, repository, contract };
      } catch (cause) {
        const appId = record?.id;
        if (/** @type {{outcomeKnown?:boolean}} */ (cause)?.outcomeKnown === false) {
          return { ...failed(cause, 'finish the Git import'), ...(appId ? { appId } : {}) };
        }
        if (appId) {
          try {
            await repositories.destroy({ kind: 'app', id: appId }, { worktree: true });
            await catalog.remove(appId);
          } catch (cleanupCause) {
            return { ...failed(cleanupCause, 'clean up the failed Git import', false), appId };
          }
        }
        return { ok: false,
          error: /** @type {{message?:string}} */ (cause)?.message ?? String(cause) };
      }
    },
  });
};
