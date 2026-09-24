// @ts-check

export class IdentityTransferHostError extends Error {
  /** @param {string} code @param {{cause?:unknown,outcomeKnown?:boolean}} [options] */
  constructor(code, options = {}) {
    super(code, options);
    this.name = 'IdentityTransferError';
    this.code = code;
    this.outcomeKnown = options.outcomeKnown !== false;
  }
}

/** @typedef {{operationId:string,signal?:AbortSignal,deadline?:number,setPhase?:(phase:'inspection'|'suspending'|'commit-dispatched'|'recovering')=>void}} TransferContext */

/** @param {TransferContext} context @param {boolean} [outcomeKnown] */
const assertLive = (context, outcomeKnown = true) => {
  if (context.signal?.aborted
      || (Number.isFinite(context.deadline) && Date.now() >= /** @type {number} */ (context.deadline))) {
    throw new IdentityTransferHostError('identity-operation-aborted', { outcomeKnown });
  }
};

/** @param {string} material @param {TransferContext} context */
const materialRevision = async (material, context) => {
  const encoded = new TextEncoder().encode(material);
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
    assertLive(context);
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  } finally {
    encoded.fill(0);
  }
};

/** @param {any} result */
const requireEffect = (result) => {
  if (result?.ok === true) return result;
  throw new IdentityTransferHostError(
    typeof result?.error === 'string' ? result.error : 'identity-effect-failed',
    { outcomeKnown: result?.outcomeKnown !== false },
  );
};

/**
 * @param {Object} deps
 * @param {(operation:string,args:any,context:{parentOperationId:string,onDispatched?:()=>void})=>Promise<any>} deps.callEffect
 * @param {(operation:'export'|'adopt',args:any,context:{signal?:AbortSignal,deadline?:number,parentOperationId:string})=>Promise<any>} deps.runCrypto
 * @param {(leaseId:string,context:TransferContext)=>Promise<void>} deps.stopIdentityRuntime
 * @param {(leaseId:string,context:TransferContext)=>Promise<void>} deps.startIdentityRuntime
 */
