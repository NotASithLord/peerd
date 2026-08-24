// @ts-check
// Nonsecret vault posture shared by the static UI shell and authority kernel.
// This record contains no wrapped key, salt, credential, or identity material.

export const VAULT_POSTURE_INDEX_KEY = 'vault.posture.v1';
export const VAULT_POSTURE_SCHEMA = 1;

/** @param {unknown} value */
export const parseVaultPostureIndex = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = /** @type {Record<string, unknown>} */ (value);
  if (Object.keys(input).sort().join('\n') !== 'hasRecovery\ninitialized\nprfEnrolled\nschema\nupdatedAt'
      || input.schema !== VAULT_POSTURE_SCHEMA
      || typeof input.initialized !== 'boolean'
      || typeof input.prfEnrolled !== 'boolean'
      || typeof input.hasRecovery !== 'boolean'
      || !Number.isFinite(input.updatedAt)) return null;
  if (!input.initialized && (input.prfEnrolled || input.hasRecovery)) return null;
  return Object.freeze({
    schema: VAULT_POSTURE_SCHEMA,
    initialized: input.initialized,
    prfEnrolled: input.prfEnrolled,
    hasRecovery: input.hasRecovery,
    updatedAt: Number(input.updatedAt),
  });
};
