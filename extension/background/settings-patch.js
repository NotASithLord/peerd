// @ts-check

/**
 * @param {Record<string, unknown>} patch
 * @returns {{ vaultAutoLockMs?: number }}
 */
export const normalizeVaultAutoLockPatch = (patch) => {
  if (patch.vaultAutoLockMs === undefined) return {};
  const value = Number(patch.vaultAutoLockMs);
  return {
    vaultAutoLockMs: (Number.isFinite(value) && value > 0)
      ? Math.min(Math.max(value, 60_000), 24 * 60 * 60 * 1000)
      : 0,
  };
};

/**
 * Normalize a settings patch into the subset of keys we accept, each
 * validated + clamped. Returns a plain object (possibly empty); the caller
 * decides what to do with an empty result and applies vaultAutoLockMs to the
 * live vault.
 *
 * @param {Record<string, unknown>} patch
 * @param {{
 *   knownProviderNames: string[],
 *   reasoningEffortLevels: readonly string[],
 *   dwebEnabled: boolean,
 *   autoUpdateAvailable: boolean,
 *   normalizeVariant: (v: string) => string,
 *   normalizeEngine: (v: string) => string,
 * }} deps
 * @returns {Record<string, unknown>}
 */
export const normalizeSettingsPatch = (patch, {
  knownProviderNames,
  reasoningEffortLevels,
  dwebEnabled,
  autoUpdateAvailable,
  normalizeVariant,
  normalizeEngine,
}) => {
  /** @type {Record<string, unknown>} */
  const next = {};
  if (typeof patch.voiceEnabled === 'boolean') {
    next.voiceEnabled = patch.voiceEnabled;
  }
  if (typeof patch.voiceVariant === 'string') {
    next.voiceVariant = normalizeVariant(patch.voiceVariant);
  }
  if (typeof patch.voiceEngine === 'string') {
    next.voiceEngine = normalizeEngine(patch.voiceEngine);
  }
  if (typeof patch.voiceSilenceMs === 'number' && Number.isFinite(patch.voiceSilenceMs)) {
    next.voiceSilenceMs = Math.max(250, Math.min(30_000, Math.round(patch.voiceSilenceMs)));
  }
  if (typeof patch.voiceOnboardingDismissed === 'boolean') {
    next.voiceOnboardingDismissed = patch.voiceOnboardingDismissed;
  }
  if (typeof patch.ocrEnabled === 'boolean') {
    next.ocrEnabled = patch.ocrEnabled;
  }
  if (typeof patch.devMode === 'boolean') {
    next.devMode = patch.devMode;
  }
  if (typeof patch.reasoningEnabled === 'boolean') {
    next.reasoningEnabled = patch.reasoningEnabled;
  }
  if (typeof patch.reasoningEffort === 'string'
      && reasoningEffortLevels.includes(patch.reasoningEffort)) {
    next.reasoningEffort = patch.reasoningEffort;
  }
  if (patch.webActorActionSurface === 'tools' || patch.webActorActionSurface === 'code') {
    next.webActorActionSurface = patch.webActorActionSurface;
  }
  if (typeof patch.providerName === 'string'
      && knownProviderNames.includes(patch.providerName)) {
    next.providerName = patch.providerName;
  }
  if (typeof patch.providerModel === 'string') {
    next.providerModel = patch.providerModel.trim().slice(0, 200);
  }
  if (Array.isArray(patch.openrouterModels)) {
    const seen = new Set();
    const cleaned = [];
    for (const raw of patch.openrouterModels) {
      if (typeof raw !== 'string') continue;
      const id = raw.trim();
      if (!id || id.length > 200 || seen.has(id)) continue;
      seen.add(id);
      cleaned.push(id);
      if (cleaned.length >= 200) break;
    }
    next.openrouterModels = cleaned;
  }
  if (typeof patch.advancedAutomationEnabled === 'boolean') {
    next.advancedAutomationEnabled = patch.advancedAutomationEnabled;
  }
  if (typeof patch.autoMemoryEnabled === 'boolean') {
    next.autoMemoryEnabled = patch.autoMemoryEnabled;
  }
  if (typeof patch.watchAgentTab === 'boolean') {
    next.watchAgentTab = patch.watchAgentTab;
  }
  if (patch.frontDoorView === 'panel' || patch.frontDoorView === 'home') {
    next.frontDoorView = patch.frontDoorView;
  }
  if (typeof patch.confirmWebWrites === 'boolean') {
    next.confirmWebWrites = patch.confirmWebWrites;
  }
  if (typeof patch.schemaValidatedReplies === 'boolean') {
    next.schemaValidatedReplies = patch.schemaValidatedReplies;
  }
  if (typeof patch.autoResumeInterruptedTurns === 'boolean') {
    next.autoResumeInterruptedTurns = patch.autoResumeInterruptedTurns;
  }
  if (typeof patch.providerFailoverEnabled === 'boolean') {
    next.providerFailoverEnabled = patch.providerFailoverEnabled;
  }
  if (Array.isArray(patch.providerFallbacks)) {
    const valid = new Set(knownProviderNames);
    next.providerFallbacks = [...new Set(patch.providerFallbacks)]
      .filter((n) => typeof n === 'string' && valid.has(n))
      .slice(0, 8);
  }
  if (typeof patch.runnerModel === 'string') {
    next.runnerModel = patch.runnerModel.trim().slice(0, 200);
  }
  if (typeof patch.prewalkEnabled === 'boolean') {
    next.prewalkEnabled = patch.prewalkEnabled;
  }
  if (typeof patch.enginePrewalkEnabled === 'boolean') {
    next.enginePrewalkEnabled = patch.enginePrewalkEnabled;
  }
  if (typeof patch.prewalkExecutorModel === 'string') {
    next.prewalkExecutorModel = patch.prewalkExecutorModel.trim().slice(0, 200);
  }
  Object.assign(next, normalizeVaultAutoLockPatch(patch));
  if (typeof patch.auditLogMaxEntries === 'number' && Number.isFinite(patch.auditLogMaxEntries)) {
    next.auditLogMaxEntries = Math.min(1_000_000, Math.max(1, Math.floor(patch.auditLogMaxEntries)));
  }
  if (patch.spendLimitUsd !== undefined) {
    const v = Number(patch.spendLimitUsd);
    next.spendLimitUsd = Number.isFinite(v) && v > 0 ? Math.min(v, 100_000) : 0;
  }
  if (patch.pricingOverrides && typeof patch.pricingOverrides === 'object') {
    /** @type {Record<string, Record<string, number>>} */
    const clean = {};
    for (const [model, rates] of Object.entries(patch.pricingOverrides)) {
      if (!rates || typeof rates !== 'object') continue;
      /** @type {Record<string, number>} */
      const r = {};
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        const n = Number(/** @type {Record<string, unknown>} */ (rates)[k]);
        if (Number.isFinite(n) && n >= 0) r[k] = n;
      }
      if (Object.keys(r).length > 0) clean[String(model).slice(0, 200)] = r;
    }
    next.pricingOverrides = clean;
  }
  if (dwebEnabled && typeof patch.dwebEnabled === 'boolean') {
    next.dwebEnabled = patch.dwebEnabled;
  }
  if (dwebEnabled && typeof patch.dwebAgentEnabled === 'boolean') {
    next.dwebAgentEnabled = patch.dwebAgentEnabled;
  }
  if (autoUpdateAvailable && typeof patch.autoUpdateEnabled === 'boolean') {
    next.autoUpdateEnabled = patch.autoUpdateEnabled;
  }
  if (typeof patch.ollamaHost === 'string') {
    try {
      const u = new URL(patch.ollamaHost.trim());
      if (u.protocol === 'http:' || u.protocol === 'https:') next.ollamaHost = u.origin;
    } catch { /* not a valid URL — drop the key */ }
  }
  return next;
};

