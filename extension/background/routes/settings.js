// @ts-check
// background/routes/settings.js — settings update/reset + the settings export
// half of transfer (dual-distribution §10).
//
// Unblocked by background/settings-store.js: these read/replaced the reassigned
// settings singletons, so they had to stay inline. Now they take settingsStore
// and call .get()/.stored()/.update()/.reset(). The pure patch normalizer
// (settings-patch.js) and the one vault side effect (auto-lock) ride deps.
// Imports nothing.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeSettingsRoutes = (deps) => {
  const {
    vault, auditLog, pushState, kv, memory, settingsStore,
    normalizeSettingsPatch, normalizeVariant, normalizeEngine, listProviders,
    REASONING_EFFORT_LEVELS, DWEB_ENABLED, DEFAULT_SETTINGS,
    buildExport, CHANNEL, exportHooks, skillRegistry, dwebTransfer,
    EXPORT_PASSPHRASE_MIN_LENGTH, isCustodySecretName,
    onSettingsChanging, onSettingsChanged, privateTransferAuthorization,
  } = deps;

  return {
    // --- settings ---
    'settings/update': async ({ patch }) => {
      if (!patch || typeof patch !== 'object') {
        return { ok: false, error: 'invalid-patch' };
      }
      // Pure whitelist/clamp/coerce of the patch (background/settings-patch.js)
      // — the only logic that isn't IO, lifted out so it's unit-tested.
      const next = normalizeSettingsPatch(patch, {
        knownProviderNames: listProviders().map((/** @type {{ name: string }} */ p) => p.name),
        reasoningEffortLevels: REASONING_EFFORT_LEVELS,
        dwebEnabled: DWEB_ENABLED,
        // Preview-only key: its presence in this package's defaults IS the
        // channel gate (no separate build flag, unlike dweb).
        autoUpdateAvailable: Object.hasOwn(DEFAULT_SETTINGS, 'autoUpdateEnabled'),
        normalizeVariant,
        normalizeEngine,
      });
      // The one settings key with a side effect beyond persistence: apply the
      // idle auto-lock to the live vault immediately so it takes effect without
      // an SW restart. Keyed on presence — `0` (never) is a valid value.
      if (next.vaultAutoLockMs !== undefined) vault.setAutoLockMs(next.vaultAutoLockMs);
      if (Object.keys(next).length === 0) {
        return { ok: false, error: 'no-known-keys-in-patch' };
      }
      onSettingsChanging?.(next);
      await settingsStore.update(next);
      // Master OFF is a lifecycle transition, not just a preference write. Wait
      // for its host stop so the acknowledgement is an actual network fence.
      try { await onSettingsChanged?.(next); }
      catch (error) {
        pushState();
        return {
          ok: false,
          error: /** @type {{ message?: string }} */ (error)?.message ?? 'settings-side-effect-failed',
          settings: { ...settingsStore.get() },
        };
      }
      pushState();
      return { ok: true, settings: { ...settingsStore.get() } };
    },

    // Reset keys to channel defaults by deleting the STORED values —
    // CHANNEL_DEFAULTS then applies and tracks future releases (§11: the
    // explicit migration path for picking up new defaults).
    'settings/reset': async ({ keys }) => {
      if (!Array.isArray(keys) || keys.length === 0) {
        return { ok: false, error: 'keys-required' };
      }
      const known = keys.filter((k) => Object.hasOwn(DEFAULT_SETTINGS, k));
      if (known.length === 0) return { ok: false, error: 'no-known-keys' };
      const resetsDweb = known.includes('dwebEnabled');
      const resetDwebEnabled = Boolean(DEFAULT_SETTINGS.dwebEnabled);
      // Reset is only an OFF fence when this channel's default is actually OFF.
      // Preview resets to ON, so invalidating an admitted publication there
      // would report a failure even though neither the setting nor host stopped.
      if (resetsDweb && !resetDwebEnabled) {
        onSettingsChanging?.({ dwebEnabled: false });
      }
      await settingsStore.reset(known);
      if (resetsDweb) {
        await onSettingsChanged?.({ dwebEnabled: settingsStore.get().dwebEnabled });
      }
      pushState();
      return { ok: true, settings: { ...settingsStore.get() } };
    },

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
        dweb = await dwebTransfer.exportRecord(passphrase);
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
        hooks: exportHooks(),
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
