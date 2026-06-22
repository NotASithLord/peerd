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
    // Upsert a peer's overlay — the single write when you name/note/tag a peer.
    // Creates on first touch, patches the editable fields after.
    'contacts/set': async ({ did, name, notes, tags, favorite } = {}) => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      if (typeof did !== 'string') return { ok: false, error: 'did-required' };
      try {
        // why pass keys conditionally: applyContactPatch allowlists by presence,
        // so an omitted field is left untouched (a rename mustn't wipe notes).
        /** @type {Record<string, unknown>} */
        const patch = {};
        if (name !== undefined) patch.name = name;
        if (notes !== undefined) patch.notes = notes;
        if (tags !== undefined) patch.tags = tags;
        if (favorite !== undefined) patch.favorite = favorite;
        const contact = await contacts.upsert(did, patch);
        return { ok: true, contact };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },
    // Forget a peer's overlay (drops the name/notes; the did may still surface as
    // a "known" peer from its app/audit history — this only clears what you set).
    'contacts/forget': async ({ did } = {}) => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      if (typeof did !== 'string') return { ok: false, error: 'did-required' };
      try {
        const forgotten = await contacts.remove(did);
        return forgotten ? { ok: true } : { ok: false, error: 'contact-not-found' };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },
  };
};
