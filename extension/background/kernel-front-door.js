// @ts-check
// Minimal synchronous toolbar/shortcut authority for the thin kernel. The
// browser drops sidePanel.open()/sidebarAction.open() when a user gesture is
// separated from its listener by an await, so this module deliberately reads
// only warm, injected scalars and performs the open in the same stack frame.

/**
 * @param {{homeOpen:boolean,panelOpen?:boolean,hasSidePanel:boolean,hasSidebar:boolean,
 * fromShortcut?:boolean,frontDoorView?:'panel'|'home',nativePanelMirror?:boolean,homeWorkspace?:boolean}} input
 */
export const decidePullIn = ({
  homeOpen,
  panelOpen = false,
  hasSidePanel,
  hasSidebar,
  fromShortcut = false,
  frontDoorView = 'panel',
  nativePanelMirror = false,
  homeWorkspace = false,
}) => {
  if (homeWorkspace) return 'home';
  if (fromShortcut && panelOpen && (hasSidePanel || hasSidebar)) return 'close';
  const view = !fromShortcut && nativePanelMirror ? 'home' : frontDoorView;
  if (fromShortcut || homeOpen || view !== 'home') {
    if (hasSidePanel) return 'panel';
    if (hasSidebar) return 'sidebar';
  }
  return 'home';
};

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
 * @param {(windowId?:number|null)=>unknown} deps.closePanel
 * @param {(windowId?:number|null)=>unknown} deps.openHome
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

  // This seed is an open-only backstop. Closing requires the browser event's
  // window ID, so another window keeps its chat.
  observe(refreshFocus(), onError);

  coldEvent('windows.onFocusChanged', browser.windows?.onFocusChanged)
    ?.addListener((/** @type {number} */ windowId) => {
      const none = windowId == null || windowId === browser.windows?.WINDOW_ID_NONE;
      browserFocused = !none;
      if (!none) lastFocusedWindowId = windowId;
    });

  const homeWorkspace = typeof browser.sidePanel?.onOpened?.addListener === 'function'
    && typeof browser.sidePanel?.onClosed?.addListener === 'function';
  const fallbackHome = (/** @type {number|null|undefined} */ windowId) => observe(openHome(windowId), onError);
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
      homeWorkspace,
    });
    if (target === 'close') {
      observe(closePanel(windowId), onError);
      return 'close';
    }
    try {
      const panelWindowId = windowId ?? lastFocusedWindowId;
      if (target === 'panel' && typeof panelWindowId === 'number') {
        observe(browser.sidePanel.open({ windowId: panelWindowId }), () => fallbackHome(panelWindowId));
        return 'panel';
      }
      if (target === 'sidebar') {
        observe(browser.sidebarAction.open(), () => fallbackHome(windowId));
        return 'sidebar';
      }
    } catch (cause) {
      onError(cause);
    }
    fallbackHome(windowId ?? lastFocusedWindowId);
    return 'home';
  };

  coldEvent('action.onClicked', browser.action?.onClicked)
    ?.addListener((/** @type {any} */ tab) => {
      pullIn(tab?.windowId, false);
    });
  coldEvent('commands.onCommand', browser.commands?.onCommand)
    ?.addListener((/** @type {string} */ command, /** @type {any} */ tab) => {
      if (command !== 'pull-in-peerd') return;
      pullIn(tab?.windowId, true);
    });

  const syncNativeBehavior = async () => {
    if (typeof browser.sidePanel?.setPanelBehavior !== 'function') return false;
    await browser.sidePanel.setPanelBehavior({
      openPanelOnActionClick: !homeWorkspace && getFrontDoorView() === 'panel',
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
  const openWindowHome = async (/** @type {number|null|undefined} */ windowId) => {
    const surface = typeof windowId === 'number' ? await deps.windowSurfaces?.inWindow(windowId) : null;
    return deps.openHome('chat', {
      ...(typeof windowId === 'number' ? { windowId } : {}),
      tabId: surface?.homeTabId, pinned: deps.settingsStore.get().firstTabEnabled === true,
    });
  };
  const closePanel = async (
    /** @type {unknown} */ target = undefined,
    /** @type {{ tab?: { windowId?: number } }} */ sender = {},
  ) => {
    try {
      if (deps.browser.sidebarAction?.close) {
        await deps.browser.sidebarAction.close();
        return { ok: true };
      }
      const sidePanel = deps.browser.sidePanel;
      if (typeof sidePanel?.close !== 'function') {
        return { ok: false, error: 'sidepanel-close-unavailable' };
      }
      const windowId = typeof target === 'number' ? target : sender.tab?.windowId;
      if (typeof windowId !== 'number' || !Number.isInteger(windowId) || windowId < 0) {
        return { ok: false, error: 'no-sidepanel-window' };
      }
      await sidePanel.close({ windowId });
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
    openHome: openWindowHome,
  });
  deps.events.registerRecovery({
    event: 'windows.onFocusChanged',
    owner: 'kernel-front-door',
    reconcile: () => frontDoor.refreshFocus(),
  });
  void frontDoor.syncNativeBehavior().catch(() => {});
  void deps.ready.then(() => frontDoor.syncNativeBehavior()).catch(() => {});
  return Object.freeze({ closePanel, frontDoor, openWindowHome });
};
