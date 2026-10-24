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
  let user = { added: [], disabled: [] };
  /** @type {string[]} */ let rules = [];

  // why: derived rules disappear with their host; explicit wildcards stay independent.
  const added = () => [...new Set(user.added.flatMap((p) =>
    p.startsWith('*.') || seed.includes(p) ? [p] : [p, `*.${p}`]))];
  const refresh = () => { rules = [...new Set(seed.filter((p) => !user.disabled.includes(p)).concat(added()))]; };

  /** @type {Promise<any>} */ let tail = Promise.resolve();
  const edit = (/** @type {boolean} */ add, /** @type {unknown} */ pattern) => {
    const result = tail.then(async () => {
      let p = normalizePattern(pattern);
      if (!p) return { ok: false, error: 'invalid-pattern' };
      if (!add && p.startsWith('*.') && !user.added.includes(p)
          && user.added.includes(p.slice(2))) p = p.slice(2);
      const prior = user, before = rules;
      if (add) {
        if (user.disabled.includes(p)) user = { ...user, disabled: user.disabled.filter((x) => x !== p) };
        else if (!seed.includes(p) && !user.added.includes(p)) user = { ...user, added: [...user.added, p] };
      } else if (user.added.includes(p)) {
        user = { ...user, added: user.added.filter((x) => x !== p) };
      } else if (seed.includes(p) && !user.disabled.includes(p)) {
        user = { ...user, disabled: [...user.disabled, p] };
      } else return { ok: false, error: 'not-found' };
      refresh();
      const [from, to] = add ? [rules, before] : [before, rules];
      const patterns = from.filter((x) => !to.includes(x));
      try { await kv.set(key, user); }
      catch (error) {
        if (!add) { user = prior; refresh(); }
        throw error;
      }
      return { ok: true, pattern: p, seed: seed.includes(p), patterns };
    });
    tail = result.catch(() => {});
    return result;
  };

  return {
    patterns: () => rules,
    overlay: () => ({ added: added(), disabled: [...user.disabled] }),

    /** @param {string[]} patterns */
    async load(patterns) {
      seed = Array.isArray(patterns) ? patterns : [];
      const saved = await kv.get(key);
      if (saved == null) {
        user = { added: [], disabled: [] };
      } else if (typeof saved !== 'object' || Array.isArray(saved)
          || ['added', 'disabled'].some((field) => !Array.isArray(saved[field])
            || saved[field].some((/** @type {unknown} */ item) => typeof item !== 'string'))) {
        throw new TypeError('denylist user overlay is malformed');
      } else {
        user = { added: [...saved.added], disabled: [...saved.disabled] };
      }
      refresh();
    },

    /** @param {unknown} pattern */
    add: (pattern) => edit(true, pattern),
    /** @param {unknown} pattern */
    remove: (pattern) => edit(false, pattern),
  };
};
