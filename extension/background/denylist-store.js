// @ts-check
// background/denylist-store.js — the denylist's seed + user-overlay state,
// behind a small store so route handlers and the egress hooks depend on a
// method (always-live) instead of a reassigned module-level singleton.
//
// why a store (step 2 of the SW decomposition): the dispatcher's denylist/*
// routes, composer/tabs, the web-tab hint, and webFetch's getDenylist all read
// a `let denylistPatterns` that's replaced wholesale on every edit. A captured
// reference would go stale, which is exactly why those routes had to stay inline
// in the SW. Encapsulating the state here lets them take `denylistStore` via
// deps and call `.patterns()` for the current value.
//
// Effective list = (seed − disabled) ∪ added. The seed is fetched IO-side by the
// SW (a bundled extension asset) and handed to load(); the overlay persists in
// kv. Imports nothing (kv + normalizePattern injected), so it's Bun-importable.

/**
 * @param {{
 *   kv: { get: (k: string) => Promise<any>, set: (k: string, v: any) => Promise<any> },
 *   key: string,
 *   normalizePattern: (raw: unknown) => string,
 * }} deps
 */
export const makeDenylistStore = ({ kv, key, normalizePattern }) => {
  /** @type {string[]} */
  let seed = [];
  /** @type {{ added: string[], disabled: string[] }} */
  let overlay = { added: [], disabled: [] };
  /** @type {string[]} */
  let effective = [];

  const recompute = () => {
    const disabled = new Set(overlay.disabled);
    const eff = seed.filter((p) => !disabled.has(p));
    for (const p of overlay.added) if (!eff.includes(p)) eff.push(p);
    effective = eff;
  };

  return {
    /** The effective denylist (seed − disabled ∪ added). Live; recomputed on edits. */
    patterns: () => effective,
    /** The user overlay, copied so callers can't mutate internal state. */
    overlay: () => ({ added: [...overlay.added], disabled: [...overlay.disabled] }),
    /**
     * Is `pattern` a bundled seed entry? (drives the `seed:` audit flag).
     * @param {string} pattern
     */
    isSeed: (pattern) => seed.includes(pattern),

    /**
     * Hydrate: take the (already-fetched, flattened) seed patterns and load the
     * persisted user overlay. Fail-open to an EMPTY overlay (the seed still
     * applies in full), never the reverse. Resolves; never rejects — so it can't
     * hang a turn that awaits denylistReady.
     * @param {string[]} seedPatterns
     */
    async load(seedPatterns) {
      seed = Array.isArray(seedPatterns) ? seedPatterns : [];
      try {
        const user = await kv.get(key);
        if (user && typeof user === 'object') {
          overlay = {
            added: Array.isArray(user.added) ? user.added.filter((/** @type {unknown} */ s) => typeof s === 'string') : [],
            disabled: Array.isArray(user.disabled) ? user.disabled.filter((/** @type {unknown} */ s) => typeof s === 'string') : [],
          };
        }
      } catch (e) {
        console.error('[denylist-store] user overlay load threw', e);
      }
      recompute();
    },

    /**
     * Add a pattern (or re-enable a disabled seed pattern). Returns the
     * normalized pattern + whether it was a seed entry, or an error.
     * @param {unknown} pattern
     */
    async add(pattern) {
      const p = normalizePattern(pattern);
      if (!p) return { ok: false, error: 'invalid-pattern' };
      if (overlay.disabled.includes(p)) {
        overlay = { ...overlay, disabled: overlay.disabled.filter((x) => x !== p) };
      } else if (!seed.includes(p) && !overlay.added.includes(p)) {
        overlay = { ...overlay, added: [...overlay.added, p] };
      }
      await kv.set(key, overlay);
      recompute();
      return { ok: true, pattern: p, seed: seed.includes(p) };
    },

    /**
     * Remove a user-added pattern, or DISABLE a seed pattern (seed entries
     * can't be deleted, only masked reversibly). 'not-found' if neither.
     * @param {unknown} pattern
     */
    async remove(pattern) {
      const p = normalizePattern(pattern);
      if (!p) return { ok: false, error: 'invalid-pattern' };
      if (overlay.added.includes(p)) {
        overlay = { ...overlay, added: overlay.added.filter((x) => x !== p) };
      } else if (seed.includes(p) && !overlay.disabled.includes(p)) {
        overlay = { ...overlay, disabled: [...overlay.disabled, p] };
      } else {
        return { ok: false, error: 'not-found' };
      }
      await kv.set(key, overlay);
      recompute();
      return { ok: true, pattern: p, seed: seed.includes(p) };
    },
  };
};
