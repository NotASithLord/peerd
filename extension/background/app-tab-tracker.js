// @ts-check
// app-tab-tracker — which appId lives in which tab. Thin config over the
// shared createTabTracker.
//
// Mirror of vm-/js-tab-tracker for app-tab/index.html#<appId>. Apps are
// user-facing artifacts (the agent wrote a small UI for the user), so
// this kind also exposes reloadTab — the app body can be edited and the
// iframe re-rendered (app-client.reloadTab). It has no isReady consumer.
// Opening an app brings its tab to the foreground so the user sees it
// (DECISIONS #20, 2026-06-14); ensureTab early-returns for a live tab,
// so re-opening an existing app doesn't yank the user back.

import { createTabTracker } from './tab-tracker.js';
import { APP_TAB_PATH } from '/peerd-engine/index.js';
import browser from '/vendor/browser-polyfill.js';

const READY_TIMEOUT_MS = 15_000;
const QUIESCE_TIMEOUT_MS = 5_000;

/** @param {{ announce?: import('./tab-tracker.js').TabTrackerConfig['announce'],
 *   onAdopt?: import('./tab-tracker.js').TabTrackerConfig['onAdopt'],
 *   onDrop?: import('./tab-tracker.js').TabTrackerConfig['onDrop'],
 *   sendTabMessage?: (tabId:number, message:any)=>Promise<any> }} [deps] */
export const createAppTabTracker = ({
  announce, onAdopt, onDrop,
  sendTabMessage = browser.tabs.sendMessage.bind(browser.tabs),
} = {}) => {
  const tracker = createTabTracker({
    tabPath: APP_TAB_PATH,
    readyTimeoutMs: READY_TIMEOUT_MS,
    closedError: () => new Error('app tab closed before ready'),
    notReadyMessage: (id) => `app ${id} did not become ready`,
    announce,
    onAdopt,
    onDrop,
    kindLabel: 'an App',
    announceOnReady: true,
  });

  /** Flush and freeze a live App editor before its repository is locked. */
  const quiesceTab = async (/** @type {string} */ appId) => {
    const tabId = tracker.getTabId(appId);
    if (tabId == null) return false;
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
    try {
      const response = /** @type {any} */ (await Promise.race([
        sendTabMessage(tabId, { type: 'app/quiesce', action: 'acquire', appId }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`app ${appId} editor flush timed out`)), QUIESCE_TIMEOUT_MS);
        }),
      ]));
      if (!response?.ok) throw new Error(response?.error ?? `app ${appId} editor flush failed`);
      return true;
    } finally { clearTimeout(timer); }
  };

  /** Re-enable a quiesced tab if closing it failed. */
  const resumeTab = async (/** @type {string} */ appId) => {
    const tabId = tracker.getTabId(appId);
    if (tabId == null) return false;
    const response = /** @type {any} */ (await sendTabMessage(tabId, {
      type: 'app/quiesce', action: 'release', appId,
    }));
    return response?.ok === true;
  };

  return {
    bootstrap: tracker.bootstrap,
    onTabReady: tracker.onTabReady,
    onTabPending: tracker.onTabPending,
    onTabFailed: tracker.onTabFailed,
    onTabRemoved: tracker.onTabRemoved,
    parseIdFromUrl: tracker.parseIdFromUrl,
    getTabId: tracker.getTabId,
    ensureTab: tracker.ensureTab,
    closeTab: tracker.closeTab,
    quiesceTab,
    resumeTab,
    reloadTab: tracker.reloadTab,
    listLive: tracker.listLive,
  };
};
