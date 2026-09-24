// @ts-check

import { parseAppManifest } from '/peerd-engine/app-manifest.js';

const unknown = (/** @type {string} */ code, /** @type {string} */ action) => ({
  ok: false,
  error: `Peerd could not confirm whether ${action} finished. Refresh to reconcile before trying again.`,
  code,
  outcomeKnown: false,
  outcomeKind: 'unknown',
  retryable: false,
});

/** @param {any} result @param {string} code @param {string} action */
const mutation = (result, code, action) => result?.ok === true
  ? result.value : unknown(code, action);

/** @param {string} route @param {any} message
 * @param {{kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} options */
export const dispatchAppSemanticRoute = async (route, message, options) => {
  if (typeof options.kernelCall !== 'function') {
    return { ok: false, code: 'semantic-app-route-refused', outcomeKnown: true };
  }
  const call = options.kernelCall;
  if (route === 'apps/favorite') {
    if (typeof message?.appId !== 'string') return { ok: false, error: 'appId-required' };
    if (typeof message.favorite !== 'boolean') {
      return { ok: false, error: 'favorite-boolean-required' };
    }
    const app = mutation(await call('semantic.apps.favorite', {
      appId: message.appId, favorite: message.favorite,
    }), 'app-favorite-outcome-unknown', 'the favorite update');
    return app?.ok === false ? app
      : app ? { ok: true, app } : { ok: false, error: 'app-not-found' };
  }
  if (route === 'apps/rename') {
    if (typeof message?.appId !== 'string') return { ok: false, error: 'appId-required' };
    if (typeof message.name !== 'string' || !message.name.trim()) {
      return { ok: false, error: 'name-required' };
    }
    const app = mutation(await call('semantic.apps.rename', {
      appId: message.appId, name: message.name.trim().slice(0, 80),
    }), 'app-rename-outcome-unknown', 'the App rename');
    if (app?.ok === false) return app;
    if (!app) return { ok: false, error: 'app-not-found' };
    const reload = await call('semantic.apps.reload', { appId: message.appId });
    if (reload?.ok !== true && reload?.outcomeKnown !== true) {
      return unknown('app-rename-outcome-unknown', 'the App rename');
    }
    return { ok: true, app };
  }
  if (route === 'apps/open') {
    if (typeof message?.appId !== 'string') return { ok: false, error: 'appId-required' };
    const result = await call('semantic.apps.open', { appId: message.appId });
    if (result?.ok !== true) return unknown('app-open-outcome-unknown', 'opening the App');
    return result.value === true ? { ok: true } : { ok: false, error: 'app-not-found' };
  }
  if (route !== 'app/get-meta' || !message?.app || typeof message.app !== 'object') {
    return { ok: false, code: 'semantic-app-route-refused', outcomeKnown: true };
  }
  let app = message.app;
  let runtimeDweb = app.dweb ?? null;
  let runtimeAgent = { kind: 'bound-app', profile: 'developer', surface: 'code' };
  if (typeof message.manifestText === 'string') {
    try {
      const contract = parseAppManifest(message.manifestText);
      const paths = new Set((Array.isArray(message.paths) ? message.paths : [])
        .filter((/** @type {unknown} */ path) => typeof path === 'string')
        .map((/** @type {string} */ path) => path.replace(/^\/+/, '')));
      if (!paths.has(contract.entry)) {
        return { ok: false, error: `peerd.json entry is missing: ${contract.entry}` };
      }
      runtimeDweb = contract.capabilities.includes('dweb') && message.dwebEnabled === true
        ? (app.dweb ?? { uri: null, publisher: null, hash: null, local: true }) : null;
      runtimeAgent = contract.agent;
      if (contract.entry !== app.entryFile) {
        const updated = mutation(await call('semantic.apps.set-entry', {
          appId: app.id, entryFile: contract.entry,
        }), 'app-entry-update-outcome-unknown', 'the App entry update');
        if (updated?.ok === false) return updated;
        if (updated) app = updated;
      }
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  return {
    ok: true,
    name: app.name,
    entryFile: app.entryFile,
    fileKinds: app.fileKinds ?? {},
    dweb: runtimeDweb,
    agent: runtimeAgent,
  };
};
