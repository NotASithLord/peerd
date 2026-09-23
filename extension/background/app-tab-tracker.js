// @ts-check
// Track the App instance and owner for each user-visible App tab.
// Opening a live App reuses its tab. New user-opened Apps take focus.

import { createTabTracker } from './tab-tracker.js';
import { APP_TAB_PATH } from '/peerd-engine/background.js';
import { createAppDwebAuthority } from './app-dweb-authority.js';
export { AppDwebAuthorityChangedError } from './app-dweb-authority.js';
import browser from '/shared/browser-api.js';

const READY_TIMEOUT_MS = 15_000;
const QUIESCE_TIMEOUT_MS = 5_000;

/** @param {{ announce?: import('./tab-tracker.js').TabTrackerConfig['announce'],
 *   onAdopt?: import('./tab-tracker.js').TabTrackerConfig['onAdopt'],
 *   onDrop?: import('./tab-tracker.js').TabTrackerConfig['onDrop'],
 *   tabs?: typeof browser.tabs,
 *   sendTabMessage?: (tabId:number, message:any)=>Promise<any>,
 *   purgeDwebOwners?: (appId:string,generation:number)=>Promise<void>,
 *   storage?: typeof browser.storage.session,
 *   dwebAuthority?: ReturnType<typeof createAppDwebAuthority> }} [deps] */
