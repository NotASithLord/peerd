// @ts-check

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
  /** @type {Promise<unknown>} */
  let operationTail = Promise.resolve();
  const recompute = () => { merged = { ...defaults, ...stored }; };
  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  const enqueue = (operation) => {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  };
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
     */
    update: (patch) => enqueue(async () => {
      await hydrate();
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

const LEARNED_KEY = 'learnedOrigins.v1';
const MAX_LEARNED = 500;
const LEARNED_REASONS = new Set(['password-field', 'confirmed-write']);
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

/** @param {unknown} value */
const parseLearnedRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
  const result = new Map();
  for (const [raw, reason] of Object.entries(value)) {
    const host = normalizeKernelLearnedHost(raw);
    if (host && LEARNED_REASONS.has(reason) && !result.has(host)
        && result.size < MAX_LEARNED) result.set(host, reason);
  }
  return result;
};

/** @param {Map<string, unknown>} learned */
const learnedResponse = (learned) => ({
  ok: true,
  origins: [...learned].map(([host, reason]) => ({ host, reason }))
    .sort((a, b) => a.host.localeCompare(b.host)),
});

/**
 * @param {Object} deps
 * @param {{get:(key:string)=>Promise<any>,set:(key:string,value:any)=>Promise<void>}} deps.kv
 * @param {{append:(entry:any)=>Promise<any>}} deps.auditLog
 * @param {(message:string,error:unknown)=>void} [deps.onError]
 */
export const makeKernelLearnedOriginRoutes = ({
  kv, auditLog, onError = (message, error) => console.warn(message, error),
}) => {
  if (!kv || !auditLog) throw new TypeError('kernel-learned-origins-config-invalid');
  let mutationTail = Promise.resolve();
  const load = async () => {
    try { return parseLearnedRecord(await kv.get(LEARNED_KEY)); }
    catch (error) {
      onError('[kernel] learned origins load failed', error);
      return new Map();
    }
  };
  /** @param {Map<string, unknown>} learned */
  const save = async (learned) => {
    try { await kv.set(LEARNED_KEY, Object.fromEntries(learned)); }
    catch (cause) {
      onError('[kernel] learned origins save failed', cause);
      const error = /** @type {Error & {code?:string,outcomeKnown?:boolean,cause?:unknown}} */ (
        new Error('The learned-origin change could not be confirmed.')
      );
      error.code = 'learned-origins-save-failed';
      error.outcomeKnown = false;
      error.cause = cause;
      throw error;
    }
  };
  /** @template T @param {()=>Promise<T>} operation */
  const mutate = (operation) => {
    const run = mutationTail.then(operation, operation);
    mutationTail = run.then(() => {}, () => {});
    return run;
  };
  const auditForgotten = (/** @type {string[]} */ hosts) => {
    for (const host of hosts) {
      auditLog.append({ type: 'origin_unlearned_sensitive', details: { host } }).catch(() => {});
    }
  };
  return Object.freeze({
    'learned/list': async () => learnedResponse(await load()),
    'learned/forget': async (/** @type {any} */ { host, origin } = {}) => mutate(async () => {
      const canonical = normalizeKernelLearnedHost(host ?? origin);
      if (!canonical) return { ok: false, error: 'invalid-origin' };
      const learned = await load();
      if (!learned.delete(canonical)) return { ok: false, error: 'not-learned' };
      await save(learned);
      auditForgotten([canonical]);
      return learnedResponse(learned);
    }),
    'learned/clear': async () => mutate(async () => {
      const learned = await load();
      const forgotten = [...learned.keys()];
      learned.clear();
      await save(learned);
      auditForgotten(forgotten);
      return { ...learnedResponse(learned), forgotten: forgotten.length };
    }),
  });
};
