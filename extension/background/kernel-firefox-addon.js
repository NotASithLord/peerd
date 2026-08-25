// @ts-check

import {
  classifyDrivenChildRequestTarget,
  makeDrivenChildRequestGuard,
  makeFirefoxDrivenChildMarkerStore,
} from './driven-child-request-guard.js';
import { connectDirectController } from './direct-controller-client.js';
import * as firefoxLifetime from './firefox-storage-keepalive.js';
import { createFirefoxRepositoryClient } from './repository-local-client.js';

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
root[addonId] = Object.freeze(Object.assign(createKernelFirefoxGuard, {
  connectDirectController,
  createFirefoxRepositoryClient,
  firefoxLifetime,
}));
