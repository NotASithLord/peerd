// @ts-check

import { loadDweb } from '../shared/dweb-loader.js';
import { makeDwebCustodyClient, makeRetryableCustodyReset } from './dweb-custody-client.js';
import { makeDwebTransfer, IdentityTransferError } from './dweb-transfer.js';
import {
  identityChangeBlockedByApps, makeDwebIdentityCustody,
} from './dweb-identity-custody.js';
import { hasEnrolledSelfCustody, makeDwebSelfCustody } from './dweb-self-custody.js';

const IDENTITY_SECRET = 'distributed/identity/v1';
const SELF_RECORDS_SECRET = 'distributed/self-records/v1';

const serial = () => {
  let tail = Promise.resolve();
  return async (/** @type {()=>Promise<any>} */ operation) => {
    const running = tail.then(operation);
    tail = running.then(() => undefined, () => undefined);
    return running;
  };
};

/** @param {Record<string,any>} deps */
export const createKernelDwebCustodyRuntime = (deps) => {
  if (!deps.enabled || typeof deps.ensureDwebFeature !== 'function'
      || typeof deps.active !== 'function' || !deps.vault
      || !deps.auditLog || typeof deps.listApps !== 'function'
      || typeof deps.sendMessage !== 'function') {
    throw new TypeError('kernel-dweb-custody-runtime-config-invalid');
  }
  const withIdentityMutation = serial();
  const canChangeIdentity = async () => !identityChangeBlockedByApps(await deps.listApps());
  const identity = makeDwebIdentityCustody({
    enabled: true,
    active: deps.active,
    vault: deps.vault,
    auditLog: deps.auditLog,
    identitySecretName: IDENTITY_SECRET,
    withIdentityMutation,
    canChangeIdentity,
    canMintIdentity: async () => !await hasEnrolledSelfCustody(deps.vault),
  });
  const self = makeDwebSelfCustody({
    enabled: true,
    active: deps.active,
    vault: deps.vault,
    identitySecretName: IDENTITY_SECRET,
    withCustodyMutation: withIdentityMutation,
  });
  const custody = makeDwebCustodyClient({
    ensureOffscreen: deps.ensureDwebFeature,
    handleSecretRequest: (/** @type {any} */ operation, /** @type {any} */ args) =>
      operation === 'self-get' || operation === 'self-set'
        ? self.handle(operation, args) : identity.handle(operation, args),
  });
  const suspension = makeRetryableCustodyReset({
    enabled: true,
    hostAvailable: true,
    reset: async () => { await custody.call('reset'); },
  });
  const dwebTransfer = makeDwebTransfer({
    enabled: true,
    offscreenAvailable: true,
    vault: deps.vault,
    identitySecretName: IDENTITY_SECRET,
    runCustodyOperation: (/** @type {any} */ operation, /** @type {any} */ args) =>
      custody.call(operation, args),
    loadDweb,
    withIdentityMutation,
    canReplaceIdentity: canChangeIdentity,
    canAdoptIdentity: async (incomingDid) => {
      const stored = await deps.vault.getSecret(SELF_RECORDS_SECRET);
      if (!stored) return true;
      try { return JSON.parse(stored)?.certificate?.personDid === incomingDid; }
      catch { return false; }
    },
    stopIdentityRuntime: async (leaseId) => {
      await suspension.ensure();
      try { await custody.call('suspend', { leaseId }); }
      catch (cause) {
        throw new IdentityTransferError(
          'existing identity runtime could not be stopped', 'stop-failed', { cause },
        );
      }
    },
    startIdentityRuntime: async (leaseId) => {
      const release = async () => {
        const reply = await custody.call('resume', { leaseId });
        if (!reply?.resumed) {
          throw new IdentityTransferError('identity runtime could not resume', 'resume-failed');
        }
        await deps.sendMessage({ type: 'dweb/base-host/start' }).catch(() => {});
      };
      const retry = () => {
        void release().catch(() => setTimeout(retry, 1_000));
      };
      try { await release(); }
      catch (cause) {
        setTimeout(retry, 1_000);
        throw cause;
      }
    },
    audit: (/** @type {any} */ event) => deps.auditLog.append(event),
  });
  return Object.freeze({
    attachDwebCustody: custody.attach,
    dwebTransfer,
    withIdentityMutation,
  });
};
