// @ts-check

import {
  applyImport,
  buildExport,
  createMemoryStore,
  createSkillRegistry,
  createSkillStore,
  EXPORT_PASSPHRASE_MIN_LENGTH,
  ExportPassphraseError,
  exportHooks,
  inspectImport,
  isCustodySecretName,
  normalizeEngine,
  normalizeVariant,
  saveUserHook,
} from '/peerd-runtime/background.js';

/** @param {Record<string,any>} deps */
export const createKernelTransferLive = async (deps) => {
  const memory = createMemoryStore({ idb: deps.idb });
  const skillRegistry = createSkillRegistry({
    store: createSkillStore({ canWrite: () => deps.canWrite('skills') }),
    audit: deps.auditLog.append,
  });
  return Object.freeze({
    vault: deps.vault,
    auditLog: deps.auditLog,
    pushState: deps.pushState,
    kv: deps.kv,
    memory,
    settingsStore: deps.settingsStore,
    normalizeSettingsPatch: deps.normalizeSettingsPatch,
    normalizeVariant,
    normalizeEngine,
    REASONING_EFFORT_LEVELS: deps.reasoningEffortLevels,
    DWEB_ENABLED: deps.dwebEnabled,
    DEFAULT_SETTINGS: deps.defaultSettings,
    buildExport,
    CHANNEL: deps.channel,
    exportHooks,
    skillRegistry,
    dwebTransfer: await deps.getDwebTransfer(),
    EXPORT_PASSPHRASE_MIN_LENGTH,
    isCustodySecretName,
    ensureSettingsReady: deps.ensureSettingsReady,
    loadUserEndpoints: deps.loadUserEndpoints,
    inspectImport,
    applyImport,
    saveUserHook,
    ExportPassphraseError,
    normalizeImportedSettings: deps.normalizeImportedSettings,
    onSettingsChanging: deps.onSettingsChanging,
    onSettingsChanged: deps.onSettingsChanged,
    onProviderConfigChanged: deps.onProviderConfigChanged,
    isWriteRefusal: deps.isWriteRefusal,
  });
};
