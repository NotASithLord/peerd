// @ts-check
// Shared browser navigation observation.

/**
 * @typedef {Object} NavigationTab
 * @property {number} [id]
 * @property {string} [url]
 * @property {string} [pendingUrl]
 */

/**
 * @typedef {Object} NavigationTabsApi
 * @property {(tabId: number) => Promise<NavigationTab>} get
 * @property {(tabId: number, props: { url: string }) => Promise<NavigationTab | void>} update
 * @property {{ addListener: (listener: NavigationListener) => void, removeListener: (listener: NavigationListener) => void }} onUpdated
 */

/**
 * @callback NavigationListener
 * @param {number} tabId
 * @param {{ status?: string, url?: string }} changeInfo
 * @returns {void}
 */

/** @typedef {'complete' | 'timeout' | 'update_error'} NavigationStatus */

/**
 * @typedef {Object} NavigationObservation
 * @property {NavigationStatus} status
 * @property {string} [error]
 */

/** @param {unknown} value */
const comparableUrl = (value) => {
  if (typeof value !== 'string') return null;
  try { return new URL(value).href; }
  catch { return value; }
};

/**
 * Wait for a completion event tied to the requested navigation. A bare
 * `complete` event is not evidence because it may belong to the document that
 * was already loading when the listener was installed.
 *
 * @param {NavigationTabsApi} tabsApi
 * @param {number} tabId
 * @param {string} url
 * @param {{ timeoutMs: number }} options
 * @returns {Promise<NavigationObservation>}
 */
export const updateAndObserveCommittedNavigation = (tabsApi, tabId, url, options) => new Promise((resolve) => {
  const requestedUrl = comparableUrl(url);
  let updateResolved = false;
  let requestedTransitionObserved = false;
  let completedAfterRequestedTransition = false;
  let settled = false;

  /** @param {NavigationObservation} observation */
  const finish = (observation) => {
    if (settled) return;
    settled = true;
    tabsApi.onUpdated.removeListener(listener);
    clearTimeout(timer);
    resolve(observation);
  };

  /** @type {NavigationListener} */
  const listener = (updatedTabId, changeInfo) => {
    if (updatedTabId !== tabId) return;
    if (changeInfo.url && comparableUrl(changeInfo.url) === requestedUrl) {
      requestedTransitionObserved = true;
    }
    if (changeInfo.status === 'complete' && requestedTransitionObserved) {
      completedAfterRequestedTransition = true;
      if (updateResolved) finish({ status: 'complete' });
    }
  };

  const timer = setTimeout(() => finish({ status: 'timeout' }), options.timeoutMs);
  tabsApi.onUpdated.addListener(listener);
  tabsApi.update(tabId, { url }).then(() => {
    updateResolved = true;
    if (completedAfterRequestedTransition) finish({ status: 'complete' });
  }).catch((error) => finish({
    status: 'update_error',
    error: /** @type {{ message?: string }} */ (error)?.message ?? String(error),
  }));
});

/**
 * Reset a refused page and verify that no other navigation remains pending.
 * The caller must keep any live security pin unchanged unless this returns
 * true.
 *
 * @param {NavigationTabsApi} tabsApi
 * @param {number} tabId
 * @param {{ timeoutMs: number }} options
 * @returns {Promise<boolean>}
 */
export const resetToVerifiedBlank = async (tabsApi, tabId, options) => {
  const observation = await updateAndObserveCommittedNavigation(
    tabsApi,
    tabId,
    'about:blank',
    options,
  );
  try {
    const finalTab = await tabsApi.get(tabId);
    const pendingUrl = finalTab?.pendingUrl;
    return finalTab?.url === 'about:blank'
      && (!pendingUrl || pendingUrl === 'about:blank')
      && observation.status !== 'update_error';
  } catch {
    return false;
  }
};
