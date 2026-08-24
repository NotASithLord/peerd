// @ts-check
// Browser-tab authority registration for the native kernel. This module owns
// only synchronous event ingress; injected custody collaborators retain tab,
// navigation, network, and recovery semantics without importing feature code.

import { KERNEL_LIFECYCLE_OWNER } from './kernel-lifecycle-events.js';

export const KERNEL_TAB_CUSTODY_OWNER = 'kernel-tab-custody';

/**
 * @param {Object} deps
 * @param {any} deps.browser
 * @param {{event:(key:string,raw:any,owner:string)=>any}} deps.registry
 * @param {boolean} [deps.firefox]
 * @param {(tab:any)=>unknown} deps.onCreated
 * @param {(tabId:number,changeInfo:any,tab:any)=>unknown} deps.onUpdated
 * @param {(tabId:number,removeInfo:any)=>unknown} deps.onRemoved
 * @param {(activeInfo:any)=>unknown} deps.onActivated
 * @param {(details:any)=>unknown} deps.onNavigationTarget
 * @param {(details:any)=>any} [deps.onBeforeRequest]
 */
export const attachKernelTabEvents = ({
  browser, registry, firefox = false, onCreated, onUpdated, onRemoved,
  onActivated, onNavigationTarget, onBeforeRequest,
}) => {
  const common = [onCreated, onUpdated, onRemoved, onActivated, onNavigationTarget];
  if (!browser?.tabs || !browser?.webNavigation || typeof registry?.event !== 'function'
      || common.some((handler) => typeof handler !== 'function')
      || (firefox && typeof onBeforeRequest !== 'function')) {
    throw new TypeError('kernel-tab-events-config-invalid');
  }
  registry.event('tabs.onCreated', browser.tabs.onCreated, KERNEL_TAB_CUSTODY_OWNER)
    ?.addListener(onCreated);
  registry.event('tabs.onUpdated', browser.tabs.onUpdated, KERNEL_TAB_CUSTODY_OWNER)
    ?.addListener(onUpdated);
  registry.event('tabs.onRemoved', browser.tabs.onRemoved, KERNEL_TAB_CUSTODY_OWNER)
    ?.addListener(onRemoved);
  registry.event('tabs.onActivated', browser.tabs.onActivated, KERNEL_TAB_CUSTODY_OWNER)
    ?.addListener(onActivated);
  registry.event(
    'webNavigation.onCreatedNavigationTarget',
    browser.webNavigation.onCreatedNavigationTarget,
    KERNEL_TAB_CUSTODY_OWNER,
  )?.addListener(onNavigationTarget);
  if (firefox) {
    registry.event(
      'webRequest.onBeforeRequest', browser.webRequest?.onBeforeRequest,
      KERNEL_TAB_CUSTODY_OWNER,
    )?.addListener(onBeforeRequest, { urls: ['<all_urls>'] }, ['blocking']);
  }
  return Object.freeze({ owner: KERNEL_TAB_CUSTODY_OWNER });
};

const TAB_EVENTS = Object.freeze([
  'tabs.onCreated', 'tabs.onUpdated', 'tabs.onRemoved', 'tabs.onActivated',
  'webNavigation.onCreatedNavigationTarget',
]);
const thenable = (/** @type {unknown} */ value) => value !== null
  && (typeof value === 'object' || typeof value === 'function')
  && typeof /** @type {{then?:unknown}} */ (value).then === 'function';
/** @param {()=>Promise<unknown>|unknown} operation */
const coalesced = (operation) => {
  /** @type {Promise<unknown>|null} */ let active = null;
  return () => {
    active ??= Promise.resolve().then(operation).finally(() => { active = null; });
    return active;
  };
};

/** @param {any} deps */
export const createKernelBrowserEventOwners = ({
  ready, resumeSchedules, tabCustody, firefox = false, receipts,
}) => {
  if (!thenable(ready) || typeof resumeSchedules !== 'function'
      || !tabCustody || [
        tabCustody.onCreated, tabCustody.onUpdated, tabCustody.onRemoved,
        tabCustody.onActivated, tabCustody.onNavigationTarget, tabCustody.reconcile,
      ].some((method) => typeof method !== 'function')
      || (firefox && typeof tabCustody.onBeforeRequest !== 'function')
      || typeof receipts?.registerRecovery !== 'function') {
    throw new TypeError('kernel-browser-event-owners-config-invalid');
  }
  const resumeCurrentSchedules = coalesced(async () => {
    await ready;
    return resumeSchedules();
  });
  const reconcileCurrentTabs = coalesced(async () => {
    await ready;
    return tabCustody.reconcile();
  });
  for (const event of ['runtime.onStartup', 'alarms.onAlarm']) {
    receipts.registerRecovery({
      event, owner: KERNEL_LIFECYCLE_OWNER, reconcile: resumeCurrentSchedules,
    });
  }
  for (const event of TAB_EVENTS) {
    receipts.registerRecovery({
      event, owner: KERNEL_TAB_CUSTODY_OWNER, reconcile: reconcileCurrentTabs,
    });
  }
  if (firefox) {
    receipts.registerRecovery({
      event: 'webRequest.onBeforeRequest',
      owner: KERNEL_TAB_CUSTODY_OWNER,
      reconcile: reconcileCurrentTabs,
    });
  }
  const onBeforeRequest = firefox ? (/** @type {any} */ details) => {
    try {
      const decision = tabCustody.onBeforeRequest(details);
      if (thenable(decision) || !decision || typeof decision !== 'object'
          || Array.isArray(decision)) return { cancel: true };
      const keys = Object.keys(decision);
      if (keys.length === 0) return {};
      if (keys.length === 1 && keys[0] === 'cancel' && decision.cancel === true) {
        return { cancel: true };
      }
      return { cancel: true };
    } catch { return { cancel: true }; }
  } : undefined;
  return Object.freeze({
    lifecycle: Object.freeze({
      onStartup: resumeCurrentSchedules,
      onAlarm: resumeCurrentSchedules,
    }),
    tabs: Object.freeze({
      onCreated: (/** @type {any} */ tab) => tabCustody.onCreated(tab),
      onUpdated: (/** @type {number} */ tabId, /** @type {any} */ changeInfo,
        /** @type {any} */ tab) => tabCustody.onUpdated(tabId, changeInfo, tab),
      onRemoved: (/** @type {number} */ tabId, /** @type {any} */ removeInfo) =>
        tabCustody.onRemoved(tabId, removeInfo),
      onActivated: (/** @type {any} */ activeInfo) => tabCustody.onActivated(activeInfo),
      onNavigationTarget: (/** @type {any} */ details) =>
        tabCustody.onNavigationTarget(details),
      ...(onBeforeRequest ? { onBeforeRequest } : {}),
    }),
    readiness: Object.freeze({
      'runtime.onStartup': true,
      'alarms.onAlarm': true,
      ...Object.fromEntries(TAB_EVENTS.map((event) => [event, true])),
      ...(firefox ? { 'webRequest.onBeforeRequest': true } : {}),
    }),
  });
};
