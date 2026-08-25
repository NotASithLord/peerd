// @ts-check

class RepositoryEffectError extends Error {
  /** @param {string} operation @param {any} result */
  constructor(operation, result) {
    super(result?.error ?? result?.code ?? operation);
    this.code = result?.code ?? 'repository-operation-failed';
    this.outcomeKnown = result?.outcomeKnown === true;
  }
}

const effect = async (/** @type {any} */ context, /** @type {string} */ operation,
  /** @type {Record<string,unknown>} */ payload) => {
  const result = await context.effects.call(operation, payload);
  if (result?.ok !== true || result.outcomeKnown !== true) {
    throw new RepositoryEffectError(operation, result);
  }
  return result.value;
};
const failed = (/** @type {unknown} */ cause, /** @type {string} */ action) => {
  const error = /** @type {{code?:string,outcomeKnown?:boolean,message?:string}} */ (cause);
  const known = /** @type {any} */ (cause)?.outcomeKnown;
  if (known === false) throw cause;
  const outcomeKnown = known !== false;
  return {
    ok: false,
    code: error?.code ?? 'repository-operation-failed',
    outcomeKnown,
    retryable: outcomeKnown,
    error: outcomeKnown
      ? `Peerd could not ${action}. Try again.`
      : `Peerd could not confirm the result of trying to ${action}. Refresh Git history to reconcile before trying again.`,
  };
};
const appRoute = (/** @type {string} */ action, /** @type {string} */ operation,
  /** @type {(message:any)=>Record<string,unknown>} */ project) => async (
  /** @type {any} */ message = {}, /** @type {any} */ context,
) => {
  if (typeof message.appId !== 'string') return { ok: false, error: 'appId-required' };
  try { return await effect(context, operation, project(message)); }
  catch (cause) { return failed(cause, action); }
};

export const routes = Object.freeze({
  'apps/repository/status': appRoute('load Git history', 'repository.status',
    ({ appId }) => ({ appId })),
  'apps/repository/history': appRoute('load Git history', 'repository.history',
    ({ appId, depth }) => ({
      appId, depth: Number.isInteger(depth) ? Math.max(1, Math.min(100, depth)) : 20,
    })),
  'apps/repository/diff': async (/** @type {any} */ message = {}, /** @type {any} */ context) => {
    if (typeof message.appId !== 'string') return { ok: false, error: 'appId-required' };
    if (message.from !== undefined && typeof message.from !== 'string') {
      return { ok: false, error: 'repository-from-invalid' };
    }
    if (message.to !== undefined && message.to !== null && typeof message.to !== 'string') {
      return { ok: false, error: 'repository-to-invalid' };
    }
    try {
      return await effect(context, 'repository.diff', {
        appId: message.appId, from: message.from || 'HEAD', to: message.to || null,
      });
    } catch (cause) { return failed(cause, 'load this Git diff'); }
  },
  'apps/repository/commit': appRoute('save the Git checkpoint', 'repository.commit',
    ({ appId, message }) => ({
      appId, message: typeof message === 'string' && message ? message : 'manual edit',
    })),
  'apps/repository/restore': async (/** @type {any} */ message = {}, /** @type {any} */ context) => {
    if (typeof message.appId !== 'string' || typeof message.to !== 'string') {
      return { ok: false, error: 'appId-and-to-required' };
    }
    try { return await effect(context, 'repository.restore', { appId: message.appId, to: message.to }); }
    catch (cause) { return failed(cause, 'restore this Git version'); }
  },
  'apps/repository/branch': async (/** @type {any} */ message = {}, /** @type {any} */ context) => {
    if (typeof message.appId !== 'string' || typeof message.name !== 'string') {
      return { ok: false, error: 'appId-and-name-required' };
    }
    try {
      return await effect(context, 'repository.branch', {
        appId: message.appId, name: message.name, checkout: message.checkout !== false,
      });
    } catch (cause) { return failed(cause, 'create this Git branch'); }
  },
  'apps/repository/checkout': async (/** @type {any} */ message = {}, /** @type {any} */ context) => {
    if (typeof message.appId !== 'string' || typeof message.name !== 'string') {
      return { ok: false, error: 'appId-and-name-required' };
    }
    try {
      return await effect(context, 'repository.checkout', {
        appId: message.appId, name: message.name,
      });
    } catch (cause) { return failed(cause, 'switch this Git branch'); }
  },
  'apps/repository/link': async (/** @type {any} */ message = {}, /** @type {any} */ context) => {
    if (typeof message.appId !== 'string' || typeof message.url !== 'string') {
      return { ok: false, error: 'appId-and-url-required' };
    }
    try { return await effect(context, 'repository.link', { appId: message.appId, url: message.url }); }
    catch (cause) { return failed(cause, 'link this Git remote'); }
  },
  'apps/repository/fetch': appRoute('fetch this Git remote', 'repository.fetch',
    ({ appId }) => ({ appId })),
  'apps/repository/push': async (/** @type {any} */ message = {}, /** @type {any} */ context) => {
    if (typeof message.appId !== 'string') return { ok: false, error: 'appId-required' };
    if (message.branch !== undefined && typeof message.branch !== 'string') {
      return { ok: false, error: 'repository-branch-invalid' };
    }
    try {
      return await effect(context, 'repository.push', {
        appId: message.appId, branch: typeof message.branch === 'string' ? message.branch : null,
      });
    } catch (cause) { return failed(cause, 'push this Git branch'); }
  },
  'apps/import-git': async (/** @type {any} */ message = {}, /** @type {any} */ context) => {
    if (typeof message.url !== 'string') return { ok: false, error: 'invalid git remote URL' };
    try {
      return await effect(context, 'repository.import', {
        name: typeof message.name === 'string' ? message.name : null,
        url: message.url,
        ref: typeof message.ref === 'string' && message.ref ? message.ref : null,
        depth: Math.min(500, Math.max(1, Number(message.depth) || 50)),
      });
    } catch (cause) {
      if (/** @type {{outcomeKnown?:boolean}} */ (cause)?.outcomeKnown === false) throw cause;
      return { ok: false, error: /** @type {{message?:string}} */ (cause)?.message ?? String(cause) };
    }
  },
});
