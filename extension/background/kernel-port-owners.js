// @ts-check

import {
  coldPortNamesFor, KERNEL_PORT_CLASSES,
} from './cold-kernel-inventory.js';
import { parseKernelIdentity } from '../shared/kernel-identity.js';

export const KERNEL_PORT_NAMES = Object.freeze(
  KERNEL_PORT_CLASSES.map((entry) => entry.name),
);
const PORT_NAME_SET = new Set(KERNEL_PORT_NAMES);

/** @type {Readonly<Record<string,string>>} */
const OWNER_NAMES = Object.freeze({
  'private-transfer': 'kernel-private-transfer',
  sidepanel: 'vault-ui-ports',
  home: 'vault-ui-ports',
  eval: 'vault-ui-ports',
  'feature-lease-keepalive': 'kernel-feature-host',
  'dweb-custody': 'kernel-dweb-custody',
});

/** @type {Readonly<Record<string,string>>} */
const CLOSED_REASONS = Object.freeze({
  'private-transfer': 'window-client-transfer-owned-on-chrome',
  'feature-lease-keepalive': 'firefox-background-owns-feature-lifetime',
  'dweb-custody': 'dweb-not-packaged-for-target',
});

const disconnect = (/** @type {any} */ port) => {
  try { port?.disconnect?.(); } catch { /* already disconnected */ }
};

/**
 * @param {Object} deps
 * @param {import('../shared/kernel-identity.js').KernelIdentity} deps.identity
 * @param {Record<string, (sender:any, port:any)=>boolean>} deps.provenance
 * @param {Record<string, (port:any, context:any)=>unknown>} deps.handlers
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

  return Object.freeze({ identity: canonicalIdentity, names: KERNEL_PORT_NAMES, route });
};

/** @param {string} name @param {(port:any,context:any)=>unknown} attach */
const synchronousOwner = (name, attach) => (/** @type {any} */ port,
  /** @type {any} */ context) => {
  const result = attach(port, context);
  if (result && typeof result === 'object'
      && typeof /** @type {{then?:unknown}} */ (result).then === 'function') {
    // why: a Port can pin the worker. Admission is not complete until its
    // target owner has synchronously taken custody.
    disconnect(port);
    void Promise.resolve(result).catch(() => {});
    throw new TypeError(`kernel-port-owner-async:${name}`);
  }
  return result;
};

/**
 * Target-exact Port owners and assembly evidence. Unshipped classes remain
 * absent even when a caller accidentally supplies their handler.
 * @param {Object} deps
 * @param {boolean} [deps.firefox]
 * @param {boolean} [deps.dweb]
 * @param {(port:any,context:any)=>unknown} deps.attachUi
 * @param {(port:any,context:any)=>unknown} [deps.attachPrivateTransfer]
 * @param {(port:any,context:any)=>unknown} [deps.attachFeatureLease]
 * @param {(port:any,context:any)=>unknown} [deps.attachDwebCustody]
 */
export const createKernelPortOwners = ({
  firefox = false,
  dweb = false,
  attachUi,
  attachPrivateTransfer,
  attachFeatureLease,
  attachDwebCustody,
}) => {
  /** @type {Record<string,((port:any,context:any)=>unknown)|undefined>} */
  const attachers = {
    'private-transfer': attachPrivateTransfer,
    sidepanel: attachUi,
    home: attachUi,
    eval: attachUi,
    'feature-lease-keepalive': attachFeatureLease,
    'dweb-custody': attachDwebCustody,
  };
  const required = coldPortNamesFor({ firefox, dweb });
  if (required.some((name) => typeof attachers[name] !== 'function')) {
    throw new TypeError('kernel-port-owners-config-invalid');
  }
  const requiredSet = new Set(required);
  /** @type {Record<string,(port:any,context:any)=>unknown>} */
  const handlers = {};
  /** @type {Record<string,string>} */
  const owners = {};
  /** @type {Record<string,string>} */
  const failClosedPorts = {};
  for (const { name, reason } of KERNEL_PORT_CLASSES) {
    if (requiredSet.has(name)) {
      handlers[name] = synchronousOwner(
        name,
        /** @type {(port:any,context:any)=>unknown} */ (attachers[name]),
      );
      owners[name] = OWNER_NAMES[name];
    } else {
      failClosedPorts[name] = CLOSED_REASONS[name]
        ?? reason
        ?? 'port-class-not-present-on-target';
    }
  }
  return Object.freeze({
    handlers: Object.freeze(handlers),
    owners: Object.freeze(owners),
    failClosedPorts: Object.freeze(failClosedPorts),
    required: Object.freeze(required),
  });
};

/** @param {any} deps */
export const createKernelUiPortOwner = ({
  uiPorts, pushState, broadcastSurfaces, broadcastAgentTab, activeGoalStates,
  onUiConnect = () => {}, onQuiet = () => {}, getActiveTab = async () => null,
  showWebTabHint = () => {},
}) => {
  if ([
    uiPorts?.add, uiPorts?.remove, uiPorts?.hasNamed, pushState,
    broadcastSurfaces, broadcastAgentTab, activeGoalStates,
    onUiConnect, onQuiet, getActiveTab, showWebTabHint,
  ].some((value) => typeof value !== 'function')) {
    throw new TypeError('kernel-ui-port-owner-config-invalid');
  }
  return Object.freeze({
    attach(/** @type {any} */ port) {
      if (!port || typeof port.postMessage !== 'function'
          || typeof port.onDisconnect?.addListener !== 'function') {
        throw new TypeError('kernel-ui-port-invalid');
      }
      let live = true;
      uiPorts.add(port);
      port.onDisconnect.addListener(() => {
        if (!live) return;
        live = false;
        uiPorts.remove(port);
        broadcastSurfaces();
        void Promise.resolve(onQuiet()).catch(() => {});
        if (port.name === 'sidepanel' && !uiPorts.hasNamed('sidepanel')) {
          void getActiveTab().then((/** @type {any} */ tab) => {
            if (typeof tab?.id === 'number') return showWebTabHint(tab.id);
          }).catch(() => {});
        }
      });
      // why: the authoritative snapshot establishes which session this fresh
      // surface is viewing. Replaying live actor rows before that snapshot lets
      // the reducer accept them, then discard them as belonging to the former
      // null session when the snapshot arrives.
      const hydrated = Promise.resolve(pushState()).catch(() => {});
      broadcastSurfaces();
      broadcastAgentTab();
      const goals = activeGoalStates();
      if (!Array.isArray(goals)) throw new TypeError('kernel-ui-goal-state-invalid');
      for (const event of goals) {
        try { port.postMessage(event); } catch { break; }
      }
      // why: rich owners must snapshot live topology immediately, before a
      // state read queued behind active semantic work can observe it settled.
      // They receive the hydration barrier and publish only after it resolves.
      void Promise.resolve(onUiConnect(port, hydrated)).catch(() => {});
    },
  });
};
