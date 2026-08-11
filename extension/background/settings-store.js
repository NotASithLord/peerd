// @ts-check
// background/settings-store.js — per-profile settings behind a store, so every
// reader gets the LIVE merged view via a method instead of closing over a
// reassigned `let settings` singleton.
//
// why a store (step 2 of the SW decomposition): `settings` and `storedSettings`
// were module-level lets replaced wholesale on every update/reset. Dozens of
// read sites (the turn driver, buildToolContext, buildStateSnapshot,
// buildModelOptions, the dweb routes, …) read them directly, and the settings
// routes mutated them — which is why those routes had to stay inline. Behind a
// store, a reader calls `.get()` (always current) and the routes call
// `.update()` / `.reset()`.
//
// Migration semantics (Option A, PACKAGING.md) preserved exactly: `stored` holds
// ONLY the keys the user explicitly set (what persists + exports); the merged
// view is `{ ...defaults, ...stored }`, so a key absent from `stored` tracks the
// channel default across releases, and reset FORGETS keys rather than writing
// new values. Imports nothing (kv + defaults injected) → Bun-importable.

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
  // Every read-modify-write runs behind the initial storage read and behind the
  // previous mutation. A portless Options tab can wake a cold MV3 worker and
  // send a write before boot hydration settles; multiple live surfaces can also
  // write concurrently. Without one queue, either path can persist an older
  // snapshot last and silently discard otherwise-successful settings changes.
  let hydrated = false;
  /** @type {Promise<unknown>} */
  let operationTail = Promise.resolve();
  const recompute = () => { merged = { ...defaults, ...stored }; };
  /** @template T @param {() => Promise<T>} operation @returns {Promise<T>} */
  const enqueue = (operation) => {
    const result = operationTail.then(operation, operation);
    // A failed storage operation must reject its caller, but must not poison the
    // queue forever. The next operation retries hydration/persistence normally.
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
