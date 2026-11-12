// @ts-check
import m from '/vendor/mithril/mithril.js';
import browser from '/shared/browser-api.js';
import { makeNativeWorkspace } from './native-workspace.js';

/** @typedef {import('./native-workspace.js').WorkspaceSnapshot} WorkspaceSnapshot */
/** @typedef {ReturnType<typeof makeNativeWorkspace>} Workspace */

/** @type {Promise<Workspace>|null} */ let documentWorkspace = null;
const getWorkspace = () => documentWorkspace ??= (async () => {
  const home = await browser.tabs.getCurrent();
  if (typeof home?.id !== 'number') throw new Error('home-tab-unavailable');
  const workspace = makeNativeWorkspace({
    tabs: /** @type {import('./native-workspace.js').NativeWorkspaceTabs} */ (
      /** @type {unknown} */ (globalThis.chrome?.tabs ?? browser.tabs)),
    homeTabId: home.id,
  });
  // The Home document keeps one discard owner across component remounts.
  window.addEventListener('pagehide', () => { void workspace.release().catch(() => {}); }, { once: true });
  return workspace;
})().catch(error => { documentWorkspace = null; throw error; });

/** @param {number} tabId */
export const showBrowserPage = async (tabId) => (await getWorkspace()).showPageOnly(tabId);
export const protectHomeDocument = async () => (await getWorkspace()).protect();

