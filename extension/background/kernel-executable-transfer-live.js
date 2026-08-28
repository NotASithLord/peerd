// @ts-check

import {
  applyImport,
  buildExport,
  EXPORT_PASSPHRASE_MIN_LENGTH,
  ExportPassphraseError,
  inspectImport,
  portableHookDisposition,
} from '/peerd-runtime/transfer/transfer.js';
import { createMemoryStore } from '/peerd-runtime/memory/store.js';
import { createSkillRegistry } from '/peerd-runtime/skills/registry.js';
import { createSkillStore } from '/peerd-runtime/skills/store.js';
import { isCustodySecretName } from '/peerd-runtime/transfer/secret-policy.js';
import { normalizeEngine, normalizeVariant } from '/peerd-runtime/voice/settings.js';
import { assertUserHookRecordsBounded } from '/shared/semantic-hook-manifest.js';

/** @param {Record<string,any>} deps */
export const createKernelTransferLive = async (deps) => {
  const memory = createMemoryStore({ idb: deps.idb });
  const skillRegistry = createSkillRegistry({
    store: createSkillStore({ canWrite: () => deps.canWrite('skills') }),
    audit: deps.auditLog.append,
  });
  const exportHooks = async () => {
    const records = await deps.kv.get('hooks.user.v1');
    return Array.isArray(records)
      ? structuredClone(records.filter((record) => portableHookDisposition(record) !== 'invalid'))
      : [];
  };
  const mergedHookRecords = async (/** @type {any[]} */ incoming) => {
    const existing = await deps.kv.get('hooks.user.v1');
    const byId = new Map((Array.isArray(existing) ? existing : [])
      .map((record) => [record?.id, record]));
    for (const record of incoming) {
      if (portableHookDisposition(record) === 'invalid') {
        throw new TypeError('imported-hook-record-invalid');
      }
      byId.set(record.id, structuredClone({ ...record, enabled: false }));
    }
    const records = [...byId.values()];
    assertUserHookRecordsBounded(records);
    return records;
  };
  const prepareHookImport = async (/** @type {any[]} */ records) => {
    await mergedHookRecords(records);
  };
  const saveUserHook = async (/** @type {{kv:{get:Function,set:Function}}} */ io,
    /** @type {any} */ record) => {
    const existing = await io.kv.get('hooks.user.v1');
    const byId = new Map((Array.isArray(existing) ? existing : [])
      .map((candidate) => [candidate?.id, candidate]));
    if (portableHookDisposition(record) === 'invalid') {
      throw new TypeError('imported-hook-record-invalid');
    }
    byId.set(record.id, structuredClone({ ...record, enabled: false }));
    const records = [...byId.values()];
    assertUserHookRecordsBounded(records);
    await io.kv.set('hooks.user.v1', records);
    return record;
  };
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
    prepareHookImport,
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
