// @ts-check
// Firefox can synchronously cancel a request while the exact child tab is
// waiting for its durable tab-scoped DNR floor. Chrome does not expose MV3
// blocking webRequest, so its child path continues to use blank-first adoption
// plus the same durable floor.

import { isCloudMetadataHost, isPrivateOrLocalHost } from '../shared/private-network.js';

/**
 * @typedef {{ allowed: boolean, reason?: string }} ChildRequestVerdict
 */

/**
 * @param {string} rawUrl
 * @param {(hostname: string) => boolean} [isSensitiveHost]
 * @param {boolean} [policyReady]
 * @returns {ChildRequestVerdict}
 */
export const classifyDrivenChildRequestTarget = (
  rawUrl,
  isSensitiveHost = () => false,
  policyReady = true,
) => {
  let target;
  try { target = new URL(rawUrl); } catch { return { allowed: true }; }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol)) return { allowed: true };
  if (isCloudMetadataHost(target.hostname)) return { allowed: false, reason: 'cloud_metadata' };
  if (isPrivateOrLocalHost(target.hostname)) return { allowed: false, reason: 'private_network' };
  // A restored actor binding can become live before the async denylist seed.
  // Only an exact browser-identified child reaches this classifier, so holding
  // its request briefly is safer than guessing that an empty policy is real.
  if (!policyReady) return { allowed: false, reason: 'policy_loading' };
  if (isSensitiveHost(target.hostname)) return { allowed: false, reason: 'sensitive_site' };
  return { allowed: true };
};

export class FirefoxChildRequestGuardUnavailableError extends Error {
  /** @param {unknown} [cause] */
  constructor(cause) {
    super('Firefox exact-child request guard could not be registered', { cause });
    this.name = 'FirefoxChildRequestGuardUnavailableError';
  }
}

/**
 * Register only in a generated Firefox package. A Firefox failure is fatal:
 * silently continuing would advertise a guard that is not present.
 * @param {{ isFirefox: boolean, event: any, listener: (details: any) => any }} input
 */
export const registerFirefoxDrivenChildRequestGuard = ({ isFirefox, event, listener }) => {
  if (!isFirefox) return false;
  if (typeof event?.addListener !== 'function') {
    throw new FirefoxChildRequestGuardUnavailableError();
  }
  try {
    event.addListener(listener, { urls: ['<all_urls>'] }, ['blocking']);
  } catch (error) {
    throw new FirefoxChildRequestGuardUnavailableError(error);
  }
  return true;
};

/**
 * @param {Object} deps
 * @param {(sourceTabId: number) => boolean} deps.isDrivenSource
 * @param {(url: string) => ChildRequestVerdict} [deps.classifyTarget]
 * @param {(event: { sourceTabId: number, tabId: number, reason: string }) => unknown} [deps.onBlocked]
 */
export const makeDrivenChildRequestGuard = ({
  isDrivenSource,
  classifyTarget = classifyDrivenChildRequestTarget,
  onBlocked = () => {},
}) => {
  /** @type {Map<number, number>} */
  const exactChildren = new Map();
  const reported = new Set();

  const adopt = (/** @type {unknown} */ childTabId, /** @type {unknown} */ sourceTabId) => {
    if (typeof childTabId !== 'number' || typeof sourceTabId !== 'number') return;
    if (isDrivenSource(sourceTabId)) exactChildren.set(childTabId, sourceTabId);
  };

  return {
    /** @param {{ tabId?: number, sourceTabId?: number }} details */
    onNavigationTarget(details) {
      adopt(details.tabId, details.sourceTabId);
    },

    /**
     * This callback must stay synchronous. Firefox applies its returned cancel
     * decision before network IO; awaiting ownership or storage would reopen
     * the child-navigation race this guard exists to close.
     * @param {{ tabId?: number, url?: string, type?: string }} details
     */
    onBeforeRequest(details) {
      if (typeof details.tabId !== 'number' || !exactChildren.has(details.tabId)
          || typeof details.url !== 'string') return {};
      const verdict = classifyTarget(details.url);
      if (verdict.allowed) return {};
      if (details.type !== 'main_frame' && !reported.has(details.tabId)) {
        reported.add(details.tabId);
        try {
          onBlocked({
            sourceTabId: /** @type {number} */ (exactChildren.get(details.tabId)),
            tabId: details.tabId,
            reason: verdict.reason ?? 'private_network',
          });
        } catch { /* observability cannot change the synchronous cancel decision */ }
      }
      return { cancel: true };
    },

    /** @param {number} tabId */
    release(tabId) {
      exactChildren.delete(tabId);
      reported.delete(tabId);
    },

    has: (/** @type {number} */ tabId) => exactChildren.has(tabId),
  };
};
