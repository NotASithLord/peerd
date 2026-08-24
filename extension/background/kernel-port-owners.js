// @ts-check

import {
  coldPortNamesFor, LEGACY_PORT_CLASSES,
} from './cold-kernel-inventory.js';
import { makeBoundedModuleLoader } from '../shared/bounded-module-load.js';

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
  /** @type {Record<string,boolean>} */
  const readiness = {};
  /** @type {Record<string,string>} */
  const failClosedPorts = {};
  for (const { name, reason } of LEGACY_PORT_CLASSES) {
    if (requiredSet.has(name)) {
      handlers[name] = synchronousOwner(
        name,
        /** @type {(port:any,context:any)=>unknown} */ (attachers[name]),
      );
      owners[name] = OWNER_NAMES[name];
      readiness[name] = true;
    } else {
      failClosedPorts[name] = CLOSED_REASONS[name]
        ?? reason
        ?? 'port-class-not-present-on-target';
    }
  }
  return Object.freeze({
    handlers: Object.freeze(handlers),
    owners: Object.freeze(owners),
    readiness: Object.freeze(readiness),
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
      void Promise.resolve(pushState()).catch(() => {});
      broadcastSurfaces();
      broadcastAgentTab();
      const goals = activeGoalStates();
      if (!Array.isArray(goals)) throw new TypeError('kernel-ui-goal-state-invalid');
      for (const event of goals) {
        try { port.postMessage(event); } catch { break; }
      }
      void Promise.resolve(onUiConnect(port)).catch(() => {});
    },
  });
};

/** @param {any} port */
const bufferDwebPort = (port) => {
  /** @type {any[]} */ const queued = [];
  /** @type {Set<(event:any)=>void>} */ const messages = new Set();
  /** @type {Set<()=>void>} */ const disconnects = new Set();
  let disconnected = false;
  port.onMessage.addListener((/** @type {any} */ message) => {
    if (messages.size === 0) {
      if (queued.length >= 64) { disconnect(port); return; }
      queued.push(message);
      return;
    }
    for (const listener of messages) listener(message);
  });
  port.onDisconnect.addListener(() => {
    disconnected = true;
    for (const listener of disconnects) listener();
  });
  return Object.freeze({
    get name() { return port.name; }, get sender() { return port.sender; },
    postMessage: (/** @type {any} */ message) => port.postMessage(message),
    disconnect: () => port.disconnect(),
    onMessage: Object.freeze({ addListener(/** @type {(event:any)=>void} */ listener) {
      messages.add(listener);
      while (queued.length > 0) listener(queued.shift());
    } }),
    onDisconnect: Object.freeze({ addListener(/** @type {()=>void} */ listener) {
      disconnects.add(listener);
      if (disconnected) listener();
    } }),
  });
};

/** @param {any} deps */
export const createKernelDwebCustodyOwner = ({ enabled, load, timeoutMs = 15_000 }) => {
  if (typeof enabled !== 'boolean' || typeof load !== 'function') {
    throw new TypeError('kernel-dweb-custody-owner-config-invalid');
  }
  const runtime = makeBoundedModuleLoader(async () => {
    const value = await load();
    if (typeof value?.attachDwebCustody !== 'function'
        || typeof value?.dwebTransfer?.exportRecord !== 'function'
        || typeof value.dwebTransfer.prepareRecord !== 'function'
        || typeof value.dwebTransfer.adoptRecord !== 'function'
        || typeof value.withIdentityMutation !== 'function') {
      throw new TypeError('kernel-dweb-custody-runtime-invalid');
    }
    return value;
  }, {
    timeoutMs,
    loadCode: 'kernel-dweb-custody-load-failed',
    timeoutCode: 'kernel-dweb-custody-load-timeout',
  });
  let generation = 0;
  /** @type {any|null} */ let active = null;
  const attachDwebCustody = (/** @type {any} */ port) => {
    if (!enabled || !port || typeof port.postMessage !== 'function'
        || typeof port.disconnect !== 'function'
        || typeof port.onMessage?.addListener !== 'function'
        || typeof port.onDisconnect?.addListener !== 'function') {
      throw new TypeError('kernel-dweb-custody-port-invalid');
    }
    const owned = bufferDwebPort(port);
    const token = ++generation;
    if (active && active !== port) disconnect(active);
    active = port;
    port.onDisconnect.addListener(() => { if (active === port) active = null; });
    void runtime().then((value) => {
      if (token === generation && active === port) value.attachDwebCustody(owned);
    }).catch(() => {
      if (active === port) active = null;
      disconnect(port);
    });
  };
  const getDwebLive = async () => enabled ? runtime() : null;
  return Object.freeze({
    attachDwebCustody, getDwebLive,
    getDwebTransfer: async () => (await getDwebLive())?.dwebTransfer ?? null,
  });
};
