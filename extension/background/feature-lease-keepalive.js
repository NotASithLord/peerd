// @ts-check
// Kernel-owned authentication for the offscreen feature-host keepalive Port.
// A disconnect has recovery authority only after one heartbeat proves an exact
// current lease under the same build, boot, kernel, host, and lease generation.

import {
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
 */
export const attachFeatureLeaseKeepalive = ({
  port,
  featureLeases,
  identity,
  onAuthenticated = () => {},
  onLost = () => {},
  onRecovered = () => {},
  onError = () => {},
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

  port.onMessage.addListener((/** @type {any} */ message) => {
    if (disconnected || message?.type !== 'feature-lease/heartbeat'
        || message.protocol !== FEATURE_LEASE_HOST_PROTOCOL
        || message.buildId !== canonicalIdentity.buildId
        || !safeHeartbeatId(message.heartbeatId)
        || typeof message.hostEpoch !== 'string'
        || !Array.isArray(message.leases) || message.leases.length === 0) return;
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
  });

  port.onDisconnect.addListener(() => {
    if (disconnected) return;
    disconnected = true;
    const lostHostEpoch = authenticatedHostEpoch;
    authenticatedHostEpoch = null;
    if (!lostHostEpoch) return;
    // why: MessagePort `close` is not a reliable renderer-loss signal in
    // Chrome. The authenticated keepalive is, so retire in-flight clients
    // immediately instead of leaving a committed turn pending until timeout.
    try { void Promise.resolve(onLost(lostHostEpoch)).catch(onError); }
    catch (cause) { onError(cause); }
    void featureLeases.handleHostLoss(lostHostEpoch)
      .then(onRecovered)
      .catch(onError);
  });

};
