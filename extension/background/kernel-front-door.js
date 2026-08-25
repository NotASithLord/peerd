// @ts-check
// Minimal synchronous toolbar/shortcut authority for the thin kernel. The
// browser drops sidePanel.open()/sidebarAction.open() when a user gesture is
// separated from its listener by an await, so this module deliberately reads
// only warm, injected scalars and performs the open in the same stack frame.

import { decidePullIn } from './panel-affordance.js';

/** @param {unknown} value @param {(cause:unknown)=>void} onError */
const observe = (value, onError) => {
  if (value && typeof /** @type {any} */ (value).catch === 'function') {
    /** @type {Promise<any>} */ (value).catch(onError);
  }
};

/**
 * @param {Object} deps
 * @param {any} deps.browser
 * @param {(key:string,event:any)=>any} deps.coldEvent
 * @param {()=>boolean} deps.isHomeOpen
 * @param {()=>boolean} deps.isPanelOpen
 * @param {()=>('panel'|'home')} deps.getFrontDoorView
 * @param {()=>unknown} deps.closePanel
 * @param {()=>unknown} deps.openHome
 * @param {(cause:unknown)=>void} [deps.onError]
 */
export const createKernelFrontDoor = ({
  browser,
  coldEvent,
  isHomeOpen,
  isPanelOpen,
  getFrontDoorView,
  closePanel,
  openHome,
  onError = () => {},
}) => {
  if (!browser?.runtime || typeof coldEvent !== 'function'
      || typeof isHomeOpen !== 'function' || typeof isPanelOpen !== 'function'
      || typeof getFrontDoorView !== 'function' || typeof closePanel !== 'function'
      || typeof openHome !== 'function') {
    throw new TypeError('kernel-front-door-config-invalid');
  }
  /** @type {number|null} */
  let lastFocusedWindowId = null;
  let browserFocused = false;

  const refreshFocus = async () => {
    const window = await browser.windows?.getLastFocused?.();
    if (typeof window?.id === 'number') lastFocusedWindowId = window.id;
    browserFocused = window?.focused === true;
    return Object.freeze({ lastFocusedWindowId, browserFocused });
  };

  // This seed is diagnostic/backstop only. The gesture listeners use the tab's
  // window id synchronously whenever the browser supplies it.
  observe(refreshFocus(), onError);

  coldEvent('windows.onFocusChanged', browser.windows?.onFocusChanged)
    ?.addListener((/** @type {number} */ windowId) => {
      const none = windowId == null || windowId === browser.windows?.WINDOW_ID_NONE;
      browserFocused = !none;
      if (!none) lastFocusedWindowId = windowId;
    });

  const fallbackHome = () => observe(openHome(), onError);
  const pullIn = (/** @type {number|null|undefined} */ windowId,
    /** @type {boolean} */ fromShortcut) => {
    const target = decidePullIn({
      homeOpen: isHomeOpen(),
      panelOpen: isPanelOpen(),
      hasSidePanel: typeof browser.sidePanel?.open === 'function',
      hasSidebar: typeof browser.sidebarAction?.open === 'function',
      fromShortcut,
      frontDoorView: getFrontDoorView(),
      nativePanelMirror: typeof browser.sidePanel?.setPanelBehavior === 'function',
    });
    if (target === 'close') {
      observe(closePanel(), onError);
      return 'close';
    }
    try {
      if (target === 'panel' && typeof windowId === 'number') {
        observe(browser.sidePanel.open({ windowId }), () => fallbackHome());
        return 'panel';
      }
      if (target === 'sidebar') {
        observe(browser.sidebarAction.open(), () => fallbackHome());
        return 'sidebar';
      }
    } catch (cause) {
      onError(cause);
    }
    fallbackHome();
    return 'home';
  };

  coldEvent('action.onClicked', browser.action?.onClicked)
    ?.addListener((/** @type {any} */ tab) => {
      pullIn(tab?.windowId ?? lastFocusedWindowId, false);
    });
  coldEvent('commands.onCommand', browser.commands?.onCommand)
    ?.addListener((/** @type {string} */ command, /** @type {any} */ tab) => {
      if (command !== 'pull-in-peerd') return;
      pullIn(tab?.windowId ?? lastFocusedWindowId, true);
    });

  const syncNativeBehavior = async () => {
    if (typeof browser.sidePanel?.setPanelBehavior !== 'function') return false;
    await browser.sidePanel.setPanelBehavior({
      openPanelOnActionClick: getFrontDoorView() === 'panel',
    });
    return true;
  };

  return Object.freeze({
    pullIn,
    refreshFocus,
    syncNativeBehavior,
    snapshot: () => Object.freeze({ lastFocusedWindowId, browserFocused }),
  });
};

/** @param {Record<string,any>} deps */
export const attachKernelFrontDoor = (deps) => {
  const closePanel = async () => {
    try {
      if (deps.browser.sidebarAction?.close) {
        await deps.browser.sidebarAction.close();
        return { ok: true };
      }
      const sidePanel = deps.browser.sidePanel;
      if (!sidePanel?.setOptions) return { ok: false, error: 'no-sidepanel' };
      await sidePanel.setOptions({ enabled: false });
      setTimeout(() => {
        sidePanel.setOptions({ enabled: true, path: 'sidepanel/sidepanel.html' }).catch(() => {});
      }, 250);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: /** @type {{message?:string}} */ (error)?.message ?? String(error),
      };
    }
  };
  const frontDoor = createKernelFrontDoor({
    browser: deps.browser,
    coldEvent: (key, event) => deps.events.event(key, event, 'kernel-front-door'),
    isHomeOpen: () => deps.uiPorts.hasNamed('home'),
    isPanelOpen: () => deps.uiPorts.hasNamed('sidepanel'),
    getFrontDoorView: () => deps.settingsStore.get().frontDoorView === 'home' ? 'home' : 'panel',
    closePanel,
    openHome: deps.openHome,
  });
  deps.events.registerRecovery({
    event: 'windows.onFocusChanged',
    owner: 'kernel-front-door',
    reconcile: () => frontDoor.refreshFocus(),
  });
  void deps.ready.then(() => frontDoor.syncNativeBehavior()).catch(() => {});
  return Object.freeze({ closePanel, frontDoor });
};
