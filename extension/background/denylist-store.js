// @ts-check

export class DenylistPolicyUnavailableError extends Error {
  constructor() {
    super('The sensitive-origin policy is unavailable. Tool execution is paused.');
    this.name = 'DenylistPolicyUnavailableError';
  }
}

/** @param {{ ok?: boolean } | null | undefined} status */
export const requireDenylistPolicy = (status) => {
  if (status?.ok !== true) throw new DenylistPolicyUnavailableError();
};

/**
 * @param {{
 *   kv: { get: (k: string) => Promise<any>, set: (k: string, v: any) => Promise<any> },
 *   key: string,
 *   normalizePattern: (raw: unknown) => string | null,
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
    patterns: () => effective,
    overlay: () => ({ added: [...overlay.added], disabled: [...overlay.disabled] }),
    /** @param {string} pattern */
    isSeed: (pattern) => seed.includes(pattern),

    /** @param {string[]} seedPatterns */
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

    /** @param {unknown} pattern */
    async add(pattern) {
      const p = normalizePattern(pattern);
      if (!p) return { ok: false, error: 'invalid-pattern' };
      if (overlay.disabled.includes(p)) {
        overlay = { ...overlay, disabled: overlay.disabled.filter((x) => x !== p) };
      } else if (!seed.includes(p) && !overlay.added.includes(p)) {
        overlay = { ...overlay, added: [...overlay.added, p] };
      }
      recompute();
      await kv.set(key, overlay);
      return { ok: true, pattern: p, seed: seed.includes(p) };
    },

    /** @param {unknown} pattern */
    async remove(pattern) {
      const p = normalizePattern(pattern);
      if (!p) return { ok: false, error: 'invalid-pattern' };
      const previous = overlay;
      if (overlay.added.includes(p)) {
        overlay = { ...overlay, added: overlay.added.filter((x) => x !== p) };
      } else if (seed.includes(p) && !overlay.disabled.includes(p)) {
        overlay = { ...overlay, disabled: [...overlay.disabled, p] };
      } else {
        return { ok: false, error: 'not-found' };
      }
      recompute();
      try { await kv.set(key, overlay); }
      catch (error) {
        overlay = previous;
        recompute();
        throw error;
      }
      return { ok: true, pattern: p, seed: seed.includes(p) };
    },
  };
};
