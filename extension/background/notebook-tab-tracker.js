// @ts-check
// notebook-tab-tracker — which notebookId lives in which tab. Thin config
// over the shared createTabTracker.
//
// Mirrors vm-tab-tracker but for chrome-extension://<id>/
// notebook-tab/index.html#<notebookId>. The Notebook tab boots a Web Worker
// inline (no CheerpX), so "ready" fires within a few ms of tab load —
// no streaming disk image like VMs, hence the tighter 15s timeout. The
// closed-tab rejection is a plain Error (no per-instance interrupt lane
// like VMs have).

import { createTabTracker } from './tab-tracker.js';
import { NOTEBOOK_TAB_PATH } from '/peerd-engine/background.js';
import browser from '/shared/browser-api.js';

const READY_TIMEOUT_MS = 15_000;       // Notebooks boot fast; tighter than VMs
const QUIESCE_TIMEOUT_MS = 5_000;

/** @param {{ announce?: import('./tab-tracker.js').TabTrackerConfig['announce'],
 *   onAdopt?: import('./tab-tracker.js').TabTrackerConfig['onAdopt'],
 *   onDrop?: import('./tab-tracker.js').TabTrackerConfig['onDrop'],
 *   sendTabMessage?: (tabId:number, message:any)=>Promise<any> }} [deps] */
export const createJsTabTracker = ({
  announce, onAdopt, onDrop,
  sendTabMessage = browser.tabs.sendMessage.bind(browser.tabs),
} = {}) => {
  const tracker = createTabTracker({
    tabPath: NOTEBOOK_TAB_PATH,
    readyTimeoutMs: READY_TIMEOUT_MS,
    closedError: () => new Error('Notebook tab closed before ready'),
    notReadyMessage: (id) => `Notebook ${id} did not become ready in ${READY_TIMEOUT_MS}ms`,
    announce,
    onAdopt,
    onDrop,
    kindLabel: 'a Notebook',
  });

  /** Flush and freeze a live Notebook editor before repository work. */
  const quiesceTab = async (/** @type {string} */ notebookId) => {
    const tabId = tracker.getTabId(notebookId);
    if (tabId == null) return false;
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
    try {
      const response = /** @type {any} */ (await Promise.race([
        sendTabMessage(tabId, { type: 'js/quiesce', action: 'acquire', notebookId }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Notebook ${notebookId} editor flush timed out`)), QUIESCE_TIMEOUT_MS);
        }),
      ]));
      if (!response?.ok) throw new Error(response?.error ?? `Notebook ${notebookId} editor flush failed`);
      return true;
    } finally { clearTimeout(timer); }
  };

  /** Re-enable a Notebook after non-tree-replacing repository work. */
  const resumeTab = async (/** @type {string} */ notebookId) => {
    const tabId = tracker.getTabId(notebookId);
    if (tabId == null) return false;
    const response = /** @type {any} */ (await sendTabMessage(tabId, {
      type: 'js/quiesce', action: 'release', notebookId,
    }));
    return response?.ok === true;
  };

  return {
    bootstrap: tracker.bootstrap,
    onTabReady: tracker.onTabReady,
    onTabRemoved: tracker.onTabRemoved,
    parseIdFromUrl: tracker.parseIdFromUrl,
    getTabId: tracker.getTabId,
    isReady: tracker.isReady,
    ensureTab: tracker.ensureTab,
    closeTab: tracker.closeTab,
    reloadTab: tracker.reloadTab,
    quiesceTab,
    resumeTab,
    listLive: tracker.listLive,
  };
};
