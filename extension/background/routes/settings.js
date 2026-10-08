// @ts-check
// Private settings export remains here; mutation routes belong to the native
// authority owner in settings-patch.js. The transfer router selects this export
// capability explicitly, so it cannot mint a second settings mutation surface.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeSettingsRoutes = (deps) => {
  const {
    vault, auditLog, kv, memory, settingsStore,
    buildExport, CHANNEL, exportHooks, skillRegistry, dwebTransfer,
    EXPORT_PASSPHRASE_MIN_LENGTH, isCustodySecretName,
    privateTransferAuthorization, ensureSettingsReady,
  } = deps;
  const awaitSettings = async () => {
    try { await ensureSettingsReady?.(); return true; }
    catch { return false; }
  };

  return {
    // --- transfer: explicit settings export (dual-distribution §10) ---
    //
    // The ONLY migration path between installs (store ↔ preview). No background
    // sync, no shared storage — different extension IDs keep the two builds
    // isolated; the user moves state by file, in the clear about what travels
    // (credentials ride encrypted under an export passphrase; the vault DK never
    // leaves the vault). The import half lives in routes/system.js.
    'transfer/export': async ({ passphrase, privateTransferAuthorization: authorization }) => {
      if (authorization !== privateTransferAuthorization) {
        return { ok: false, error: 'private-transfer-required' };
      }
      if (!(await awaitSettings())) return { ok: false, error: 'settings-unavailable' };
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      const names = await vault.listSecretNames();
      if (names.length > 0
          && (typeof passphrase !== 'string' || passphrase.length < EXPORT_PASSPHRASE_MIN_LENGTH)) {
        // A backup may unlock both stored credentials and a permanent peer identity.
        return { ok: false, error: 'passphrase-required' };
      }
      /** @type {Record<string, string>} */
      const secrets = {};
      for (const name of names.filter((/** @type {string} */ candidate) => !isCustodySecretName(candidate))) {
        const value = await vault.getSecret(name);
        if (typeof value === 'string') secrets[name] = value;
      }
      let dweb = null;
      try {
        dweb = dwebTransfer ? await dwebTransfer.exportRecord(passphrase) : null;
      } catch {
        // Once a local identity exists, omitting it would create a backup that
        // looks successful but cannot restore the user's permanent did.
        return { ok: false, error: 'identity-export-failed' };
      }
      const payload = await buildExport({
        channel: CHANNEL,
        storedSettings: { ...settingsStore.stored() },
        providerEndpoints: (await kv.get('provider_endpoints.v1')) ?? null,
        secrets,
        passphrase,
        memory: await memory.exportAll(),
        hooks: await exportHooks(),
        skills: await skillRegistry.list(),
        // The did:key travels ONLY as this capsule record (built offscreen,
        // openable with the same export passphrase) — buildExport excludes
        // the raw identity/device-key secrets from the secrets box.
        dweb,
      });
      auditLog.append({ type: 'settings_exported', secretCount: Object.keys(secrets).length }).catch(() => {});
      return {
        ok: true,
        payload,
        identityIncluded: !!dweb?.identityRecord,
        identityDid: dweb?.identityRecord?.did ?? null,
      };
    },
  };
};
