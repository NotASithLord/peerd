// @ts-check
// why: the background transfer host needs an exact surface that feature barrels cannot grow.

export { createMemoryStore } from './memory/store.js';
export { createSkillRegistry } from './skills/registry.js';
export { createSkillStore } from './skills/store.js';
export { exportHooks, saveUserHook } from './tools/hooks/registry.js';
export {
  applyImport,
  buildExport,
  EXPORT_PASSPHRASE_MIN_LENGTH,
  ExportPassphraseError,
  inspectImport,
} from './transfer/transfer.js';
export { isCustodySecretName } from './transfer/secret-policy.js';
export {
  applyAppsSurface,
  applySessionsSurface,
  captureAppsSurface,
  shapeMemorySurface,
  shapeSessionsSurface,
  shapeSettingsSurface,
  SurfaceApplyPartialError,
} from './transfer/self-sync-surfaces.js';
export { normalizeEngine, normalizeVariant } from './voice/settings.js';
