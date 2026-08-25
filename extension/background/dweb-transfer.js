// @ts-check

export class IdentityTransferError extends Error {
  /** @param {string} message @param {string} code @param {{ cause?: unknown }} [options] */
  constructor(message, code, options = {}) {
    super(message, options);
    this.name = 'IdentityTransferError';
    this.code = code;
  }
}

/** @param {string} material */
const materialRevision = async (material) => {
  const encoded = new TextEncoder().encode(material);
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  } finally {
    encoded.fill(0);
  }
};

/**
 * @param {Object} deps
 * @param {{ isLocked: () => boolean, getSecret: (name: string) => Promise<string|null>, setSecret: (name: string, value: string) => Promise<void> }} deps.vault
 * @param {string} deps.identitySecretName
 * @param {(operation: 'export'|'adopt', args: any) => Promise<any>} deps.runCustodyOperation
 * @param {<T>(operation: () => Promise<T>) => Promise<T>} deps.withIdentityMutation
 * @param {() => Promise<boolean>} deps.canReplaceIdentity
 * @param {(incomingDid: string | null) => Promise<boolean>} [deps.canAdoptIdentity]
 * @param {(leaseId: string) => Promise<void>} deps.stopIdentityRuntime
 * @param {(leaseId: string) => Promise<void>} deps.startIdentityRuntime
 * @param {() => string} [deps.newLeaseId]
 * @param {(event: any) => Promise<any>} deps.audit
 */
