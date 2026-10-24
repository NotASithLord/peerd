// @ts-check

import { makeSerialLane } from '../shared/cold-util.js';

/**
 * @param {{
 *   kv: { get: (k: string) => Promise<any>, set: (k: string, v: any) => Promise<any> },
 *   key: string,
 *   defaults: Record<string, any>,
 * }} deps
 */
export const makeSettingsStore = ({ kv, key, defaults }) => {
  /** ONLY the user-set keys (persisted + exported). @type {Record<string, any>} */
  let stored = {};
  /** The merged view consumers read: { ...defaults, ...stored }. */
  let merged = { ...defaults };
  let hydrated = false;
  const enqueue = makeSerialLane();
  const recompute = () => { merged = { ...defaults, ...stored }; };
  const hydrate = async () => {
    if (hydrated) return merged;
    const s = await kv.get(key);
    if (s && typeof s === 'object') { stored = { ...s }; recompute(); }
    hydrated = true;
    return merged;
  };

  return {
    /** The live merged view (defaults overlaid with user choices). */
    get: () => merged,
    /** The user-set keys only — what transfer/export ships + reset forgets from. */
    stored: () => stored,

    /** Hydrate from kv. A stored object wins verbatim (Option A). */
    load: () => enqueue(hydrate),

    /**
     * Apply a (already-validated) patch: merge into stored, persist, return merged.
     * @param {Record<string, any>} patch
     * @param {()=>boolean} [current]
     */
    update: (patch, current = () => true) => enqueue(async () => {
      if (!current()) throw new Error('settings-authority-retired');
      await hydrate();
      if (!current()) throw new Error('settings-authority-retired');
      const next = { ...stored, ...patch };
      await kv.set(key, next);
      stored = next;
      recompute();
      return merged;
    }),

    /**
     * Reset keys to channel defaults by FORGETTING the stored values.
     * @param {string[]} keys
     */
    reset: (keys) => enqueue(async () => {
      await hydrate();
      const next = { ...stored };
      for (const k of keys) delete next[k];
      await kv.set(key, next);
      stored = next;
      recompute();
      return merged;
    }),
  };
};

const PUBLIC_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

/** @param {unknown} input */
export const normalizeKernelLearnedHost = (input) => {
  let value = String(input ?? '').trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)
        || !PUBLIC_HOST.test(parsed.hostname)) return null;
    return parsed.hostname;
  } catch { return null; }
};

/** @param {any} deps */
export const makeKernelLearnedOriginRoutes = ({
  learnedOrigins, onError = (/** @type {string} */ message, /** @type {unknown} */ error) => console.warn(message, error),
}) => {
  const response = () => ({ ok: true, origins: learnedOrigins.entries() });
  const saved = async () => {
    try { await learnedOrigins.settled({ strict: true }); }
    catch (cause) {
      onError('[kernel] learned origins save failed', cause);
      throw Object.assign(new Error('The learned-origin change could not be confirmed.'), {
        code: 'learned-origins-save-failed', outcomeKnown: false, cause,
      });
    }
  };
  return Object.freeze({
    'learned/list': async () => { await learnedOrigins.hydrate(); return response(); },
    'learned/forget': async (/** @type {any} */ { host, origin } = {}) => {
      const canonical = normalizeKernelLearnedHost(host ?? origin);
      if (!canonical) return { ok: false, error: 'invalid-origin' };
      await learnedOrigins.hydrate();
      if (!learnedOrigins.forget(canonical)) return { ok: false, error: 'not-learned' };
      await saved();
      return response();
    },
    'learned/clear': async () => {
      await learnedOrigins.hydrate();
      const forgotten = learnedOrigins.clear();
      await saved();
      return { ...response(), forgotten };
    },
  });
};
