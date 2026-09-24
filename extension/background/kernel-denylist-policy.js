// @ts-check

import { makeDenylistStore } from './denylist-store.js';
import {
  flattenCategorisedDenylist,
  matchesDenylist,
  normalizeDenylistPattern,
} from '../peerd-egress/kernel-storage.js';

/**
 * @param {Object} deps
 * @param {{get:(key:string)=>Promise<any>,set:(key:string,value:any)=>Promise<any>}} deps.kv
 * @param {()=>Promise<any>} deps.readSeed
 * @param {string} [deps.overlayKey]
 */
export const createKernelDenylistPolicy = ({
  kv,
  readSeed,
  overlayKey = 'denylist.user.v1',
}) => {
  if (!kv || typeof readSeed !== 'function') {
    throw new TypeError('kernel-denylist-config-invalid');
  }
  const store = makeDenylistStore({
    kv,
    key: overlayKey,
    normalizePattern: normalizeDenylistPattern,
  });
  /** @type {Promise<{ok:boolean,error?:string}>|null} */ let loading = null;
  /** @type {Record<string, string[]>} */ let categories = {};
  let available = false;
  const ready = () => {
    loading ??= (async () => {
      try {
        const json = await readSeed();
        const seed = flattenCategorisedDenylist(json);
        if (!json || typeof json !== 'object' || !json.categories || seed.length === 0) {
          throw new Error('denylist seed is empty or malformed');
        }
        await store.load(seed);
        categories = Object.freeze(Object.fromEntries(
          Object.entries(json.categories)
            .filter(([, value]) => Array.isArray(value))
            .map(([name, value]) => [name, /** @type {unknown[]} */ (value)
              .filter((item) => typeof item === 'string')]),
        ));
        available = true;
        return Object.freeze({ ok: true });
      } catch (cause) {
        available = false;
        return Object.freeze({
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    })();
    return loading;
  };
  const blocks = (/** @type {string} */ hostname) => !available
    || matchesDenylist(hostname, store.patterns());
  const snapshot = async () => {
    const status = await ready();
    if (!status.ok) return status;
    const overlay = store.overlay();
    return Object.freeze({
      ok: true,
      patterns: Object.freeze([...store.patterns()]),
      added: Object.freeze([...overlay.added]),
      disabled: Object.freeze([...overlay.disabled]),
      categories,
    });
  };
  return Object.freeze({
    ready,
    isReady: () => available,
    blocks,
    patterns: store.patterns,
    snapshot,
    add: async (/** @type {unknown} */ pattern) => {
      const status = await ready();
      if (!status.ok) return status;
      return store.add(pattern);
    },
    remove: async (/** @type {unknown} */ pattern) => {
      const status = await ready();
      if (!status.ok) return status;
      return store.remove(pattern);
    },
  });
};

/** @param {Object} deps
 * @param {{snapshot:()=>Promise<any>,add:(pattern:unknown)=>Promise<any>,
 *   remove:(pattern:unknown)=>Promise<any>}} deps.policy
 * @param {{sync:()=>Promise<void>}} deps.networkCustody
 * @param {{append:(entry:{type:string,details?:Record<string,any>})=>Promise<any>}} deps.auditLog
 */
export const makeKernelDenylistRoutes = ({ policy, networkCustody, auditLog }) => {
  const edit = (/** @type {'add'|'remove'} */ operation, /** @type {string} */ auditType) =>
    async (/** @type {{pattern?:unknown}} */ { pattern } = {}) => {
      const result = await policy[operation](pattern);
      if (!result.ok) return result;
      void networkCustody.sync();
      auditLog.append({
        type: auditType, details: { pattern: result.pattern, seed: result.seed },
      }).catch(() => {});
      return policy.snapshot();
    };
  return Object.freeze({
    'denylist/add': edit('add', 'denylist_added'),
    'denylist/remove': edit('remove', 'denylist_removed'),
  });
};

/** @param {string} url */
export const kernelTabOrigin = (url) => {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'chrome:' || parsed.protocol === 'about:'
        || parsed.protocol === 'devtools:') {
      return `${parsed.protocol}//${parsed.host || parsed.pathname.split('/')[0] || ''}`;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
};