/**
 * Native authority-owned settings mutations. Validation is pure; the injected
 * lifecycle hook owns effects such as vault deadlines and feature teardown.
 * @param {Object} deps
 * @param {Promise<unknown>} deps.ready
 * @param {{get:()=>Record<string,any>,update:(patch:Record<string,any>)=>Promise<any>,reset:(keys:string[])=>Promise<any>}} deps.settingsStore
 * @param {Record<string,any>} deps.defaults
 * @param {string[]} deps.knownProviderNames
 * @param {boolean} deps.dwebEnabled
 * @param {(value:string)=>string} deps.normalizeVariant
 * @param {(value:string)=>string} deps.normalizeEngine
 * @param {(patch:Record<string,any>)=>void} [deps.onChanging]
 * @param {(patch:Record<string,any>)=>Promise<void>|void} [deps.onChanged]
 * @param {()=>void} [deps.pushState]
 */
export const makeKernelSettingsRoutes = ({
  ready, settingsStore, defaults, knownProviderNames, dwebEnabled,
  normalizeVariant, normalizeEngine, onChanging = () => {},
  onChanged = () => {}, pushState = () => {},
}) => {
  const failure = (/** @type {string} */ code, /** @type {string} */ action) => ({
    ok: false,
    error: `Peerd could not confirm whether ${action} finished. Refresh settings before trying again.`,
    code, outcomeKnown: false, outcomeKind: 'unknown', retryable: false,
    settings: { ...settingsStore.get() },
  });
  return Object.freeze({
    'settings/update': async (/** @type {{patch?:unknown}} */ { patch } = {}) => {
      await ready;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { ok: false, error: 'invalid-patch' };
      }
      const next = normalizeSettingsPatch(
        /** @type {Record<string,unknown>} */ (patch), {
          knownProviderNames,
          reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          dwebEnabled,
          autoUpdateAvailable: Object.hasOwn(defaults, 'autoUpdateEnabled'),
          normalizeVariant,
          normalizeEngine,
        },
      );
      if (Object.keys(next).length === 0) {
        return { ok: false, error: 'no-known-keys-in-patch' };
      }
      try {
        onChanging(next);
        await settingsStore.update(next);
        await onChanged(next);
        pushState();
        return { ok: true, settings: { ...settingsStore.get() } };
      } catch {
        pushState();
        return failure('settings-update-outcome-unknown', 'the settings update');
      }
    },
    'settings/reset': async (/** @type {{keys?:unknown}} */ { keys } = {}) => {
      await ready;
      if (!Array.isArray(keys) || keys.length === 0) {
        return { ok: false, error: 'keys-required' };
      }
      const known = keys.filter((key) => typeof key === 'string'
        && Object.hasOwn(defaults, key));
      if (known.length === 0) return { ok: false, error: 'no-known-keys' };
      const changed = Object.fromEntries(known.map((key) => [key, defaults[key]]));
      try {
        if (changed.dwebEnabled === false) onChanging(changed);
        await settingsStore.reset(known);
        for (const key of known) changed[key] = settingsStore.get()[key];
        await onChanged(changed);
        pushState();
        return { ok: true, settings: { ...settingsStore.get() } };
      } catch {
        pushState();
        return failure('settings-reset-outcome-unknown', 'resetting settings');
      }
    },
  });
};
