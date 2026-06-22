// @ts-check
// background/routes/hooks.js — pre/post-tool-use hook management (feature 10).
//
// The Context → Hooks tab reads + edits user hooks through these. No reassigned
// module state. Bodies verbatim, deps injected, imports none.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeHooksRoutes = (deps) => {
  const {
    auditLog, kv,
    listHooks, DEFAULT_HOOKS, parseHookMarkdown, saveUserHook, removeHook, exportHooks,
  } = deps;

  return {
    // ---- Hooks management (feature 10) -----------------------------------
    // The Context → Hooks tab reads + edits user hooks through these.
    // Default (code) hooks surface in list but can't be removed or
    // disabled — reversibility is for USER config, not the always-on
    // egress floor. Every mutation is audited (same discipline as
    // denylist edits: hooks are security-relevant policy state).
    'hooks/list': async () => ({
      ok: true,
      hooks: listHooks().map((/** @type {any} */ h) => ({
        id: h.id,
        event: h.event,
        enabled: h.enabled !== false,
        order: h.order ?? 100,
        match: h.match ?? '*',
        isDefault: DEFAULT_HOOKS.some((/** @type {any} */ d) => d.id === h.id),
        // why: the UI shows provenance + one human line per hook. Defaults
        // carry `description` in code (doubling as the visible reason they
        // can't be disabled); user hooks carry their markdown prose +
        // body kind in the serializable record.
        kind: h._record?.kind ?? 'builtin',
        doc: h._record?.doc ?? h.description ?? '',
      })),
    }),

    // Save a user hook. Accepts either a parsed record or raw markdown
    // (parsed here). Throws surface as ok:false so the UI can show the
    // compile error rather than the SW dying.
    'hooks/save': async ({ record, markdown }) => {
      try {
        const rec = markdown ? parseHookMarkdown(markdown) : record;
        const compiled = await saveUserHook({ kv }, rec);
        auditLog.append({
          type: 'hook_added',
          details: { id: compiled.id, event: rec.event, kind: rec.kind },
        }).catch(() => {});
        return { ok: true, id: compiled.id };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    'hooks/remove': async ({ id }) => {
      if (DEFAULT_HOOKS.some((/** @type {any} */ d) => d.id === id)) {
        return { ok: false, error: 'cannot remove a default hook' };
      }
      await removeHook({ kv }, id);
      auditLog.append({ type: 'hook_removed', details: { id } }).catch(() => {});
      return { ok: true };
    },

    // Enable/disable ONE user hook in place (the Hooks tab's toggle).
    // Defaults are refused: they're code, and the egress-allowlist floor
    // in particular must not be switchable off from config. The record
    // round-trips through saveUserHook so the change persists AND
    // recompiles into the live registry without a reload. Disabling is
    // the louder audit event — protection being turned off must stay
    // visible (mirrors denylist_removed).
    'hooks/toggle': async ({ id, enabled }) => {
      if (DEFAULT_HOOKS.some((/** @type {any} */ d) => d.id === id)) {
        return { ok: false, error: 'cannot disable a built-in hook' };
      }
      const record = exportHooks().find((/** @type {any} */ r) => r.id === id);
      if (!record) return { ok: false, error: 'not-found' };
      const on = enabled === true;
      try {
        await saveUserHook({ kv }, { ...record, enabled: on });
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
      auditLog.append({
        type: on ? 'hook_enabled' : 'hook_disabled',
        details: { id },
      }).catch(() => {});
      return { ok: true };
    },
  };
};