export const createAppTabTracker = ({
  announce, onAdopt, onDrop,
  tabs = browser.tabs,
  sendTabMessage = tabs.sendMessage.bind(tabs),
  purgeDwebOwners = async () => {},
  storage = browser.storage.session,
  dwebAuthority: suppliedDwebAuthority,
} = {}) => {
  const tracker = createTabTracker({
    tabPath: APP_TAB_PATH,
    readyTimeoutMs: READY_TIMEOUT_MS,
    closedError: () => new Error('app tab closed before ready'),
    notReadyMessage: (id) => `app ${id} did not become ready`,
    announce,
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
  /** @type {Map<number,{epoch:number,pending?:Promise<any>,result?:any}>} */ const attachByTab = new Map();
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
    try { onAdopt?.(appId, tabId); } catch { /* liveness is best-effort */ }
  };

  /** why: A worker restart must revalidate each App tab before adoption. */
  const bootstrap = async () => {
    await dwebAuthority.ready();
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
    const liveTabId = tracker.getTabId(appId);
    if (liveTabId != null && liveTabId !== tabId) return false;
    const priorAppId = appByTab.get(tabId);
    if (priorAppId && priorAppId !== appId) {
      tracker.onTabRemoved(tabId);
      ownerClaimByApp.delete(priorAppId); ownerRootByApp.delete(priorAppId);
    }
    tracker.onTabPending(appId, tabId);
    rememberOwner(appId, tabId, ownerClaim, ownerRoot);
    return true;
  };

  /** @param {string} appId @param {number} tabId @param {string|null} [ownerClaim] @param {string|null} [ownerRoot] */
  const onTabReady = (appId, tabId, ownerClaim = null, ownerRoot = null) => {
    if (tracker.getTabId(appId) !== tabId) return false;
    tracker.onTabReady(appId, tabId);
    dwebAuthority.activateTab(appId, tabId);
    rememberOwner(appId, tabId, ownerClaim, ownerRoot);
    return true;
  };

  /** @param {string} appId @param {Error} error @param {number} [tabId] */
  const onTabFailed = (appId, error, tabId) => {
    if (tabId != null && tracker.getTabId(appId) !== tabId) return null;
    const failedTabId = tracker.onTabFailed(appId, error);
    if (failedTabId != null) {
      appByTab.set(failedTabId, appId); try { onAdopt?.(appId, failedTabId); } catch { /* retain liveness until physical removal */ }
    }
    ownerClaimByApp.delete(appId); ownerRootByApp.delete(appId);
    return failedTabId;
  };

  /** @param {number} tabId */
  const onTabRemoved = (tabId) => {
    attachByTab.delete(tabId);
    const appId = appByTab.get(tabId) ?? null;
    const removed = tracker.onTabRemoved(tabId);
    appByTab.delete(tabId);
    if (appId) {
      ownerClaimByApp.delete(appId); ownerRootByApp.delete(appId);
      if (!removed) try { onDrop?.(appId); } catch { /* liveness is best-effort */ }
    }
    return removed ?? appId;
  };

  /** Clear a stale rich claim only after a complete browser tab snapshot proves it left. */
  /** @param {string} appId @param {number} claimantTabId */
  const reconcileTabClaim = async (appId, claimantTabId) => {
    const liveTabId = tracker.getTabId(appId);
    if (liveTabId == null || liveTabId === claimantTabId) return liveTabId;
    let liveTabs;
    try { liveTabs = await tabs.query({}); }
    catch { return liveTabId; }
    const live = liveTabs.find((tab) => tab?.id === liveTabId);
    if (live && tracker.parseIdFromUrl(live.url ?? '') === appId) return liveTabId;
    onTabRemoved(liveTabId);
    return null;
  };

  /** Share one actor attach per tab document. @param {number} tabId @param {(epoch:number)=>Promise<any>} operation */
  const coordinateAttach = (tabId, operation) => {
    const state = attachByTab.get(tabId) ?? { epoch: 0 };
    attachByTab.set(tabId, state); if (state.pending) return state.pending;
    if (state.result?.ok === true) return Promise.resolve(state.result);
    const epoch = state.epoch;
    const pending = Promise.resolve().then(() => operation(epoch)).then((result) => {
      if (attachByTab.get(tabId) === state && result?.ok === true) state.result = result;
      return result;
    }).finally(() => { if (attachByTab.get(tabId) === state) delete state.pending; });
    state.pending = pending; return pending;
  };
  const markAttachLoading = (/** @type {number} */ tabId) => {
    const current = attachByTab.get(tabId);
    if (!current) return null;
    const epoch = current.epoch + 1; attachByTab.set(tabId, { epoch }); return epoch;
  };
  const isAttachCurrent = (/** @type {number} */ tabId, /** @type {number} */ epoch) => attachByTab.get(tabId)?.epoch === epoch;
  /** @param {string} appId @param {string} ownerRoot */
  const getOwnedTabId = (appId, ownerRoot) => ownerRootByApp.get(appId) === ownerRoot
    ? tracker.getTabId(appId) : null;
  /** Preserve the exact chat-root claim when lifecycle work closes/reopens a tab. */
  const getOwnerClaim = (/** @type {string} */ appId) => ownerClaimByApp.get(appId) ?? null;

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
    const tabId = await tracker.ensureTab(appId, opts);
    if (desiredOwner) {
      const actual = ownerClaimByApp.get(appId) ?? parseOwnerFromUrl((await tabs.get(tabId))?.url);
      if (actual && actual !== desiredOwner) throw new Error('app-owned-by-another-chat');
    }
    return tabId;
  };

  /** Find every exact App page, including tabs not adopted after a worker restart. @param {string} appId */
  const exactTabIds = async (appId) => {
    const tabIds = new Set((await tabs.query({ url: `${tabUrlPrefix}*` }))
      .filter((tab) => tab.id != null && tracker.parseIdFromUrl(tab.url ?? '') === appId)
      .map((tab) => /** @type {number} */ (tab.id)));
    // why: a stale numeric tab id must never authorize closing a different page.
    const tracked = tracker.getTabId(appId);
    if (tracked != null && !tabIds.has(tracked)) onTabRemoved(tracked);
    return [...tabIds];
  };

  /** Flush and freeze every exact live App editor before repository work. */
  const quiesceTab = async (/** @type {string} */ appId) => {
    const tabIds = await exactTabIds(appId);
    await Promise.all(tabIds.map(async (tabId) => {
      /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
      try {
        const response = /** @type {any} */ (await Promise.race([
          sendTabMessage(tabId, { type: 'app/quiesce', action: 'acquire', appId }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`app ${appId} editor flush timed out`)), QUIESCE_TIMEOUT_MS); }),
        ]));
        if (!response?.ok) throw new Error(response?.error ?? `app ${appId} editor flush failed`);
      } finally { clearTimeout(timer); }
    }));
    return tabIds.length > 0;
  };

  const disposeDwebTab = async (/** @type {string} */ appId, /** @type {number} */ tabId) => {
    const response = /** @type {any} */ (await sendTabMessage(tabId, { type: 'app/quiesce', action: 'invalidate-dweb', appId }));
    if (!response?.ok) throw new Error(response?.error ?? `app ${appId} dweb bridge did not stop`);
    return true;
  };
  const dwebAuthority = suppliedDwebAuthority ?? createAppDwebAuthority({
    storage, tabIds: exactTabIds, stopTab: disposeDwebTab,
    closeTab: (tabId) => tabs.remove(tabId), purgeOwners: purgeDwebOwners,
  });
  const getDwebGeneration = dwebAuthority.generation;
  const dwebGenerationsReady = dwebAuthority.ready;
  const dwebGenerationSnapshot = dwebAuthority.snapshot;
  const withDwebAuthority = dwebAuthority.run;
  const invalidateDweb = dwebAuthority.invalidate;
  const retireDwebTab = dwebAuthority.retire;

  /** Re-enable a quiesced tab if closing it failed. */
  const resumeTab = async (/** @type {string} */ appId) => {
    const tabIds = await exactTabIds(appId);
    const replies = await Promise.all(tabIds.map((tabId) => sendTabMessage(tabId, { type: 'app/quiesce', action: 'release', appId })));
    return replies.length > 0 && replies.every((response) => response?.ok === true);
  };

  const closeTab = async (/** @type {string} */ appId) => {
    const tabIds = await exactTabIds(appId); const closed = await Promise.allSettled(tabIds.map((tabId) => tabs.remove(tabId)));
    return closed.length > 0 && closed.every((result) => result.status === 'fulfilled');
  };
  const reloadTab = async (/** @type {string} */ appId) => {
    tracker.markReloading(appId); return await tracker.reloadTab(appId) && !!await tracker.ensureTab(appId);
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
    reconcileTabClaim,
    getAppIdByTab: (/** @type {number} */ tabId) => appByTab.get(tabId) ?? null,
    getOwnedTabId,
    getOwnerClaim,
    ensureTab,
    closeTab,
    quiesceTab,
    invalidateDweb,
    disposeDwebTab,
    dwebGenerationsReady,
    dwebGenerationSnapshot,
    getDwebGeneration,
    withDwebAuthority,
    retireDwebTab,
    coordinateAttach,
    markAttachLoading,
    isAttachCurrent,
    resumeTab,
    reloadTab,
    markReloading: tracker.markReloading,
    listLive: tracker.listLive,
  };
};