export const WorkspaceHeader = () => {
  /** @type {Workspace|null} */ let workspace = null;
  /** @type {WorkspaceSnapshot|null} */ let snapshot = null;
  /** @type {HTMLElement|null} */ let element = null;
  let menuOpen = false, busy = false, removed = false;
  const focus = (/** @type {string} */ selector) => requestAnimationFrame(() => {
    const target = element?.querySelector(selector);
    if (target instanceof HTMLElement) target.focus();
  });
  const redraw = () => { if (!removed) m.redraw(); };
  const start = async () => {
    workspace = await getWorkspace();
    snapshot ??= await workspace.refresh();
    redraw();
  };
  const refresh = () => {
    if (busy || removed) return;
    void start().then(async () => {
      const next = await workspace?.refresh();
      if (next) snapshot = snapshot?.notice
        ? { ...next, notice: snapshot.notice,
          fallback: snapshot.fallback?.tabId === null || next.pages.some(tab => tab.id === snapshot?.fallback?.tabId)
            ? snapshot.fallback : null } : next;
      redraw();
    }).catch(() => { redraw(); });
  };
  const closeMenu = (restore = false) => {
    menuOpen = false; redraw();
    if (restore) focus('[data-workspace-split]');
  };
  /** @param {(controller:Workspace)=>Promise<WorkspaceSnapshot>} operation @param {string} [target] */
  const act = async (operation, target) => {
    if (busy) return;
    busy = true; menuOpen = false; redraw();
    try {
      await start();
      if (workspace) snapshot = await operation(workspace);
    } catch {
      snapshot = { available: false, home: null, pages: [], peer: null, ok: false,
        notice: 'Split view could not start. Try again.', fallback: null };
    } finally {
      busy = false; redraw();
      if (snapshot?.notice) focus('.home-workspace-notice button');
      else if (target) focus(target);
    }
  };
  const openMenu = async (last = false) => {
    if (busy) return;
    if (menuOpen) { closeMenu(true); return; }
    await act(async controller => {
      const state = await controller.refresh();
      menuOpen = state.ok;
      return state;
    });
    if (menuOpen) focus(last ? '[role="menuitem"]:last-child' : '[role="menuitem"]');
  };
  /** @param {KeyboardEvent} event */
  const menuKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
    if (event.key === 'Tab') { closeMenu(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...(element?.querySelectorAll('[role="menuitem"]') ?? [])];
    const current = items.indexOf(/** @type {Element} */ (document.activeElement));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    /** @type {HTMLElement|undefined} */ (items[next])?.focus();
  };
  /** @param {PointerEvent} event */
  const outside = (event) => {
    if (menuOpen && !element?.contains(/** @type {Node} */ (event.target))) closeMenu();
  };
  const visible = () => { if (!document.hidden) refresh(); };
  const events = [browser.tabs.onUpdated, browser.tabs.onMoved, browser.tabs.onRemoved,
    browser.tabs.onAttached, browser.tabs.onDetached, browser.tabs.onActivated];
  return {
    /** @param {{dom:HTMLElement,attrs:{title:string,openMenu?:boolean,lastItem?:boolean}}} vnode */
    oncreate({ dom, attrs }) {
      element = dom;
      for (const event of events) event?.addListener(refresh);
      document.addEventListener('pointerdown', outside);
      document.addEventListener('visibilitychange', visible);
      void start().then(() => { if (attrs.openMenu) return openMenu(attrs.lastItem); }).catch(() => {});
    },
    onremove() {
      removed = true;
      for (const event of events) event?.removeListener(refresh);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('visibilitychange', visible);
      // The document owns discard protection until it unloads.
    },
    /** @param {{attrs:{title:string}}} vnode */
    view({ attrs }) {
      const paired = !!snapshot?.peer;
      const fallback = snapshot?.fallback;
      const fallbackPage = snapshot?.pages.find(tab => tab.id === fallback?.tabId);
      return m('.home-workspace-heading', [
        m('.home-chat-bar', [
          m('span.home-chat-title', attrs.title), m('.spacer', { style: 'flex:1' }),
          m('.home-workspace-controls', paired ? [
            m('button.home-popout', { disabled: busy, 'data-workspace-page': '',
              onclick: () => act(controller => controller.showPageOnly()) }, 'Show page only'),
            m('button.home-popout', { disabled: busy,
              onclick: () => act(controller => controller.closeSplit(), '[data-workspace-split]') }, 'Close split view'),
          ] : [
            m('button.home-popout', { disabled: busy, 'data-workspace-split': '',
              'aria-haspopup': 'menu', 'aria-expanded': String(menuOpen),
              onclick: () => openMenu(),
              onkeydown: (/** @type {KeyboardEvent} */ event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault(); void openMenu(event.key === 'ArrowUp');
                }
              } }, ['Split view ', m('span', { 'aria-hidden': 'true' }, '⌄')]),
            menuOpen ? m('.home-workspace-menu', { role: 'menu', 'aria-label': 'Split view', onkeydown: menuKey }, [
              m('button', { key: 'new', role: 'menuitem', tabindex: -1,
                onclick: () => act(controller => controller.newTabBeside()) }, 'New tab beside chat'),
              ...(snapshot?.pages ?? []).map(tab => {
                const movesHome = snapshot?.home && snapshot.home.index + 1 !== tab.index;
                return m('button', { key: tab.id, role: 'menuitem', tabindex: -1,
                  onclick: () => act(controller => controller.besideTab(tab.id, { moveHome: true }), '[data-workspace-page]') }, [
                  m('span', `Beside ${tab.title || `Tab ${tab.index + 1}`}`),
                  movesHome && !snapshot?.home?.pinned && snapshot?.home?.groupId === tab.groupId
                    && !(typeof tab.splitViewId === 'number' && tab.splitViewId >= 0)
                    ? m('small', 'Moves the Home tab next to it') : null,
                ]);
              }),
            ]) : null,
          ]),
        ]),
        snapshot?.notice ? m('.home-workspace-notice', m('.notice', { role: 'status' }, [
          m('span.notice-text', snapshot.notice),
          fallback ? m('button.notice-action', { disabled: busy,
            onclick: () => act(controller => controller.showPageOnly(fallback.tabId))
          }, fallback.tabId === null ? 'Open new tab' : `Open ${fallbackPage?.title || 'tab'}`) : null,
          m('button.icon', { 'aria-label': 'Dismiss', onclick: () => {
            if (snapshot) snapshot = { ...snapshot, notice: '', fallback: null }; redraw();
          } }, '×'),
        ])) : null,
      ]);
    },
  };
};
