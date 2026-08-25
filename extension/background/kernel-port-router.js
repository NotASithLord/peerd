// @ts-check
// Exact runtime Port admission for the thin authority kernel. Ports never pass
// to a generic semantic host: the kernel retains browser-owned provenance and
// delegates only to one explicitly injected class owner.

import { KERNEL_PORT_CLASSES } from './cold-kernel-inventory.js';
import { parseKernelIdentity } from '../shared/kernel-identity.js';

export const KERNEL_PORT_NAMES = Object.freeze(
  KERNEL_PORT_CLASSES.map((entry) => entry.name),
);
/** @type {Set<string>} */
const PORT_NAME_SET = new Set(KERNEL_PORT_NAMES);

const disconnect = (/** @type {any} */ port) => {
  try { port?.disconnect?.(); } catch { /* already disconnected */ }
};

/**
 * @typedef {{
 *   identity: import('../shared/kernel-identity.js').KernelIdentity,
 *   name: string,
 * }} KernelPortContext
 */

/**
 * @param {Object} deps
 * @param {import('../shared/kernel-identity.js').KernelIdentity} deps.identity
 * @param {Record<string, (sender:any, port:any)=>boolean>} deps.provenance
 * @param {Record<string, (port:any, context:KernelPortContext)=>unknown>} deps.handlers
 */
export const createKernelPortRouter = ({ identity, provenance, handlers }) => {
  const canonicalIdentity = parseKernelIdentity(identity);
  if (!canonicalIdentity) throw new TypeError('kernel-port-identity-invalid');
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)
      || !handlers || typeof handlers !== 'object' || Array.isArray(handlers)) {
    throw new TypeError('kernel-port-router-config-invalid');
  }
  const provenanceKeys = Object.keys(provenance).sort();
  if (provenanceKeys.join('\n') !== [...KERNEL_PORT_NAMES].sort().join('\n')
      || provenanceKeys.some((name) => typeof provenance[name] !== 'function')) {
    throw new TypeError('kernel-port-provenance-incomplete');
  }
  if (Object.keys(handlers).some((name) =>
    !PORT_NAME_SET.has(name) || typeof handlers[name] !== 'function')) {
    throw new TypeError('kernel-port-handler-invalid');
  }

  const route = (/** @type {any} */ port) => {
    const name = typeof port?.name === 'string' ? port.name : '';
    if (!PORT_NAME_SET.has(name)) {
      disconnect(port);
      return Object.freeze({ accepted: false, name, reason: 'unknown-port' });
    }
    let proven = false;
    try { proven = provenance[name](port?.sender, port) === true; }
    catch { proven = false; }
    if (!proven) {
      disconnect(port);
      return Object.freeze({ accepted: false, name, reason: 'provenance-refused' });
    }
    const handler = handlers[name];
    if (typeof handler !== 'function') {
      disconnect(port);
      return Object.freeze({ accepted: false, name, reason: 'owner-unavailable' });
    }
    try {
      const result = handler(port, Object.freeze({ identity: canonicalIdentity, name }));
      if (result && typeof result === 'object' && 'then' in result
          && typeof /** @type {any} */ (result).then === 'function') {
        Promise.resolve(result).catch(() => disconnect(port));
      }
      return Object.freeze({ accepted: true, name, reason: null });
    } catch {
      disconnect(port);
      return Object.freeze({ accepted: false, name, reason: 'owner-failed' });
    }
  };

  return Object.freeze({
    identity: canonicalIdentity,
    names: KERNEL_PORT_NAMES,
    route,
  });
};
