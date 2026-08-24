// @ts-check
export const KERNEL_STATE_SCHEMA = 2;
export const KERNEL_STATE_PROVENANCE = 'authority-kernel-readonly';

export const KERNEL_STATE_DEFERRED_FIELDS = Object.freeze([
  'pendingConfirm', 'confirmSettleNotes', 'streaming', 'actors',
  'actorProjectionEpoch', 'actorProjectionRevision', 'spawned',
  'asyncTasks', 'goalRuns', 'runtimeCapabilities',
]);

const own = (/** @type {object} */ value, /** @type {string} */ key) => Object.hasOwn(value, key);
/** @param {unknown} value @returns {value is Record<string, any>} */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeCount = (/** @type {unknown} */ value) => Number.isSafeInteger(value) && /** @type {number} */ (value) > 0;
const invalid = (/** @type {string} */ error) => ({ ok: /** @type {const} */ (false), error: `kernel-state-${error}` });

/** @param {unknown} value */
export const validKernelVault = (value) => {
  if (!record(value)) return false;
  const v = value;
  if (typeof v.initialized !== 'boolean' || typeof v.locked !== 'boolean'
      || typeof v.prfEnrolled !== 'boolean' || typeof v.hasRecovery !== 'boolean'
      || !Number.isFinite(v.unlockedAt) || v.unlockedAt < 0
      || ![null, 'idle', 'manual'].includes(v.lockReason ?? null)) return false;
  if (v.locked && v.unlockedAt !== 0) return false;
  if (!v.initialized && !v.locked) return false;
  return true;
};

/** @param {unknown} value @param {boolean} legacy */
export const validKernelActorIsolation = (value, legacy = false) => {
  if (!record(value)) return false;
  const c = value;
  const statuses = legacy
    ? ['available', 'unsupported', 'temporarily_unavailable', 'unavailable']
    : ['available', 'unsupported', 'temporarily_unavailable'];
  if (!statuses.includes(c.status)
      || ![null, 'offscreen-document-worker', 'background-page-worker'].includes(c.host)
      || (c.reason !== null && typeof c.reason !== 'string')
      || typeof c.retryable !== 'boolean') return false;
  if (c.status === 'available') return c.host !== null && c.reason === null && c.retryable === false;
  if (c.status === 'unsupported') return c.host === null && c.retryable === false;
  return c.retryable === true;
};

/** Settings validators work across Store/Preview shapes: optional UI
 * channel fields retain their generated type, while unknown keys remain forward-
 * compatible. Naming families cover UI-consumed scalars/lists; semantic bounds
 * remain owned by the write normalizer. */
/** @param {unknown} value */
export const validKernelSettings = (value) => {
  if (!record(value)) return false;
  const s = value;
  if (!Number.isFinite(s.vaultAutoLockMs) || s.vaultAutoLockMs < 0) return false;
  for (const [key, item] of Object.entries(s)) {
    const boolean = key.endsWith('Enabled')
      || ['voiceOnboardingDismissed', 'devMode', 'watchAgentTab',
        'confirmWebWrites', 'schemaValidatedReplies', 'autoResumeInterruptedTurns'].includes(key);
    if (boolean && typeof item !== 'boolean') return false;
    if (/(?:Variant|Engine|Effort|ActionSurface|Name|Model|Host|View)$/.test(key)
        && typeof item !== 'string') return false;
    if (/(?:Models|Fallbacks)$/.test(key)
        && (!Array.isArray(item) || item.some((entry) => typeof entry !== 'string'))) return false;
    if (/(?:Ms|Usd|Entries)$/.test(key)
        && (!Number.isFinite(item) || item < 0)) return false;
  }
  if (own(s, 'pricingOverrides') && !record(s.pricingOverrides)) return false;
  return true;
};

