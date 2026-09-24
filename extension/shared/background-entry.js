// @ts-check
// Resolve the one packaged background module from the browser-owned manifest.
// Chrome exposes service_worker; Firefox rewrites the same module into the
// first background.scripts entry. Callers fail closed when neither exists.

import { BACKGROUND_MODULE_PATH } from './build-config.js';

/** @param {Record<string, any>} manifest */
export const backgroundModulePath = (manifest) => {
  const serviceWorker = manifest?.background?.service_worker;
  if (typeof serviceWorker === 'string' && serviceWorker.length > 0) return serviceWorker;
  const script = manifest?.background?.scripts?.[0];
  return typeof script === 'string' && script.length > 0 ? script : null;
};

/** @param {{runtime?:{getManifest?:()=>any,getURL?:(path:string)=>string}}} browser */
export const backgroundModuleUrl = (browser) => {
  const discovered = backgroundModulePath(browser.runtime?.getManifest?.() ?? {});
  const path = discovered ?? BACKGROUND_MODULE_PATH;
  return path ? (browser.runtime?.getURL?.(path) ?? '') : '';
};
