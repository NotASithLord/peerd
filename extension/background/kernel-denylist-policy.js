// @ts-check
// Lazy authority-kernel denylist policy. Construction performs no fetch or
// storage read. The first security consumer loads the packaged seed plus the
// user overlay; a load failure makes every web origin blocked.

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
  return Object.freeze({
    ready,
    blocks,
    patterns: store.patterns,
    snapshot: async () => {
      await ready();
      const overlay = store.overlay();
      return Object.freeze({
        ok: true,
        patterns: Object.freeze([...store.patterns()]),
        added: Object.freeze([...overlay.added]),
        disabled: Object.freeze([...overlay.disabled]),
        categories,
      });
    },
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
