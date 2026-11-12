// @ts-check
import { makeSerialLane } from '../shared/cold-util.js';
/** @typedef {{ name?: string, postMessage: (msg: unknown) => void }} UiPort */
/** @param {{onBroadcast?:(message:unknown)=>void}} [options] */
export const makeUiPorts = ({ onBroadcast = () => {} } = {}) => {
  /** @type {Set<UiPort>} */
  const ports = new Set();

  return {
    /** @param {UiPort} port */
    add: (port) => { ports.add(port); },
    /** @param {UiPort} port */
    remove: (port) => ports.delete(port),
    get size() { return ports.size; },
    /** @param {string} name */
    hasNamed: (name) => {
      for (const port of ports) if (port.name === name) return true;
      return false;
    },
    /** @param {unknown} msg */
    broadcast: (msg) => {
      try { onBroadcast(msg); } catch {}
      for (const port of ports) {
        try { port.postMessage(msg); }
        catch { /* port closing — its onDisconnect handler removes it */ }
      }
    },
  };
};

/** @param {Record<string, any>} deps */
export const makeWindowSurfaces = ({ browser, session, homeUrl, isPanelSender, publish }) => {
  const key = 'workspace.windows.v1';
  /** @type {Map<number, {windowId:number,chatOwner:'home'|'panel'|null,homeTabId:number|null,sidePanelOpen:boolean,panelDocumentId:string|null}>} */
  const windows = new Map();
  const lane = makeSerialLane();
  const validId = (/** @type {unknown} */ id) => Number.isInteger(id) && Number(id) >= 0;
  const isHome = (/** @type {any} */ tab) => validId(tab?.id)
    && typeof tab?.url === 'string' && tab.url.split(/[?#]/, 1)[0] === homeUrl;
  /** @type {Promise<void>|null} */
  let ready = null;
  const restore = () => ready ??= Promise.all([session.sessionGet(key), browser.tabs.query({})]).then(([saved, tabs]) => {
    for (const row of Array.isArray(saved) ? saved : []) {
      if (!validId(row?.windowId) || !['home', 'panel', null].includes(row.chatOwner)) continue;
      if (!tabs.some((/** @type {any} */ tab) => tab.windowId === row.windowId)) continue;
      const home = tabs.find((/** @type {any} */ tab) => tab.id === row.homeTabId
        && tab.windowId === row.windowId && isHome(tab));
      windows.set(row.windowId, {
        windowId: row.windowId,
        chatOwner: row.chatOwner === 'home' && !home ? null : row.chatOwner,
        homeTabId: home?.id ?? null, sidePanelOpen: row.sidePanelOpen === true,
        panelDocumentId: typeof row.panelDocumentId === 'string' ? row.panelDocumentId : null,
      });
    }
  }).catch((cause) => { ready = null; throw cause; });
  const rowFor = (/** @type {number} */ windowId) => {
    let row = windows.get(windowId);
    if (!row) {
      row = { windowId, chatOwner: null, homeTabId: null, sidePanelOpen: false, panelDocumentId: null };
      windows.set(windowId, row);
    }
    return row;
  };
  const settle = (/** @type {()=>Promise<any>} */ operation) => lane(async () => {
    await restore();
    const before = [...windows.values()].map((row) => ({ ...row }));
    try {
      const result = await operation();
      const rows = [...windows.values()];
      if (JSON.stringify(rows) !== JSON.stringify(before)) {
        await session.sessionSet(key, rows);
        for (const row of rows) { try { publish({ ...row }); } catch {} }
      }
      return result;
    } catch (cause) {
      windows.clear();
      for (const row of before) windows.set(row.windowId, row);
      throw cause;
    }
  });
  const checkHome = async (/** @type {ReturnType<typeof rowFor>} */ row) => {
    if (row.homeTabId === null) return;
    const home = await browser.tabs.get(row.homeTabId).catch(() => null);
    if (isHome(home) && home.windowId === row.windowId) return;
    row.homeTabId = null;
    if (row.chatOwner === 'home') row.chatOwner = row.sidePanelOpen ? 'panel' : null;
  };
  const checkPanel = async (/** @type {ReturnType<typeof rowFor>} */ row) => {
    if (typeof browser.sidebarAction?.isOpen === 'function') {
      row.sidePanelOpen = await browser.sidebarAction.isOpen({ windowId: row.windowId });
    } else if (row.sidePanelOpen && typeof browser.sidePanel?.onClosed?.addListener !== 'function'
        && typeof browser.runtime?.getContexts === 'function') {
      const contexts = await browser.runtime.getContexts({ contextTypes: ['SIDE_PANEL'],
        ...(row.panelDocumentId ? { documentIds: [row.panelDocumentId] } : {}),
      }).catch(() => null);
      if (contexts?.length === 0) row.sidePanelOpen = false;
    }
    if (!row.sidePanelOpen) {
      row.panelDocumentId = null;
      if (row.chatOwner === 'panel') row.chatOwner = row.homeTabId === null ? null : 'home';
    }
  };
  const get = (/** @type {any} */ message = {}, /** @type {any} */ sender = {}) => settle(async () => {
    const panel = isPanelSender(sender);
    const windowId = validId(sender.tab?.windowId) ? sender.tab.windowId
      : panel && validId(message.windowId) ? message.windowId : null;
    if (windowId === null) return { ok: false, error: 'surface-window-required' };
    const row = rowFor(windowId);
    await checkHome(row);
    await checkPanel(row);
    if (panel) {
      row.sidePanelOpen = true;
      if (typeof sender.documentId === 'string') row.panelDocumentId = sender.documentId;
      row.chatOwner ??= 'panel';
    } else if (isHome({ ...sender.tab, url: sender.url ?? sender.tab?.url })) {
      row.homeTabId ??= sender.tab.id;
      row.chatOwner ??= row.sidePanelOpen ? 'panel' : 'home';
    }
    return { ok: true, ...row };
  });
  return Object.freeze({
    get,
    panel: (/** @type {number} */ windowId, /** @type {boolean} */ open) => settle(async () => {
      if (!validId(windowId)) return;
      const row = rowFor(windowId);
      await checkHome(row);
      row.sidePanelOpen = open;
      if (!open) row.panelDocumentId = null;
      if (open) row.chatOwner ??= 'panel';
      else if (row.chatOwner === 'panel') row.chatOwner = row.homeTabId === null ? null : 'home';
    }),
    refresh: () => settle(async () => {
      for (const row of windows.values()) {
        await checkHome(row);
        await checkPanel(row);
      }
    }),
    inWindow: (/** @type {number} */ windowId) => settle(async () => {
      const row = rowFor(windowId);
      await checkHome(row);
      return { ...row };
    }),
  });
};
