// @ts-check
// Kernel-owned authentication for the offscreen feature-host keepalive Port.
// A disconnect has recovery authority only after one heartbeat proves an exact
// current lease under the same build, boot, kernel, host, and lease generation.

import {
  FEATURE_LEASE_HOST_COMMAND,
  FEATURE_LEASE_HOST_COMMAND_RESULT,
  FEATURE_LEASE_HOST_PROTOCOL,
} from '../shared/feature-lease-protocol.js';
import { parseKernelIdentity } from '../shared/kernel-identity.js';

const safeHeartbeatId = (/** @type {unknown} */ value) => typeof value === 'string'
  && value.length >= 8 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/.test(value);

/**
 * @param {Object} deps
 * @param {any} deps.port
 * @param {{snapshot:()=>any,handleHostLoss:(hostEpoch:string)=>Promise<any>}} deps.featureLeases
 * @param {import('../shared/kernel-identity.js').KernelIdentity} deps.identity
 * @param {(hostEpoch:string)=>void} [deps.onAuthenticated]
 * @param {(hostEpoch:string)=>Promise<void>|void} [deps.onLost]
 * @param {(recovery:any)=>Promise<void>|void} [deps.onRecovered]
 * @param {(cause:unknown)=>void} [deps.onError]
 * @param {()=>Promise<boolean>|boolean} [deps.authorize]
 * @param {()=>Promise<boolean>|boolean} [deps.authorizeLoss]
 * @param {() => string} [deps.newId]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 */
