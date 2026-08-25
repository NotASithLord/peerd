// @ts-check

import { KERNEL_REPOSITORY_ROUTE_NAMES } from '../shared/kernel-feature-route-inventory.js';
import { createKernelFeatureControl } from './kernel-feature-control.js';

const success = (/** @type {unknown} */ value) => Object.freeze({
  ok: true, outcomeKnown: true, value,
});
const failure = (/** @type {string} */ code, /** @type {boolean} */ outcomeKnown,
  /** @type {unknown} */ cause = undefined) => Object.freeze({
  ok: false, code, outcomeKnown,
  error: /** @type {{message?:string}} */ (cause)?.message ?? code,
});
const same = (/** @type {unknown} */ left, /** @type {unknown} */ right) => {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
};
const expected = (/** @type {string} */ operation, /** @type {any} */ message) => {
  if (!message || typeof message !== 'object') return null;
  const appId = message.appId;
  const projections = {
    'repository.status': { appId },
    'repository.history': {
      appId, depth: Number.isInteger(message.depth) ? Math.max(1, Math.min(100, message.depth)) : 20,
    },
    'repository.diff': { appId, from: message.from || 'HEAD', to: message.to || null },
    'repository.commit': {
      appId, message: typeof message.message === 'string' && message.message
        ? message.message : 'manual edit',
    },
    'repository.restore': { appId, to: message.to },
    'repository.branch': { appId, name: message.name, checkout: message.checkout !== false },
    'repository.checkout': { appId, name: message.name },
    'repository.link': { appId, url: message.url },
    'repository.fetch': { appId },
    'repository.push': {
      appId, branch: typeof message.branch === 'string' ? message.branch : null,
    },
    'repository.import': {
      name: typeof message.name === 'string' ? message.name : null,
      url: message.url,
      ref: typeof message.ref === 'string' && message.ref ? message.ref : null,
      depth: Math.min(500, Math.max(1, Number(message.depth) || 50)),
    },
  };
  return projections[/** @type {keyof typeof projections} */ (operation)] ?? null;
};

