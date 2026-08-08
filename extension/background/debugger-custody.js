// @ts-check
// A pooled debugger session is authority over one checked document, not a tab.

/**
 * Build the tabs.onUpdated listener that ends debugger custody as soon as the
 * top-level tab starts replacing its document or reports a new URL.
 *
 * @param {{ isAttached: (tabId: number) => boolean, detach: (tabId: number) => Promise<unknown> }} deps
 */
export const makeDebuggerNavigationGuard = ({ isAttached, detach }) => (
  /** @type {number} */ tabId,
  /** @type {{ status?: string, url?: string }} */ changeInfo,
) => {
  if (!isAttached(tabId)) return;
  if (changeInfo.status !== 'loading' && typeof changeInfo.url !== 'string') return;
  Promise.resolve(detach(tabId)).catch(() => {});
};

/**
 * Record a successful protocol attach before enabling Runtime. If Runtime
 * setup fails, only confirmed detach clears custody; a failed cleanup remains
 * visible to later navigation and retry paths.
 *
 * @param {{
 *   enable: () => Promise<unknown>,
 *   detach: () => Promise<unknown>,
 *   markAttached: () => void,
 *   clearAttached: () => void,
 *   markQuarantined: () => void,
 *   clearQuarantined: () => void,
 * }} deps
 */
export const enableDebuggerWithCustody = async ({
  enable, detach, markAttached, clearAttached, markQuarantined, clearQuarantined,
}) => {
  markAttached();
  markQuarantined();
  try {
    await enable();
    clearQuarantined();
  } catch (error) {
    try {
      await detach();
      clearAttached();
      clearQuarantined();
    } catch {
      // Keep custody recorded. A later onDetach event or retry can clear it.
    }
    throw error;
  }
};

/**
 * Clear local custody only after the browser confirms detach.
 *
 * @param {{ detach: () => Promise<unknown>, clearCustody: () => void }} deps
 */
export const detachDebuggerWithCustody = async ({ detach, clearCustody }) => {
  await detach();
  clearCustody();
};
