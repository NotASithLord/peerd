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
import { APP_TAB_PATH } from '/peerd-engine/background.js';
import browser from '/vendor/browser-polyfill.js';

const READY_TIMEOUT_MS = 15_000;
const QUIESCE_TIMEOUT_MS = 5_000;

/** @param {{ announce?: import('./tab-tracker.js').TabTrackerConfig['announce'],
 *   onAdopt?: import('./tab-tracker.js').TabTrackerConfig['onAdopt'],
 *   onDrop?: import('./tab-tracker.js').TabTrackerConfig['onDrop'],
 *   tabs?: typeof browser.tabs,
 *   sendTabMessage?: (tabId:number, message:any)=>Promise<any> }} [deps] */
export const createAppTabTracker = ({
  announce, onAdopt, onDrop,
  tabs = browser.tabs,
  sendTabMessage = tabs.sendMessage.bind(tabs),
} = {}) => {
  const tracker = createTabTracker({
    tabPath: APP_TAB_PATH,
    readyTimeoutMs: READY_TIMEOUT_MS,
    closedError: () => new Error('app tab closed before ready'),
    notReadyMessage: (id) => `app ${id} did not become ready`,
    announce,
    onAdopt,
    onDrop,
    tabs,
    kindLabel: 'an App',
    announceOnReady: true,
  });

  /** @type {Map<string,string>} URL claim, before root resolution. */
  const ownerClaimByApp = new Map();
  /** @type {Map<string,string>} durable root authority after validation. */
  const ownerRootByApp = new Map();
  /** @type {Map<number,string>} */
  const appByTab = new Map();
  const tabUrlPrefix = browser.runtime.getURL(APP_TAB_PATH);

  /** @param {string|undefined} url */
  const parseOwnerFromUrl = (url) => {
    if (typeof url !== 'string' || !url.startsWith(tabUrlPrefix)) return null;
    const query = url.split('#', 2)[1]?.split('?', 2)[1] ?? '';
    try {
      const owner = new URLSearchParams(query).get('owner');
      return owner && owner.length <= 256 ? owner : null;
    } catch { return null; }
  };

  /** @param {string} appId @param {number} tabId @param {string|null|undefined} ownerClaim @param {string|null|undefined} ownerRoot */
  const rememberOwner = (appId, tabId, ownerClaim, ownerRoot) => {
    appByTab.set(tabId, appId);
    if (ownerClaim) ownerClaimByApp.set(appId, ownerClaim);
    if (ownerRoot) ownerRootByApp.set(appId, ownerRoot);
  };

  /**
   * Existing App tabs are only candidates at worker boot. They are not runnable
   * until the service worker revalidates URL/app/owner identity and reconciles
   * the manifest actor. This deliberately differs from generic engine tabs.
   */
  const bootstrap = async () => {
    const liveTabs = await tabs.query({ url: `${tabUrlPrefix}*` });
    return liveTabs
      .filter((tab) => tab.id != null && tracker.parseIdFromUrl(tab.url ?? ''))
      .sort((a, b) => /** @type {number} */ (a.id) - /** @type {number} */ (b.id))
      .map((tab) => ({
        appId: /** @type {string} */ (tracker.parseIdFromUrl(tab.url ?? '')),
        tabId: /** @type {number} */ (tab.id),
        ownerSessionId: parseOwnerFromUrl(tab.url),
        url: tab.url ?? '',
      }));
  };

  /** @param {string} appId @param {number} tabId @param {string|null} [ownerClaim] @param {string|null} [ownerRoot] */
  const onTabPending = (appId, tabId, ownerClaim = null, ownerRoot = null) => {
    tracker.onTabPending(appId, tabId);
    rememberOwner(appId, tabId, ownerClaim, ownerRoot);
  };

  /** @param {string} appId @param {number} tabId @param {string|null} [ownerClaim] @param {string|null} [ownerRoot] */
  const onTabReady = (appId, tabId, ownerClaim = null, ownerRoot = null) => {
    tracker.onTabReady(appId, tabId);
    rememberOwner(appId, tabId, ownerClaim, ownerRoot);
  };

  /** @param {string} appId @param {Error} error */
  const onTabFailed = (appId, error) => {
    const tabId = tracker.onTabFailed(appId, error);
    if (tabId != null) appByTab.delete(tabId);
    ownerClaimByApp.delete(appId);
    ownerRootByApp.delete(appId);
    return tabId;
  };

  /** @param {number} tabId */
  const onTabRemoved = (tabId) => {
    const appId = appByTab.get(tabId) ?? null;
    const removed = tracker.onTabRemoved(tabId);
    appByTab.delete(tabId);
    if (appId && removed === appId) {
      ownerClaimByApp.delete(appId);
      ownerRootByApp.delete(appId);
    }
    return removed;
  };

  /** @param {string} appId @param {string} ownerRoot */
  const getOwnedTabId = (appId, ownerRoot) => ownerRootByApp.get(appId) === ownerRoot
    ? tracker.getTabId(appId)
    : null;

  /** Refuse ambient appId-only reuse across chat roots. */
  const ensureTab = async (/** @type {string} */ appId, /** @type {{active?:boolean,groupTitle?:string,hashSuffix?:string,ownerSessionId?:string}} */ opts = {}) => {
    const desiredOwner = typeof opts.ownerSessionId === 'string' && opts.ownerSessionId
      ? opts.ownerSessionId
      : parseOwnerFromUrl(`${tabUrlPrefix}#${appId}${opts.hashSuffix ?? ''}`);
    const existingTabId = tracker.getTabId(appId);
    if (existingTabId != null && desiredOwner) {
      const recorded = ownerClaimByApp.get(appId);
      let actual = recorded ?? null;
      try { actual ??= parseOwnerFromUrl((await tabs.get(existingTabId))?.url); } catch { /* generic tracker will replace stale tab */ }
      if (actual && actual !== desiredOwner) throw new Error('app-owned-by-another-chat');
    }
    return tracker.ensureTab(appId, opts);
  };

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
    bootstrap,
    onTabReady,
    onTabPending,
    onTabFailed,
    onTabRemoved,
    parseIdFromUrl: tracker.parseIdFromUrl,
    parseOwnerFromUrl,
    getTabId: tracker.getTabId,
    getOwnedTabId,
    ensureTab,
    closeTab: tracker.closeTab,
    quiesceTab,
    resumeTab,
    reloadTab: tracker.reloadTab,
    markReloading: tracker.markReloading,
    listLive: tracker.listLive,
  };
};