/** @param {Record<string,any>} deps */
export const createKernelRepositoryControl = (deps) => {
  if (typeof deps.callFeature !== 'function' || !deps.repositories || !deps.catalog
      || !deps.vault || !deps.browser?.tabs || !deps.auditLog
      || typeof deps.appTabUrl !== 'string' || !deps.appTabUrl) {
    throw new TypeError('kernel-repository-control-config-invalid');
  }
  const audit = (/** @type {any} */ entry) => { void deps.auditLog.append(entry).catch(() => {}); };
  const appRef = async (/** @type {unknown} */ appId) => {
    if (typeof appId !== 'string') throw Object.assign(new Error('appId-required'), {
      code: 'appId-required', outcomeKnown: true,
    });
    if (deps.vault.isLocked()) throw Object.assign(new Error('vault-locked'), {
      code: 'vault-locked', outcomeKnown: true,
    });
    if (!await deps.catalog.get(appId)) throw Object.assign(new Error('app-not-found'), {
      code: 'app-not-found', outcomeKnown: true,
    });
    return { kind: 'app', id: appId };
  };
  const wait = deps.wait ?? ((/** @type {number} */ ms) => new Promise(
    (resolve) => setTimeout(resolve, ms),
  ));
  const quiesceTimeoutMs = deps.quiesceTimeoutMs ?? 5_000;
  const bounded = (/** @type {Promise<any>} */ work) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (/** @type {unknown} */ value, /** @type {boolean} */ ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok) resolve(value); else reject(value);
    };
    const timer = setTimeout(() => finish(Object.assign(
      new Error('App editor did not finish saving before the Git operation.'),
      { outcomeKnown: true },
    ), false), quiesceTimeoutMs);
    work.then((value) => finish(value, true), (cause) => finish(cause, false));
  });
  const withQuiescedApp = async (/** @type {string} */ appId,
    /** @type {()=>Promise<any>} */ operation, close = true) => {
    const tabs = await deps.browser.tabs.query({ url: `${deps.appTabUrl}#${appId}*` });
    if (tabs.length > 1) throw Object.assign(
      new Error('multiple App tabs claim this repository'), { outcomeKnown: true },
    );
    const tab = tabs[0];
    if (typeof tab?.id !== 'number') return operation();
    const acquisition = Promise.resolve(deps.browser.tabs.sendMessage(
      tab.id, { type: 'app/quiesce', action: 'acquire', appId },
    ));
    let reply;
    try { reply = await bounded(acquisition); }
    catch (cause) {
      void acquisition.then((late) => late?.ok
        ? deps.browser.tabs.sendMessage(tab.id, {
          type: 'app/quiesce', action: 'release', appId,
        }).catch(() => deps.browser.tabs.reload?.(tab.id)) : undefined).catch(() => {});
      throw cause;
    }
    if (!reply?.ok) throw Object.assign(
      new Error(reply?.error ?? 'App editor could not be frozen'), { outcomeKnown: true },
    );
    if (!close) {
      try { return await operation(); }
      finally {
        await deps.browser.tabs.sendMessage(tab.id, {
          type: 'app/quiesce', action: 'release', appId,
        }).catch(() => deps.browser.tabs.reload?.(tab.id));
      }
    }
    const url = typeof tab.url === 'string' ? tab.url : `${deps.appTabUrl}#${appId}`;
    await deps.browser.tabs.remove(tab.id);
    await wait(100);
    try { return await operation(); }
    finally { await deps.browser.tabs.create({ url, active: false }).catch(() => {}); }
  };
  const coordinate = (/** @type {string} */ appId, /** @type {()=>Promise<any>} */ operation) =>
    deps.repositories.coordinate({ kind: 'app', id: appId }, operation);
  const quiesce = (/** @type {string} */ appId, /** @type {()=>Promise<any>} */ operation,
    close = true) => withQuiescedApp(appId, () => coordinate(appId, operation), close);
  const run = async (/** @type {string} */ operation, /** @type {any} */ payload,
    /** @type {any} */ context) => {
    const message = context?.message;
    const projection = expected(operation, message);
    if (projection && !same(projection, payload)) {
      return failure('repository-effect-substitution', true);
    }
    if (context?.signal?.aborted) return failure('repository-call-aborted', true);
    const signal = context?.signal;
    if (operation === 'repository.import') {
      if (!projection || deps.vault.isLocked()) return failure('vault-locked', true);
      const sessionId = await deps.sessionCache?.sessionGet?.('currentSessionId') ?? null;
      let record = await deps.catalog.createImported({
        name: payload.name, ownerSessionId: sessionId,
      });
      try {
        const repository = await deps.repositories.clone({ kind: 'app', id: record.id }, {
          url: payload.url,
          ...(payload.ref ? { ref: payload.ref } : {}),
          depth: payload.depth,
          signal,
        });
        const { fileKinds, contract } = await deps.appFiles.inspectApp(record.id);
        if (contract.capabilities.includes('dweb') && deps.allowDweb !== true) {
          throw Object.assign(
            new Error('this dwapp requires a preview build with the dweb enabled'),
            { outcomeKnown: true },
          );
        }
        const updated = await deps.catalog.patch(record.id, {
          entryFile: contract.entry, fileKinds,
          ...(contract.capabilities.includes('dweb')
            ? { dweb: { uri: null, publisher: null, hash: null, local: true } } : {}),
        });
        if (!updated) throw Object.assign(
          new Error('App import catalog record disappeared'), { outcomeKnown: true },
        );
        record = updated;
        if (typeof sessionId === 'string') {
          await deps.catalog.setDefaultForSession(sessionId, record.id);
        }
        return success({ ok: true, record, repository, contract });
      } catch (cause) {
        if (/** @type {{outcomeKnown?:boolean}} */ (cause)?.outcomeKnown === false) {
          return failure('repository-import-outcome-unknown', false, cause);
        }
        try {
          await deps.repositories.destroy({ kind: 'app', id: record.id }, {
            worktree: true, signal,
          });
          await deps.catalog.remove(record.id);
        } catch (cleanupCause) {
          return failure('repository-import-rollback-unknown', false, cleanupCause);
        }
        return success({
          ok: false, error: /** @type {{message?:string}} */ (cause)?.message ?? String(cause),
        });
      }
    }
    if (!projection) return failure('kernel-operation-denied', true);
    const appId = payload.appId;
    let ref;
    try { ref = await appRef(appId); }
    catch (cause) {
      const code = /** @type {{code?:string}} */ (cause)?.code;
      if (code === 'appId-required' || code === 'vault-locked' || code === 'app-not-found') {
        return success({ ok: false, error: code });
      }
      throw cause;
    }
    if (operation === 'repository.status') {
      const [status, remote, branches] = await Promise.all([
        deps.repositories.statusApp(appId),
        deps.repositories.getAppRemote(appId),
        deps.repositories.branches(ref),
      ]);
      return success({ ok: true, status, remote, branches });
    }
    if (operation === 'repository.history') return success({
      ok: true,
      commits: await deps.repositories.historyApp(appId, {
        depth: payload.depth, includeSafety: true, signal,
      }),
    });
    if (operation === 'repository.diff') return success({
      ok: true,
      diff: await deps.repositories.diffApp(appId, {
        from: payload.from, to: payload.to, signal,
      }),
    });
    if (operation === 'repository.commit') {
      const result = await quiesce(appId, () => deps.repositories.commitApp(appId, {
        message: payload.message, signal,
      }), false);
      audit({ type: 'git_commit_created', details: {
        kind: 'app', appId, oid: result.oid, changed: result.changed.length,
      } });
      return success({ ok: true, result });
    }
    if (operation === 'repository.restore') {
      const result = await quiesce(appId, () => deps.repositories.restoreApp(appId, {
        to: payload.to, signal,
      }));
      audit({ type: 'git_version_restored', details: {
        kind: 'app', appId, to: payload.to, oid: result.oid,
      } });
      return success({ ok: true, result });
    }
    if (operation === 'repository.branch') {
      const task = () => deps.repositories.branch(ref, {
        name: payload.name, checkout: payload.checkout, signal,
      });
      const result = payload.checkout ? await quiesce(appId, task) : await coordinate(appId, task);
      return success({ ok: true, result });
    }
    if (operation === 'repository.checkout') return success({
      ok: true,
      result: await quiesce(appId, () => deps.repositories.checkout(ref, {
        name: payload.name, signal,
      })),
    });
    if (operation === 'repository.link') {
      const remote = await coordinate(appId, () => deps.repositories.setRemote(ref, {
        url: payload.url, signal,
      }));
      audit({ type: 'git_remote_linked', details: {
        kind: 'app', appId, host: remote.host, url: remote.url,
      } });
      return success({ ok: true, remote });
    }
    if (operation === 'repository.fetch') {
      const result = await coordinate(appId, () => deps.repositories.fetch(ref, { signal }));
      audit({ type: 'git_remote_fetched', details: {
        kind: 'app', appId, host: result.remote.host,
      } });
      return success({ ok: true, result });
    }
    if (operation === 'repository.push') {
      const result = await quiesce(appId, async () => {
        await deps.repositories.commitApp(appId, { message: 'checkpoint before push', signal });
        return deps.repositories.push(ref, { ref: payload.branch ?? undefined, signal });
      }, false);
      if (!result.ok) return success({
        ok: false,
        error: 'The remote rejected this push. Fetch and reconcile before trying again.',
        outcomeKnown: true,
      });
      audit({ type: 'git_remote_pushed', details: {
        kind: 'app', appId, host: result.remote.host, branch: result.branch,
      } });
      return success({ ok: true, result });
    }
    return failure('kernel-operation-denied', true);
  };
  const feature = createKernelFeatureControl({
    call: (_capability, payload, options) => deps.callFeature(payload, options),
    handleEffect: async (operation, payload, context) => {
      try { return await run(operation, payload, context); }
      catch (cause) {
        const known = /** @type {{outcomeKnown?:unknown}} */ (cause)?.outcomeKnown !== false;
        return failure(
          /** @type {{code?:string}} */ (cause)?.code ?? 'repository-operation-failed', known, cause,
        );
      }
    },
  });
  const routes = Object.freeze(Object.fromEntries(KERNEL_REPOSITORY_ROUTE_NAMES.map((route) => [
    route,
    async (/** @type {any} */ message = {}) => {
      const result = await feature.dispatch('repository', route, message);
      return result?.ok === true && Object.hasOwn(result, 'value') ? result.value : result;
    },
  ])));
  return Object.freeze({
    routes, authorize: feature.authorize, handleKernelCall: feature.handleKernelCall,
  });
};
