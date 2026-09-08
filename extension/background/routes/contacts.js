// @ts-check
// background/routes/contacts.js — known-peer overlay routes.
//
// A contact is a user-owned overlay (name/notes/tags) on a peer's did:key.
// contacts/list returns the union of saved overlays + peers we've installed
// apps from + peers in the audit timeline, folded with a derived activity
// summary (mergeContacts) — no network, correct on every channel. No reassigned
// module state. Bodies verbatim, deps injected, imports none.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeContactsRoutes = (deps) => {
  const { vault, auditLog, contacts, appRegistry, mergeContacts } = deps;

  return {
    // --- contacts (known peers) -------------------------------------------
    // vault-gated like apps/* + memory/* (the overlay is plaintext-IDB user
    // content). The LIVE layer (currently linked / last seen on the mesh) is
    // added by the UI from dweb/distributed/info.
    'contacts/list': async () => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      try {
        const [saved, installedApps, auditEntries] = await Promise.all([
          contacts.list(),
          appRegistry.list(),
          auditLog.list(),
        ]);
        return { ok: true, contacts: mergeContacts({ saved, installedApps, auditEntries }) };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },
  };
};