export const attachFeatureLeaseKeepalive = ({
  port,
  featureLeases,
  identity,
  onAuthenticated = () => {},
  onLost = () => {},
  onRecovered = () => {},
  onError = () => {},
  authorize = () => true,
  authorizeLoss = authorize,
  newId = () => crypto.randomUUID(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  const canonicalIdentity = parseKernelIdentity(identity);
  if (!canonicalIdentity || !port?.onMessage?.addListener
      || !port?.onDisconnect?.addListener
      || typeof featureLeases?.snapshot !== 'function'
      || typeof featureLeases?.handleHostLoss !== 'function') {
    throw new TypeError('feature-lease-keepalive-config-invalid');
  }
  /** @type {string|null} */
  let authenticatedHostEpoch = null;
  let disconnected = false;
  /** @type {Map<string, {resolve:(value:any)=>void,reject:(cause:Error)=>void,timer:ReturnType<typeof setTimeout>,outcomeKnown:boolean}>} */
  const commands = new Map();

  port.onMessage.addListener((/** @type {any} */ message) => {
    if (message?.type === FEATURE_LEASE_HOST_COMMAND_RESULT
        && message.protocol === FEATURE_LEASE_HOST_PROTOCOL
        && typeof message.commandId === 'string') {
      const pending = commands.get(message.commandId);
      if (!pending) return;
      commands.delete(message.commandId);
      clearTimeoutFn(pending.timer);
      if (message.result?.protocol !== FEATURE_LEASE_HOST_PROTOCOL) {
        pending.reject(Object.assign(new Error('feature-lease-host-command-result-invalid'), {
          code: 'feature-lease-host-command-result-invalid',
          outcomeKnown: pending.outcomeKnown,
        }));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (disconnected || message?.type !== 'feature-lease/heartbeat'
        || message.protocol !== FEATURE_LEASE_HOST_PROTOCOL
        || message.buildId !== canonicalIdentity.buildId
        || !safeHeartbeatId(message.heartbeatId)
        || typeof message.hostEpoch !== 'string'
        || !Array.isArray(message.leases) || message.leases.length === 0) return;
    void Promise.resolve(authorize()).then((authorized) => {
      if (!authorized || disconnected) return;
      const snapshot = featureLeases.snapshot();
      if (snapshot?.schema !== canonicalIdentity.schema
          || snapshot?.buildId !== canonicalIdentity.buildId
          || snapshot?.bootId !== canonicalIdentity.bootId
          || snapshot?.kernelEpoch !== canonicalIdentity.kernelEpoch) return;
      const current = message.leases.some((/** @type {any} */ lease) => {
        const state = snapshot.leases?.[lease?.scope];
        return lease?.schema === canonicalIdentity.schema
          && lease?.buildId === canonicalIdentity.buildId
          && lease?.bootId === canonicalIdentity.bootId
          && lease?.kernelEpoch === canonicalIdentity.kernelEpoch
          && lease?.hostEpoch === message.hostEpoch
          && ['starting', 'active', 'unknown'].includes(state?.status)
          && state?.leaseId === lease?.leaseId
          && state?.generation === lease?.generation;
      });
      if (!current) return;
      authenticatedHostEpoch = message.hostEpoch;
      onAuthenticated(message.hostEpoch);
      try {
        port.postMessage({
          type: 'feature-lease/heartbeat-ack',
          protocol: FEATURE_LEASE_HOST_PROTOCOL,
          hostEpoch: message.hostEpoch,
          heartbeatId: message.heartbeatId,
        });
      } catch { /* disconnect owns recovery */ }
    }).catch(onError);
  });

  port.onDisconnect.addListener(() => {
    if (disconnected) return;
    disconnected = true;
    for (const [commandId, pending] of commands) {
      commands.delete(commandId);
      clearTimeoutFn(pending.timer);
      pending.reject(Object.assign(new Error('feature-lease-host-command-disconnected'), {
        code: 'feature-lease-host-command-disconnected',
        outcomeKnown: pending.outcomeKnown,
      }));
    }
    const lostHostEpoch = authenticatedHostEpoch;
    authenticatedHostEpoch = null;
    if (!lostHostEpoch) return;
    // why: MessagePort `close` is not a reliable renderer-loss signal in
    // Chrome. The authenticated keepalive is, so retire in-flight clients
    // immediately instead of leaving a committed turn pending until timeout.
    void Promise.resolve(authorizeLoss()).then((authorized) => {
      if (!authorized) return;
      try { void Promise.resolve(onLost(lostHostEpoch)).catch(onError); }
      catch (cause) { onError(cause); }
      void featureLeases.handleHostLoss(lostHostEpoch)
        .then(onRecovered)
        .catch(onError);
    }).catch(onError);
  });

  const request = (/** @type {any} */ message) => new Promise((resolve, reject) => {
    if (disconnected || !['feature-lease/host-status', 'feature-lease/host-start',
      'feature-lease/host-stop'].includes(message?.type)
        || message.protocol !== FEATURE_LEASE_HOST_PROTOCOL) {
      reject(Object.assign(new Error('feature-lease-host-command-invalid'), {
        code: 'feature-lease-host-command-invalid', outcomeKnown: true,
      }));
      return;
    }
    const commandId = newId();
    const outcomeKnown = message.type === 'feature-lease/host-status';
    const timeoutMs = outcomeKnown ? 400 : 14_500;
    const timer = setTimeoutFn(() => {
      const pending = commands.get(commandId);
      if (!pending) return;
      commands.delete(commandId);
      pending.reject(Object.assign(new Error('feature-lease-host-command-timeout'), {
        code: 'feature-lease-host-command-timeout', outcomeKnown,
      }));
    }, timeoutMs);
    commands.set(commandId, { resolve, reject, timer, outcomeKnown });
    try {
      port.postMessage({
        type: FEATURE_LEASE_HOST_COMMAND,
        protocol: FEATURE_LEASE_HOST_PROTOCOL,
        commandId,
        message,
      });
    } catch (cause) {
      commands.delete(commandId);
      clearTimeoutFn(timer);
      reject(Object.assign(new Error('feature-lease-host-command-dispatch-failed', { cause }), {
        code: 'feature-lease-host-command-dispatch-failed', outcomeKnown,
      }));
    }
  });

  return Object.freeze({ request });
};
