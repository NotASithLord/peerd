// @ts-check

/**
 * A side panel belongs to one browser window. Global tab events from another
 * window must not change the page-aware starter shown in this panel.
 * @param {number|null} sidepanelWindowId
 * @param {number|null} eventWindowId
 */
export const eventBelongsToSidepanelWindow = (sidepanelWindowId, eventWindowId) =>
  !Number.isInteger(sidepanelWindowId)
  || !Number.isInteger(eventWindowId)
  || sidepanelWindowId === eventWindowId;

/**
 * Activate a tab and bring its browser window forward. tabs.update alone does
 * not focus another window, which makes the action look broken to the user.
 * @param {{ tabs: { update: (tabId: number, update: { active: boolean }) => Promise<{ windowId?: number } | undefined> }, windows?: { update?: (windowId: number, update: { focused: boolean }) => Promise<unknown> } }} browserApi
 * @param {number} tabId
 * @param {number|undefined} hintedWindowId
 */
export const focusBrowserTab = async (browserApi, tabId, hintedWindowId) => {
  try {
    const tab = await browserApi.tabs.update(tabId, { active: true });
    const currentWindowId = typeof tab?.windowId === 'number' && Number.isInteger(tab.windowId)
      ? tab.windowId : undefined;
    const windowId = currentWindowId ?? hintedWindowId;
    if (typeof windowId === 'number' && Number.isInteger(windowId) && browserApi.windows?.update) {
      await browserApi.windows.update(windowId, { focused: true });
    }
    return true;
  } catch {
    return false;
  }
};