export const makeDwebTransferHost = ({
  callEffect, runCrypto, stopIdentityRuntime, startIdentityRuntime,
}) => {
  if ([callEffect, runCrypto, stopIdentityRuntime,
    startIdentityRuntime].some((value) => typeof value !== 'function')) {
    throw new TypeError('dweb-transfer-host-config-invalid');
  }

  /** @param {string} operation @param {any} args @param {TransferContext} context @param {()=>void} [onDispatched] */
  const effect = async (operation, args, context, onDispatched) => {
    assertLive(context);
    try {
      const result = await callEffect(operation, args, {
        parentOperationId: context.operationId,
        ...(onDispatched ? { onDispatched } : {}),
      });
      // A commit reply is direct evidence even if the caller's deadline fired
      // while that reply was in flight. Every other effect is read-only.
      if (operation !== 'identity/commit') assertLive(context);
      return result;
    } catch (cause) {
      if (cause instanceof IdentityTransferHostError) throw cause;
      throw new IdentityTransferHostError('identity-effect-unavailable', {
        cause,
        outcomeKnown: operation !== 'identity/commit'
          && /** @type {{outcomeKnown?:boolean}} */ (cause)?.outcomeKnown !== false,
      });
    }
  };

  /** @param {TransferContext} context */
  const readIdentity = async (context) => {
    const result = requireEffect(await effect('identity/read', {}, context));
    return typeof result.value === 'string' ? result.value : null;
  };

  /** @param {any} outcome @param {TransferContext} context */
  const applyPolicy = async (outcome, context) => {
    const changesIdentity = outcome?.adopted && typeof outcome.material === 'string';
    if (!changesIdentity) return outcome;
    const policy = requireEffect(await effect('identity/policy', {
      incomingDid: outcome?.did ?? outcome?.incomingDid ?? null,
    }, context));
    if (policy.allowed === true) return outcome;
    const { material: _material, ...blocked } = outcome ?? {};
    return { ...blocked, adopted: false, reason: policy.reason ?? 'identity-in-use' };
  };

  /** @param {any} record @param {string} passphrase @param {boolean} replaceExisting @param {TransferContext} context */
  const inspect = async (record, passphrase, replaceExisting, context) => {
    const existingMaterial = await readIdentity(context);
    let outcome;
    try {
      outcome = await runCrypto('adopt', {
        record, passphrase, existingMaterial, replaceExisting,
      }, {
        signal: context.signal,
        deadline: context.deadline,
        parentOperationId: context.operationId,
      });
      assertLive(context);
    } catch (cause) {
      if (cause instanceof IdentityTransferHostError) throw cause;
      throw new IdentityTransferHostError(
        /** @type {{code?:string}} */ (cause)?.code ?? 'host-failed', { cause },
      );
    }
    const existingUnreadable = outcome?.reason === 'invalid-local-identity'
      || outcome?.reason === 'replaced-invalid-local';
    const existingRevision = existingUnreadable
      && typeof existingMaterial === 'string' && existingMaterial.length > 0
      ? await materialRevision(existingMaterial, context)
      : undefined;
    return {
      outcome: await applyPolicy(outcome, context),
      existingMaterial,
      existingUnreadable,
      existingRevision,
    };
  };

  /** @param {string} passphrase @param {TransferContext} context */
  const exportRecord = async (passphrase, context) => {
    assertLive(context);
    const material = await readIdentity(context);
    if (!material) return null;
    let parsed;
    try { parsed = JSON.parse(material); }
    catch (cause) {
      throw new IdentityTransferHostError('bad-local-identity', { cause });
    }
    let record;
    try {
      record = await runCrypto('export', { material: parsed, passphrase }, {
        signal: context.signal,
        deadline: context.deadline,
        parentOperationId: context.operationId,
      });
      assertLive(context);
    } catch (cause) {
      if (cause instanceof IdentityTransferHostError) throw cause;
      throw new IdentityTransferHostError(
        /** @type {{code?:string}} */ (cause)?.code ?? 'host-failed', { cause },
      );
    }
    if (!record) throw new IdentityTransferHostError('empty-record');
    return { identityRecord: record };
  };

  /** @param {any} record @param {string} passphrase @param {{replaceExisting?:boolean}} options @param {TransferContext} context */
  const prepareRecord = async (record, passphrase, options, context) => {
    assertLive(context);
    const { outcome, existingUnreadable, existingRevision } = await inspect(
      record, passphrase, options?.replaceExisting === true, context,
    );
    const { material: _material, ...publicOutcome } = outcome ?? {};
    return existingUnreadable
      ? { ...publicOutcome, existingUnreadable: true, existingRevision }
      : publicOutcome;
  };

  /** @param {any} record @param {string} passphrase @param {{replaceExisting?:boolean,expectedExistingDid?:string|null,expectedExistingRevision?:string,expectedIncomingDid?:string}} options @param {TransferContext} context */
  const adoptRecord = async (record, passphrase, options, context) => {
    assertLive(context);
    const {
      replaceExisting = false, expectedExistingDid,
      expectedExistingRevision, expectedIncomingDid,
    } = options ?? {};
    const leaseId = context.operationId;
    let suspensionAttempted = false;
    let committed = false;
    let commitDispatched = false;
    let outcomeResult;
    let operationError;
    try {
      const inspected = await inspect(record, passphrase, replaceExisting, context);
      const { existingMaterial, existingUnreadable, existingRevision } = inspected;
      const outcome = inspected.outcome;
      const revisionChanged = typeof expectedExistingRevision === 'string'
        && (typeof existingMaterial !== 'string'
          || await materialRevision(existingMaterial, context) !== expectedExistingRevision);
      if ((expectedExistingDid !== undefined
            && (outcome?.existingDid ?? null) !== expectedExistingDid)
          || revisionChanged
          || (typeof expectedIncomingDid === 'string'
            && outcome?.incomingDid !== expectedIncomingDid)) {
        outcomeResult = { ...outcome, adopted: false, material: null, reason: 'identity-changed' };
      } else if (!outcome?.adopted || typeof outcome.material !== 'string') {
        outcomeResult = outcome;
      } else {
        context.setPhase?.('suspending');
        suspensionAttempted = true;
        try {
          await stopIdentityRuntime(leaseId, context);
          assertLive(context);
        } catch (cause) {
          if (cause instanceof IdentityTransferHostError) throw cause;
          throw new IdentityTransferHostError('stop-failed', { cause });
        }
        const commitExpectedRevision = expectedExistingRevision
          ?? (existingUnreadable ? existingRevision : undefined);
        const commitExpectedDid = expectedExistingDid !== undefined
          ? expectedExistingDid : outcome.existingDid ?? null;
        const stored = requireEffect(await effect('identity/commit', {
          value: outcome.material,
          incomingDid: outcome.did ?? outcome.incomingDid ?? null,
          expectedExistingDid: commitExpectedDid,
          ...(commitExpectedRevision ? { expectedExistingRevision: commitExpectedRevision } : {}),
        }, context, () => {
          commitDispatched = true;
          context.setPhase?.('commit-dispatched');
        }));
        committed = stored.committed === true;
        const { material: _material, ...publicOutcome } = outcome;
        outcomeResult = existingUnreadable
          ? { ...publicOutcome, existingUnreadable: true, existingRevision }
          : publicOutcome;
      }
    } catch (cause) {
      operationError = cause;
    }
    if ((suspensionAttempted || committed)
        && (committed || !commitDispatched
          || /** @type {{outcomeKnown?:boolean}} */ (operationError)?.outcomeKnown !== false)) {
      context.setPhase?.('recovering');
      try { await startIdentityRuntime(leaseId, context); }
      catch (cause) {
        if (outcomeResult) outcomeResult = { ...outcomeResult, runtimeRecoveryPending: true };
        else operationError = new IdentityTransferHostError('start-failed', {
          cause, outcomeKnown: false,
        });
      }
    }
    if (operationError) throw operationError;
    return outcomeResult;
  };

  return Object.freeze({ exportRecord, prepareRecord, adoptRecord });
};
