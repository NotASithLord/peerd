// @ts-check

import { normalizeKeyedOrigin } from '/peerd-egress/kernel-credentials.js';

/** @param {{listSecretNames:()=>Promise<string[]>}} vault */
export const createKernelKeyedOriginAuthority = (vault) => {
  const origins = new Set();
  /** @type {Promise<boolean>|null} */ let pending = null;
  let ready = false;
  const hydrate = () => {
    if (ready) return Promise.resolve(true);
    pending ??= vault.listSecretNames().then((names) => {
      const next = new Set();
      for (const name of names) {
        if (!name.startsWith('origin:')) continue;
        const origin = normalizeKeyedOrigin(name.slice(7));
        if (origin) next.add(origin);
      }
      origins.clear();
      for (const origin of next) origins.add(origin);
      ready = true;
      return true;
    }).catch(() => false).finally(() => { pending = null; });
    return pending;
  };
  return Object.freeze({
    hydrate,
    has: (/** @type {string} */ origin) => origins.has(origin),
    add: (/** @type {string} */ origin) => {
      const canonical = normalizeKeyedOrigin(origin);
      if (canonical) origins.add(canonical);
    },
    remove: (/** @type {string} */ origin) => {
      const canonical = normalizeKeyedOrigin(origin);
      if (canonical) origins.delete(canonical);
    },
  });
};
