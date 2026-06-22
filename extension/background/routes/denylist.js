// @ts-check
// background/routes/denylist.js — the user's Logs-view denylist editor.
//
// Unblocked by background/denylist-store.js: these used to read + replace the
// reassigned module-level denylist singletons, so they had to stay inline. Now
// they take the store and call its methods, so they move out like every other
// stable-collaborator route. The store owns the seed/overlay/recompute + kv
// persistence; the route owns the audit + reply shape. Imports nothing.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeDenylistRoutes = (deps) => {
  const { denylistStore, auditLog } = deps;

  // The shared { patterns, added, disabled } reply every denylist route returns.
  const snapshot = () => {
    const o = denylistStore.overlay();
    return { ok: true, patterns: [...denylistStore.patterns()], added: o.added, disabled: o.disabled };
  };

  return {
    'denylist/list': async () => snapshot(),

    // Add a pattern (or re-enable a disabled seed pattern). Audited —
    // denylist edits are security-relevant state transitions. why `seed`:
    // mirrors denylist_removed's flag so the audit trail can distinguish
    // "re-enabled a built-in protection" from "added their own pattern".
    'denylist/add': async ({ pattern }) => {
      const r = await denylistStore.add(pattern);
      if (!r.ok) return r;
      auditLog.append({ type: 'denylist_added', details: { pattern: r.pattern, seed: r.seed } }).catch(() => {});
      return snapshot();
    },

    // Remove a user-added pattern, or DISABLE a seed pattern (seed entries
    // can't be deleted — only masked, reversibly). Audited for the same reason
    // as add; disabling seed protection is the louder event.
    'denylist/remove': async ({ pattern }) => {
      const r = await denylistStore.remove(pattern);
      if (!r.ok) return r;
      auditLog.append({ type: 'denylist_removed', details: { pattern: r.pattern, seed: r.seed } }).catch(() => {});
      return snapshot();
    },
  };
};
