// @ts-check

import {
  classifyDrivenChildRequestTarget,
  makeDrivenChildRequestGuard,
  makeFirefoxDrivenChildMarkerStore,
} from './driven-child-request-guard.js';
import { createKernelFirefoxUpdateCustody } from './kernel-firefox-update-custody.js';
import { createKernelFirefoxVoiceHost } from './kernel-firefox-voice-host.js';

// why: Firefox must evaluate child-request custody at event-page startup, but
// controller, lifetime, and repository owners have no synchronous listener duty.
/** @template T @param {()=>Promise<T>} loader */
const deferredModule = (loader) => {
  /** @type {Promise<T>|null} */ let pending = null;
  return () => {
    pending ??= Promise.resolve().then(loader).catch((cause) => {
      pending = null;
      throw cause;
    });
    return pending;
  };
};

/**
 * @param {Object} [loaders]
 * @param {()=>Promise<any>} [loaders.controller]
 * @param {()=>Promise<any>} [loaders.lifetime]
 * @param {()=>Promise<any>} [loaders.repository]
 * @returns {any}
 */
export const createKernelFirefoxLazyAddon = ({
  controller = () => import('./direct-controller-client.js'),
  lifetime = () => import('./firefox-storage-keepalive.js'),
  repository = () => import('./repository-local-client.js'),
} = {}) => {
  const loadController = deferredModule(controller);
  const loadLifetime = deferredModule(lifetime);
  const loadRepository = deferredModule(repository);
  return Object.freeze(Object.defineProperties({}, {
    connectDirectController: {
      enumerable: true,
      value: async (/** @type {any} */ deps) => {
        const module = await loadController();
        if (typeof module.connectDirectController !== 'function') {
          throw new TypeError('kernel-firefox-controller-invalid');
        }
        return module.connectDirectController(deps);
      },
    },
    createFirefoxRepositoryClient: {
      enumerable: true,
      value: async (/** @type {any} */ deps) => {
        const module = await loadRepository();
        if (typeof module.createFirefoxRepositoryClient !== 'function') {
          throw new TypeError('kernel-firefox-repository-invalid');
        }
        return module.createFirefoxRepositoryClient(deps);
      },
    },
    firefoxLifetime: {
      enumerable: true,
      get: loadLifetime,
    },
    update: {
      enumerable: true,
      value: createKernelFirefoxUpdateCustody,
    },
    createVoiceHost: {
      enumerable: true,
      value: createKernelFirefoxVoiceHost,
    },
  }));
};

const root = /** @type {any} */ (globalThis);
const addonId = Symbol.for('peerd.kernel.firefox-addon.v1');
if (root[addonId]) throw new Error('kernel-firefox-addon-owner-conflict');
export const createKernelFirefoxGuard = (/** @type {any} */ {
  isDrivenSource, isSourceReady, waitForSourceEvidence, waitForSourceAuthority,
  ensureSourceAuthority,
  isSensitiveHost, isPolicyReady, waitForPolicyReady,
  onBlocked, turnSlots, webActorSessionForTab, closeTab, noteUnavailable,
  storage = globalThis.localStorage,
  classificationTimeoutMs,
}) => {
  const onUnavailable = (/** @type {any} */ failure) => {
    const sessions = new Set();
    for (const sourceTabId of failure.sourceTabIds ?? []) {
      try {
        const sessionId = webActorSessionForTab?.(sourceTabId);
        if (typeof sessionId === 'string') sessions.add(sessionId);
      } catch {}
    }
    for (const sessionId of sessions) {
      try { turnSlots()?.stop?.(sessionId); } catch {}
      noteUnavailable('Web automation paused. Retry.', null, sessionId);
    }
    for (const tabId of failure.closeTabIds ?? []) {
      void Promise.resolve(closeTab(tabId)).catch(() => {});
    }
  };
  return makeDrivenChildRequestGuard({
    isDrivenSource, isSourceReady, waitForSourceEvidence, waitForSourceAuthority,
    ensureSourceAuthority,
    waitForPolicyReady, onBlocked, onUnavailable,
    classificationTimeoutMs,
    classifyTarget: (url) => classifyDrivenChildRequestTarget(
      url, isSensitiveHost, isPolicyReady?.() === true,
    ),
    markers: makeFirefoxDrivenChildMarkerStore(storage),
  });
};
Object.defineProperties(
  createKernelFirefoxGuard,
  Object.getOwnPropertyDescriptors(createKernelFirefoxLazyAddon()),
);
root[addonId] = Object.freeze(createKernelFirefoxGuard);
