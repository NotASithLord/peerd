// @ts-check
// background/routes/system.js: system mutations and private transfer import.
//
// transfer/export stays inline in the SW (it reads the reassigned
// storedSettings); so do the denylist/* routes (reassigned denylist state).
// Everything here closes over only stable collaborators. Bodies verbatim,
// deps injected, imports none.

export { makeSystemReadRoutes } from './system-read.js';

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => any>}
 *   why any (not Promise): most handlers are async, but sidepanel/close and
 *   surfaces/get answer synchronously; the dispatcher awaits either.
 */
export const makeSystemRoutes = (deps) => {
  const {
    vault, auditLog, pushState, kv, memory,
    closeSidePanel, loadUserEndpoints,
    inspectImport, applyImport, settingsStore, saveUserHook, prepareHookImport,
    CHANNEL, DEFAULT_SETTINGS, ExportPassphraseError, dwebTransfer,
    onSettingsChanging, onSettingsChanged, privateTransferAuthorization,
    retryActorIsolation, normalizeImportedSettings, onProviderConfigChanged,
  } = deps;

  return {
    'actor-isolation/retry': async () => retryActorIsolation(),

    // why: the voice model store (side-panel context) routes its outbound HF
    // model fetch here so it lands in the audit log. TYPE-LOCKED: the entry type
    // is hardcoded to voice_model_fetch and only the url is taken (truncated), so
    // this route can't be used to forge arbitrary audit entries.
    'audit/voice-fetch': async (msg) => {
      auditLog.append({
        type: 'voice_model_fetch',
        details: { url: typeof msg?.url === 'string' ? msg.url.slice(0, 300) : '' },
      }).catch(() => {});
      return { ok: true };
    },


    // Close the side panel so the home tab re-owns the chat (single-homed,
    // DESIGN-12) — home's "bring chat home", the panel's close button, the
    // engine-tab toggle, and the Alt+Shift+P toggle all route through here. Now
    // works on Firefox too (sidebarAction.close); see closeSidePanel.
    'sidepanel/close': () => closeSidePanel(),
    // --- transfer: explicit settings import (dual-distribution §10) ---
    //
    // The ONLY migration path between installs (store ↔ preview). transfer/export
    // stays inline in the SW (it reads the reassigned storedSettings).

    // Pre-flight: what would this import overwrite? The UI shows the
    // summary (and the dweb-dropped notice on store packages) BEFORE
    // the user confirms.
    'transfer/inspectImport': async ({ payload, privateTransferAuthorization: authorization }) =>
      authorization !== privateTransferAuthorization
        ? { ok: false, error: 'private-transfer-required' }
        : inspectImport({
            payload, channel: CHANNEL, knownSettingKeys: Object.keys(DEFAULT_SETTINGS),
          }),

    'transfer/import': async ({
      payload, passphrase, replaceDwebIdentity = false, skipDwebIdentity = false,
      approvedExistingDwebDid, approvedExistingDwebRevision, approvedIncomingDwebDid,
      privateTransferAuthorization: authorization,
    }) => {
      if (authorization !== privateTransferAuthorization) {
        return { ok: false, error: 'private-transfer-required' };
      }
      const identityImport = CHANNEL !== 'store' && payload?.dweb?.identityRecord != null;
      if ((payload?.secrets != null || identityImport) && vault.isLocked()) {
        return { ok: false, error: 'vault-locked' };
      }
      try {
        const result = await applyImport({
          payload,
          passphrase,
          channel: CHANNEL,
          knownSettingKeys: Object.keys(DEFAULT_SETTINGS),
          io: {
            applySettings: async (/** @type {any} */ patch) => {
              const normalized = normalizeImportedSettings?.(patch) ?? patch;
              const notices = [];
              const dropped = Object.keys(patch).filter((key) => !Object.hasOwn(normalized, key));
              const canonicalized = Object.keys(normalized).filter((key) =>
                Object.hasOwn(patch, key)
                && JSON.stringify(normalized[key]) !== JSON.stringify(patch[key]));
              if (dropped.length > 0) notices.push(`Invalid setting value(s) were skipped: ${dropped.join(', ')}.`);
              if (canonicalized.length > 0) notices.push(`Setting value(s) were normalized before import: ${canonicalized.join(', ')}.`);
              if (Object.keys(normalized).length > 0) {
                onSettingsChanging?.(normalized);
                await settingsStore.update(normalized);
                await onSettingsChanged?.(normalized);
              }
              return { count: Object.keys(normalized).length, notices };
            },
            setProviderEndpoints: async (/** @type {any} */ v) => {
              await kv.set('provider_endpoints.v1', v);
              await loadUserEndpoints();
            },
            setSecret: (/** @type {string} */ name, /** @type {string} */ value) => vault.setSecret(name, value),
            importMemory: (/** @type {any} */ p) => memory.importAll(p),
            prepareHookImport,
            saveHook: (/** @type {any} */ record) => saveUserHook({ kv }, record),
            // Preview-channel identity adoption (applyImport gates on
            // channel; the helper itself refuses when the build has no dweb).
            adoptDwebIdentity: dwebTransfer
              ? (/** @type {any} */ record, /** @type {string} */ pass, /** @type {any} */ options) => options?.prepareOnly
                ? dwebTransfer.prepareRecord(record, pass, options)
                : dwebTransfer.adoptRecord(record, pass, options)
              : undefined,
          },
          replaceDwebIdentity: replaceDwebIdentity === true,
          skipDwebIdentity: skipDwebIdentity === true,
          approvedExistingDwebDid,
          approvedExistingDwebRevision,
          approvedIncomingDwebDid,
        });
        if (result.ok) {
          if ((result.imported?.secrets ?? 0) > 0) onProviderConfigChanged?.();
          auditLog.append({ type: 'settings_imported', counts: result.imported }).catch(() => {});
          pushState();
        } else if (result.partial) {
          if ((result.partial?.secrets ?? 0) > 0) onProviderConfigChanged?.();
          auditLog.append({ type: 'settings_import_partial', counts: result.partial, details: { failure: result.failure ?? result.error } }).catch(() => {});
          pushState();
        }
        return result;
      } catch (e) {
        if (e instanceof ExportPassphraseError) return { ok: false, error: 'wrong-passphrase' };
        if ((/** @type {{code?:string}} */ (e))?.code === 'hook-records-limit') {
          return {
            ok: false, code: 'hook-records-limit', outcomeKnown: true,
            error: /** @type {{message?:string}} */ (e)?.message ?? 'hook limit exceeded',
          };
        }
        if ((/** @type {{ name?: string, code?: string }} */ (e))?.name === 'IdentityTransferError') {
          if ((/** @type {{ outcomeKnown?: boolean }} */ (e)).outcomeKnown === false) throw e;
          return { ok: false, error: `dweb-identity-${(/** @type {{ code?: string }} */ (e)).code ?? 'transfer-failed'}` };
        }
        throw e;
      }
    },
  };
};
