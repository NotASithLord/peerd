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
    buildExport, CHANNEL, exportHooks, skillRegistry,
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
      await settingsStore.update(next);
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
      await settingsStore.reset(known);
      pushState();
      return { ok: true, settings: { ...settingsStore.get() } };
    },

    // --- transfer: explicit settings export (dual-distribution §10) ---
    //
    // The ONLY migration path between installs (store ↔ preview). No background
    // sync, no shared storage — different extension IDs keep the two builds
    // isolated; the user moves state by file, in the clear about what travels
    // (API keys ride encrypted under an export passphrase; the vault DK never
    // leaves the vault). The import half lives in routes/system.js.
    'transfer/export': async ({ passphrase }) => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      const names = await vault.listSecretNames();
      if (names.length > 0 && (typeof passphrase !== 'string' || passphrase.length < 8)) {
        // Same floor as the vault passphrase — this file unlocks API keys.
        return { ok: false, error: 'passphrase-required' };
      }
      /** @type {Record<string, string>} */
      const secrets = {};
      for (const name of names) {
        const value = await vault.getSecret(name);
        if (typeof value === 'string') secrets[name] = value;
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
      });
      auditLog.append({ type: 'settings_exported', secretCount: names.length }).catch(() => {});
      return { ok: true, payload };
    },
  };
};
