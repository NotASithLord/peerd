// @ts-check
// Vault-backed custody for the permanent peer identity.
//
// why this is not a runtime message route: reads and first-mint writes carry
// the permanent signing seed. Only the sender-verified offscreen custody Port
// may reach this handler.

/** @param {any[]} apps */
export const identityChangeBlockedByApps = (apps) => apps.some((app) =>
  app?.shared === true
  || (app?.dweb?.local === true
    && typeof app.dweb.publisher === 'string'
    && app.dweb.publisher.length > 0));

/**
 * @param {Object} deps
 * @param {boolean} deps.enabled
 * @param {() => boolean} deps.active
 * @param {{ isLocked: () => boolean, getSecret: (name: string) => Promise<string | null>, setSecret: (name: string, value: string) => Promise<void> }} deps.vault
 * @param {{ append: (entry: { type: string, details: object }) => Promise<unknown> }} deps.auditLog
 * @param {string} deps.identitySecretName
 * @param {<T>(operation: () => Promise<T>) => Promise<T>} deps.withIdentityMutation
 * @param {() => Promise<boolean>} deps.canChangeIdentity
 */
export const makeDwebIdentityCustody = ({
  enabled, active, vault, auditLog, identitySecretName,
  withIdentityMutation, canChangeIdentity,
}) => {
  const available = () => enabled && active();

  /** @param {'get'|'set'} operation @param {any} [args] */
  const handle = async (operation, args = {}) => {
    if (!available()) return { ok: false, error: 'dweb-disabled' };
    if (vault.isLocked()) return { ok: false, error: 'vault-locked' };

    if (operation === 'get') {
      try {
        return { ok: true, value: await vault.getSecret(identitySecretName) };
      } catch (cause) {
        return { ok: false, error: /** @type {{ message?: string }} */ (cause)?.message ?? String(cause) };
      }
    }

    if (operation !== 'set') return { ok: false, error: 'unknown-secret-operation' };
    if (typeof args?.value !== 'string') return { ok: false, error: 'value-required' };
    try {
      return await withIdentityMutation(async () => {
        // get, mint, and set cross the page/SW boundary. Re-check inside the
        // same custody lane used by restore so stale mint work cannot overwrite
        // a recovered root.
        const existing = await vault.getSecret(identitySecretName);
        if (existing) return { ok: false, error: 'identity-already-exists' };
        // A surviving local share is derived from the missing root. Minting a
        // replacement would orphan its publisher and app identifiers.
        if (!await canChangeIdentity()) return { ok: false, error: 'identity-in-use' };
        await vault.setSecret(identitySecretName, args.value);
        // The root is already durable. Audit failure must not report the mint as
        // failed and prompt a misleading retry against committed state.
        await auditLog.append({ type: 'dweb_identity_issued', details: {} }).catch(() => {});
        return { ok: true };
      });
    } catch (cause) {
      return { ok: false, error: /** @type {{ message?: string }} */ (cause)?.message ?? String(cause) };
    }
  };

  return { handle };
};