/** @param {unknown} value */
const validSession = (value) => {
  if (!record(value)) return false;
  const s = value;
  if (s.sessionId !== null
      && (typeof s.sessionId !== 'string' || s.sessionId.length > 256)) return false;
  if (!Array.isArray(s.messages) || s.messages.length > 10_000
      || s.messages.some((item) => !record(item))) return false;
  if (!record(s.permission) || !['plan', 'act'].includes(s.permission.mode)
      || typeof s.permission.confirmActions !== 'boolean') return false;
  return s.provider == null || typeof s.provider === 'string' && s.provider.length <= 64;
};

/** @param {unknown} value */
const validProviders = (value) => record(value)
  && typeof value.current === 'string' && value.current.length <= 64
  && typeof value.model === 'string' && value.model.length <= 256
  && typeof value.hasKey === 'boolean'
  && (value.defaultRunnerModel === undefined
    || typeof value.defaultRunnerModel === 'string' && value.defaultRunnerModel.length <= 256);

/** @param {unknown} value */
const validComposer = (value) => record(value)
  && typeof value.provider === 'string' && value.provider.length <= 64
  && typeof value.model === 'string' && value.model.length <= 256
  && ['keyless', 'credentialReady', 'localReady', 'canSend']
    .every((key) => typeof value[key] === 'boolean')
  && (value.reason === null || typeof value.reason === 'string' && value.reason.length <= 128)
  && (value.warning == null || typeof value.warning === 'string' && value.warning.length <= 128);

/** @param {unknown} value */
const validProfile = (value) => record(value)
  && Object.keys(value).length === 3
  && value.id === 'default'
  && typeof value.peerName === 'string' && value.peerName.length > 0 && value.peerName.length <= 32
  && typeof value.onboardingComplete === 'boolean';

/** @param {unknown} value */
export const validateKernelStateProjection = (value) => {
  if (!record(value)) return invalid('not-an-object');
  const s = value;
  const p = s.projection;
  if (!record(p)) return invalid('projection-missing');
  if (p.schema !== KERNEL_STATE_SCHEMA) return invalid('schema-mismatch');
  if (p.provenance !== KERNEL_STATE_PROVENANCE) return invalid('provenance-mismatch');
  if (typeof p.authorityEpoch !== 'string' || p.authorityEpoch.length < 8
      || p.authorityEpoch.length > 128 || !safeCount(p.generation))
    return invalid('generation-invalid');
  if (!['hydrated', 'defaulted', 'failed'].includes(p.settings)
      || !['hydrated', 'base', 'failed'].includes(p.actorIsolation)
      || p.semanticController !== 'required') return invalid('authority-invalid');
  if (!Array.isArray(p.deferredFields)
      || p.deferredFields.length !== KERNEL_STATE_DEFERRED_FIELDS.length
      || !KERNEL_STATE_DEFERRED_FIELDS.every((field, index) =>
        p.deferredFields[index] === field)) return invalid('deferred-fields-invalid');
  if (KERNEL_STATE_DEFERRED_FIELDS.some((field) => own(s, field)))
    return invalid('deferred-field-present');
  if (!Array.isArray(p.failures)
      || p.failures.some((/** @type {unknown} */ failure) => typeof failure !== 'string'))
    return invalid('failures-invalid');
  if (typeof s.hydrated !== 'boolean' || s.hydrated !== (p.failures.length === 0)
      || (s.hydrated && (p.settings === 'failed' || p.actorIsolation === 'failed')))
    return invalid('hydration-invalid');
  if (!validKernelVault(s.vault)) return invalid('vault-invalid');
  if (!validKernelSettings(s.settings)) return invalid('settings-invalid');
  if (!validSession(s.session) || !validProviders(s.providers)
      || !validComposer(s.composer)) return invalid('ui-base-invalid');
  if (s.vault.locked) {
    if (own(s, 'profile') || s.session.sessionId !== null
        || s.composer.canSend || s.composer.reason !== 'vault-locked')
      return invalid('locked-ui-invalid');
  } else if (!validProfile(s.profile)) return invalid('profile-invalid');
  if (!record(s.capabilities) || !validKernelActorIsolation(s.capabilities.actorExecution))
    return invalid('actor-isolation-invalid');
  return { ok: /** @type {const} */ (true), state: s };
};
