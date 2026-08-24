// @ts-check
// Browser-tab authority registration for the native kernel. This module owns
// only synchronous event ingress; injected custody collaborators retain tab,
// navigation, network, and recovery semantics without importing feature code.

const OWNER = 'kernel-tab-custody';

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
  registry.event('tabs.onCreated', browser.tabs.onCreated, OWNER)?.addListener(onCreated);
  registry.event('tabs.onUpdated', browser.tabs.onUpdated, OWNER)?.addListener(onUpdated);
  registry.event('tabs.onRemoved', browser.tabs.onRemoved, OWNER)?.addListener(onRemoved);
  registry.event('tabs.onActivated', browser.tabs.onActivated, OWNER)?.addListener(onActivated);
  registry.event(
    'webNavigation.onCreatedNavigationTarget',
    browser.webNavigation.onCreatedNavigationTarget,
    OWNER,
  )?.addListener(onNavigationTarget);
  if (firefox) {
    registry.event(
      'webRequest.onBeforeRequest', browser.webRequest?.onBeforeRequest, OWNER,
    )?.addListener(onBeforeRequest, { urls: ['<all_urls>'] }, ['blocking']);
  }
  return Object.freeze({ owner: OWNER });
};
