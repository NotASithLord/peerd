// @ts-check
// background/routes/skills.js — skills (progressive-disclosure SKILL.md,
// feature 07) install/list/enable/remove routes.
//
// The remote install paths (git/manifest URL) are gated by REMOTE_SKILL_INSTALL
// (off for the store build) — the SW is the enforcement point, since hiding the
// UI tab doesn't stop another extension page from posting the message. No
// reassigned module state. Bodies verbatim, deps injected, imports none. The
// skillInstallError mapper moved in with its routes.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeSkillsRoutes = (deps) => {
  const {
    skillRegistry, webFetch, pushState, REMOTE_SKILL_INSTALL,
    installFromLocal, installFromGit, installFromManifest,
    SkillExistsError, SkillParseError, SkillInstallError,
  } = deps;

  // Map skill-install exceptions to stable error codes for the UI. Parse
  // and existence errors are user-actionable (bad SKILL.md / duplicate);
  // everything else surfaces its message.
  /** @param {unknown} e */
  const skillInstallError = (e) => {
    // why local: the error classes arrive through the `any` deps bag, so an
    // `instanceof` against them won't narrow `e` for tsc — read .message off a
    // typed view (these all extend Error and carry a string message).
    const msg = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
    if (e instanceof SkillExistsError) return { ok: false, error: 'already-installed', detail: msg };
    if (e instanceof SkillParseError) return { ok: false, error: 'parse-failed', detail: msg };
    if (e instanceof SkillInstallError) return { ok: false, error: 'install-failed', detail: msg };
    return { ok: false, error: msg };
  };

  return {
    'skills/list': async () => {
      const skills = await skillRegistry.list();
      // Strip nothing — metas are already description-only (no bodies). The
      // UI shows name, description, source, version, size, enabled.
      return { ok: true, skills };
    },

    'skills/installLocal': async ({ text, origin, replace }) => {
      try {
        const meta = await installFromLocal({ registry: skillRegistry }, { text, origin, replace });
        pushState();
        return { ok: true, skill: meta };
      } catch (e) {
        return skillInstallError(e);
      }
    },

    'skills/installGit': async ({ url, replace }) => {
      if (!REMOTE_SKILL_INSTALL) return { ok: false, error: 'remote-install-disabled' };
      if (typeof url !== 'string' || !url.trim()) return { ok: false, error: 'url-required' };
      try {
        const meta = await installFromGit({ registry: skillRegistry, webFetch }, { url, replace });
        pushState();
        return { ok: true, skill: meta };
      } catch (e) {
        return skillInstallError(e);
      }
    },

    'skills/installManifest': async ({ url, replace }) => {
      if (!REMOTE_SKILL_INSTALL) return { ok: false, error: 'remote-install-disabled' };
      if (typeof url !== 'string' || !url.trim()) return { ok: false, error: 'url-required' };
      try {
        const result = await installFromManifest({ registry: skillRegistry, webFetch }, { url, replace });
        pushState();
        // Partial success is normal — one bad entry shouldn't fail the batch.
        return { ok: true, installed: result.installed, failed: result.failed };
      } catch (e) {
        return skillInstallError(e);
      }
    },

    'skills/setEnabled': async ({ name, enabled }) => {
      if (typeof name !== 'string') return { ok: false, error: 'name-required' };
      try {
        const meta = await skillRegistry.setEnabled(name, !!enabled);
        pushState();
        return { ok: true, skill: meta };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    'skills/remove': async ({ name }) => {
      if (typeof name !== 'string') return { ok: false, error: 'name-required' };
      const removed = await skillRegistry.remove(name);
      pushState();
      return { ok: true, removed };
    },
  };
};