export const makeDwebTransfer = ({
  vault, identitySecretName,
  runCustodyOperation, withIdentityMutation,
  canReplaceIdentity, canAdoptIdentity = async () => true,
  stopIdentityRuntime, startIdentityRuntime,
  newLeaseId = () => crypto.randomUUID(), audit,
}) => {
  /** @param {'export'|'adopt'} operation @param {any} args */
  const runCrypto = async (operation, args) => {
    try {
      return await runCustodyOperation(operation, args);
    } catch (cause) {
      throw new IdentityTransferError(
        `identity ${operation} host failed`,
        /** @type {{ code?: string }} */ (cause)?.code ?? 'host-failed',
        { cause },
      );
    }
  };

  return Object.freeze({
    /** @param {string} passphrase */
    exportRecord: (passphrase) => withIdentityMutation(async () => {
      if (vault.isLocked()) throw new IdentityTransferError('vault is locked', 'vault-locked');
      const material = await vault.getSecret(identitySecretName);
      if (typeof material !== 'string' || material.length === 0) return null;
      let parsed;
      try { parsed = JSON.parse(material); }
      catch (cause) { throw new IdentityTransferError('local identity is malformed', 'bad-local-identity', { cause }); }
      const record = await runCrypto('export', { material: parsed, passphrase });
      if (!record) throw new IdentityTransferError('identity export returned no record', 'empty-record');
      return { identityRecord: record };
    }),

    /**
     * Authenticate and classify a record without changing custody.
     * @param {any} record @param {string} passphrase
     * @param {{ replaceExisting?: boolean }} [options]
     */
    prepareRecord: (record, passphrase, { replaceExisting = false } = {}) =>
      withIdentityMutation(async () => {
        if (vault.isLocked()) return { adopted: false, did: null, reason: 'vault-locked' };
        const existingMaterial = await vault.getSecret(identitySecretName);
        const outcome = await runCrypto('adopt', {
          record, passphrase, existingMaterial, replaceExisting,
        });
        const existingUnreadable = outcome?.reason === 'invalid-local-identity'
          || outcome?.reason === 'replaced-invalid-local';
        const existingRevision = existingUnreadable
          && typeof existingMaterial === 'string' && existingMaterial.length > 0
          ? await materialRevision(existingMaterial)
          : undefined;
        const changesIdentity = outcome?.adopted && typeof outcome.material === 'string';
        if (changesIdentity && !await canAdoptIdentity(outcome?.did ?? outcome?.incomingDid ?? null)) {
          const { material: _material, ...blockedOutcome } = outcome ?? {};
          return { ...blockedOutcome, adopted: false, reason: 'self-custody-mismatch' };
        }
        if (changesIdentity && !await canReplaceIdentity()) {
          const { material: _material, ...blockedOutcome } = outcome ?? {};
          return {
            ...blockedOutcome, adopted: false, reason: 'identity-in-use',
            ...(existingUnreadable ? { existingUnreadable: true, existingRevision } : {}),
          };
        }
        // Root material stays inside this background shell; preparation returns
        // only the authenticated decision used to stage the rest of the import.
        const { material: _material, ...publicOutcome } = outcome ?? {};
        if (existingUnreadable) {
          return {
            ...publicOutcome,
            existingUnreadable: true,
            existingRevision,
          };
        }
        return publicOutcome;
      }),

    /**
     * @param {any} record @param {string} passphrase
     * @param {{ replaceExisting?: boolean, expectedExistingDid?: string | null, expectedExistingRevision?: string, expectedIncomingDid?: string }} [options]
     */
    adoptRecord: async (record, passphrase, {
      replaceExisting = false, expectedExistingDid, expectedExistingRevision, expectedIncomingDid,
    } = {}) => {
      // Preparation supplies the expected incoming did for every real import.
      // Suspend BEFORE entering the custody lane: a first-run host may itself
      // be waiting to auto-mint through that lane, so the reverse order would
      // deadlock runtime stop against a concurrent first-mint custody write.
      const suspendForCommit = replaceExisting || typeof expectedIncomingDid === 'string';
      let suspensionAttempted = false;
      let committed = false;
      let outcomeResult;
      const leaseId = newLeaseId();
      try {
        if (suspendForCommit) {
          suspensionAttempted = true;
          await stopIdentityRuntime(leaseId);
        }
        outcomeResult = await withIdentityMutation(async () => {
          if (vault.isLocked()) return { adopted: false, did: null, reason: 'vault-locked' };
          const existingMaterial = await vault.getSecret(identitySecretName);
          const outcome = await runCrypto('adopt', {
            record, passphrase, existingMaterial, replaceExisting,
          });

          // Bind the commit to the exact A→B transition authenticated during
          // preparation. Another import or auto-mint may have won while ordinary
          // sections were applying; explicit approval for A never authorizes
          // silently replacing C.
          const revisionChanged = typeof expectedExistingRevision === 'string'
            && (typeof existingMaterial !== 'string'
              || await materialRevision(existingMaterial) !== expectedExistingRevision);
          if ((expectedExistingDid !== undefined
                && (outcome?.existingDid ?? null) !== expectedExistingDid)
              || revisionChanged
              || (typeof expectedIncomingDid === 'string'
                && outcome?.incomingDid !== expectedIncomingDid)) {
            return { ...outcome, adopted: false, material: null, reason: 'identity-changed' };
          }
          if (!outcome?.adopted || typeof outcome.material !== 'string') return outcome;

          const changesIdentity = outcome.adopted && typeof outcome.material === 'string';
          if (changesIdentity && !await canAdoptIdentity(outcome?.did ?? outcome?.incomingDid ?? null)) {
            return { ...outcome, adopted: false, material: null, reason: 'self-custody-mismatch' };
          }
          if (changesIdentity && !await canReplaceIdentity()) {
            return { ...outcome, adopted: false, material: null, reason: 'identity-in-use' };
          }
          try {
            await vault.setSecret(identitySecretName, outcome.material);
          } catch (cause) {
            throw new IdentityTransferError('identity could not be stored', 'store-failed', { cause });
          }
          committed = true;
          const replacing = outcome.reason === 'replaced' || outcome.reason === 'replaced-invalid-local';
          await audit({
            type: replacing ? 'dweb_identity_replaced' : 'dweb_identity_adopted',
            details: { did: outcome.did ?? null, previousDid: outcome.existingDid ?? null },
          }).catch(() => {});
          return outcome;
        });
      } finally {
        // Resume on every path, including stop/close and pre-commit failures.
        // The service-worker shell also schedules recovery and clears stale
        // suspension on boot, so a lost acknowledgement cannot wedge the host.
        if (suspensionAttempted || committed) {
          try {
            await startIdentityRuntime(leaseId);
          } catch {
            // The custody write, if any, is already durable and must not be
            // misreported as rolled back. The shell retries this exact lease
            // and boot recovery clears a predecessor lease after SW eviction;
            // surface the degraded runtime state until one of those succeeds.
            if (outcomeResult) outcomeResult = { ...outcomeResult, runtimeRecoveryPending: true };
          }
        }
      }
      return outcomeResult;
    },
  });
};
