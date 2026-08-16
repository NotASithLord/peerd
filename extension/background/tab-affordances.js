// @ts-check
// background/tab-affordances.js — how peerd shows up in the browser's tab strip.
//
// Extracted from the SW (wiring, not logic). Three cohesive affordances, all
// pure UI presence with NO security surface, sharing only tab-strip state:
//   1. the agent-tab CARD — the home/side-panel notice "peerd opened <tab>",
//      anchored to the message_actor turn that last drove that tab (tabMsgAnchor);
//   2. the "pull peerd in" HINT — a one-shot, informational, auto-dismissing
//      caption injected into peerd-opened web tabs (never messages the SW back,
//      crosses no boundary — docs/PULL-IN-PEERD-WEB-SCOPE.md);
//   3. the FRONT DOOR — the toolbar icon + Alt+Shift+P command: open home, or
//      pull the chat panel in.
//
// A helper module (like tab-tracker.js), so it imports its stateless
// collaborators directly and receives the stateful ones (browser, uiPorts,
// denylist, closeSidePanel) as deps. All the reassigned tab-strip state
// (agentTab*, activeTabId, peerdWebTabs, homeTabIds, lastFocusedWindowId,
// tabMsgAnchor) is cluster-internal and lives here; the SW keeps the wiring.

import { openHome } from '/shared/open-home.js';
import { decidePullIn } from './panel-affordance.js';
import { pullInHintInjected } from '/peerd-runtime/background.js';
import { matchesDenylist } from '/peerd-egress/background.js';
import { shouldFollowAgentTab } from './watch-mode.js';
import { allowedDocumentTarget } from './page-activity.js';
import { classifyBrowserAutomationTarget } from '/peerd-runtime/background.js';

// The home agent-tab card's Open button draws a fresh brand color each time the
// card is (re)generated — the sanctioned "peers/actions are the content" accent
// (p·cyan e·red e·amber r·green d·magenta).
const AGENT_TAB_COLORS = ['#00B7EB', '#EF4444', '#F59E0B', '#22C55E', '#D946EF'];

/**
 * @param {Object} deps
 * @param {any} deps.browser
 * @param {{ broadcast: (m: any) => void, hasNamed: (name: string) => boolean }} deps.uiPorts
 * @param {{ patterns: () => any }} deps.denylistStore
 * @param {() => Promise<any>} deps.closeSidePanel
 * @param {() => boolean} [deps.isWatchOn]  live read of the watchAgentTab setting (default off)
 * @param {() => ('panel'|'home')} [deps.getFrontDoorView]  live read of the frontDoorView setting (default 'panel')
 */
export const makeTabAffordances = ({ browser, uiPorts, denylistStore, closeSidePanel, isWatchOn = () => false, getFrontDoorView = () => 'panel' }) => {
  const HOME_URL = browser.runtime.getURL('home/home.html');

  // ── 1. the agent-tab card ──────────────────────────────────────────────────
  // DESIGN-17/18 tab-card anchoring: maps an agent tab → the message_actor tool_use
  // that LAST drove it. The inline "peerd opened …" notice anchors to THAT message's
  // turn, not the wall-clock-latest user message — actor work is async, so a physical
  // tab touch (engine ensureTab / web DOM noteTab) often lands during a later turn,
  // which would clump the cards at the chat's end. Set at each actor-turn start
  // (runActorTurn) for the actor's owned tab; never cleared — overwritten only when a
  // NEW message re-drives that tab, which is exactly when the card should resurface to
  // the newer turn. Orchestrator-opened tabs (open_tab) are absent here → they keep the
  // wall-clock anchor (correct; they're synchronous).
  /** @type {Map<number, string>} tabId → parentToolUseId */
  const tabMsgAnchor = new Map();
  const setTabAnchor = (/** @type {number} */ tabId, /** @type {string} */ parentToolUseId) => {
    if (typeof tabId === 'number') tabMsgAnchor.set(tabId, parentToolUseId);
  };

  /** @type {number | null} */ let agentTabId = null;
  /** @type {any} */ let agentTabInfo = null;   // the last { tabId, windowId, kind, name, label, color } noted
  /** @type {number | null} */ let activeTabId = null;    // the currently-active tab — hide the card when you're ON it
  // Broadcast the current-agent-tab pointer. `noted` is true ONLY when this fires
  // from a real agent touch (noteAgentTab) — the inline notice creates/resurfaces
  // on those; a passive refresh (tab activation, a fresh surface replay) sends
  // noted:false so clicking around tabs never bumps a notice.
  const broadcastAgentTab = (noted = false) => {
    uiPorts.broadcast({
      type: 'agent/tab',
      tab: agentTabInfo ? { ...agentTabInfo, current: agentTabInfo.tabId === activeTabId, noted } : null,
    });
  };
  const noteAgentTab = async (/** @type {number} */ tabId, /** @type {any} */ info = {}) => {
    if (typeof tabId !== 'number') return;
    const {
      kind = null, name = null, label = null, opened = true, protected: protectedTab = true,
      parentToolUseId: ptuArg = null,
    } = (typeof info === 'string' ? { label: info } : info);
    // The message_actor turn driving this tab (see tabMsgAnchor) — caller-supplied or the
    // last actor-turn-start mapping. Flows to the agent/tab event so the notice anchors to
    // that message's turn instead of the wall-clock-latest user message.
    const parentToolUseId = ptuArg ?? tabMsgAnchor.get(tabId) ?? null;
    let windowId; let title = null;
    try { const t = await browser.tabs.get(tabId); windowId = t.windowId; title = t.title || t.url || null; }
    catch { return; } // tab already gone — don't point the card at a dead tab
    agentTabId = tabId;
    // Instance tabs carry a kind + the instance NAME (the card reads like a tab:
    // "Notebook | my-nb"); a web tab (open_tab / DOM) just shows its page label.
    const text = (kind && name) ? `${kind} · ${name}` : (label || title || 'a tab');
    // why a fresh brand color each generation (owner): the home card's Open button
    // cycles a peerd brand color so it stays eye-catching.
    const color = AGENT_TAB_COLORS[Math.floor(Math.random() * AGENT_TAB_COLORS.length)];
    // `opened`: true when peerd OPENED this tab (open_tab / an engine create) — the
    // only case that mints an inline notice; false when the web actor merely ACTED
    // on a tab, which resurfaces an existing notice but never invents one for a tab
    // the USER opened. `noted: true` marks this as a real agent touch (vs. a
    // passive current-flag refresh on tab activation).
    agentTabInfo = {
      tabId, windowId, kind, name, label: text, color, opened,
      protected: protectedTab, parentToolUseId,
    };
    broadcastAgentTab(true);
    // Watch mode: FOLLOW the agent onto this tab. No-op unless the user opted in
    // (isWatchOn) and it isn't already the active tab — see focusAgentTab.
    focusAgentTab();
  };

  // Bring the agent's tab to the foreground (+ its window), the OPT-IN inverse of
  // DESIGN-12's no-focus-steal: only when the user turned watch mode on. Called on
  // every agent tab touch (noteAgentTab) so watching FOLLOWS the agent across tabs,
  // and by the SW the instant the setting flips on (onSettingsChanged). The agent
  // addresses tabs by id, never by focus, so foregrounding a tab for the user never
  // changes what the agent does — it just un-hides the work. Best-effort: a
  // vanished tab/window is swallowed (the follow is cosmetic, never load-bearing).
  // The agent tab we last followed — the follow fires only when the agent MOVES
  // to a different tab. why: noteAgentTab fires on every tool touch, and goal
  // mode / script fan-out drive several actors (and tabs) in parallel, so a
  // per-touch follow made two live actors ping-pong the foreground several times
  // per model step. Following the CHANGE, not the touch, makes a settled agent
  // silent — and it also stops re-stealing focus the user deliberately moved away.
  /** @type {number | null} */ let lastFollowedTabId = null;

  const focusAgentTab = async () => {
    if (typeof agentTabId !== 'number') return;
    // Resolve "is it already in front?" from LIVE state rather than the remembered
    // activeTabId scalar — that one is unseeded after an MV3 respawn and is global
    // while `active` is per-window, which defeated this guard in exactly the
    // two-window layout watch mode encourages (see watch-mode.js).
    let alreadyInFront = false;
    let winId = agentTabInfo?.windowId;
    try {
      const tab = await browser.tabs?.get?.(agentTabId);
      if (!tab) return;                                  // tab vanished — nothing to follow
      winId = tab.windowId ?? winId;
      alreadyInFront = tab.active === true && tab.windowId === lastFocusedWindowId;
    } catch { return; }                                  // gone mid-flight — never guess
    if (!shouldFollowAgentTab({
      watchOn: isWatchOn(),
      // The toggle lives in the side panel, so the panel IS what "watching" means.
      // A parked home tab must not count — its port outlives every SW respawn.
      panelOpen: uiPorts.hasNamed('sidepanel'),
      chromeFocused,
      agentTabId,
      alreadyInFront,
    })) return;
    if (agentTabId === lastFollowedTabId) return;        // same tab — already followed it
    lastFollowedTabId = agentTabId;
    try {
      await browser.tabs?.update?.(agentTabId, { active: true });
      if (typeof winId === 'number') await browser.windows?.update?.(winId, { focused: true });
    } catch (e) {
      console.debug('[sw] watch-mode focus skipped', (/** @type {{ message?: string }} */ (e))?.message ?? e);
    }
  };
  // Track the active tab so the card hides when you're on the agent tab, and shows
  // again when you move away.
  browser.tabs?.onActivated?.addListener((/** @type {{ tabId: number }} */ { tabId }) => {
    activeTabId = tabId;
    if (agentTabInfo) broadcastAgentTab();
  });
  // Clear the card when the agent tab closes (clicking a dead tab does nothing).
  browser.tabs?.onRemoved?.addListener((/** @type {number} */ tabId) => {
    if (tabId === agentTabId) { agentTabId = null; agentTabInfo = null; broadcastAgentTab(); }
  });

  // ── 2. the "pull peerd in" hint ─────────────────────────────────────────────
  // A peerd-opened WEB tab gets a brief, auto-dismissing caption (top-right) that
  // types out "Press <shortcut> to pull peerd in" — engine tabs carry the real
  // button, a third-party page can't, so this points you at the shortcut/icon.
  // INFORMATIONAL ONLY (it never messages the SW back), so it crosses no boundary
  // and needs no new permission. One-shot, on first load, via chrome.scripting;
  // never on a denylisted/sensitive origin; the injected script itself waits until
  // the tab is actually visible before it shows. Peerd-opened web tabs (tabId →
  // origin), tracked so we can show the reminder at the RIGHT moment: when the user
  // is ACTIVELY VIEWING one with the SIDEBAR CLOSED — they walked onto it, OR they
  // closed the panel while on it. The page world can't read sidebar state, so the
  // SW gates the inject; the injected script is idempotent + auto-dismissing.
  /** @type {Map<number, string>} */
  const peerdWebTabs = new Map();
  // The peerd toolbar icon as a data: URL, so the injected hint can show it on a
  // third-party page without a chrome-extension:// fetch. Fetched + cached once;
  // '' if it ever fails (the hint then falls back to the wordmark text).
  /** @type {string | null} */ let pullInIconUrl = null;
  const getPullInIconUrl = async () => {
    if (pullInIconUrl !== null) return pullInIconUrl;
    try {
      const res = await fetch(browser.runtime.getURL('icons/icon32.png'));
      const bytes = new Uint8Array(await res.arrayBuffer());
      pullInIconUrl = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
    } catch (e) {
      console.debug('[sw] pull-in icon load failed', (/** @type {{ message?: string }} */ (e))?.message ?? e);
      pullInIconUrl = '';
    }
    return pullInIconUrl;
  };
  const showWebTabHint = async (/** @type {number} */ tabId) => {
    if (!peerdWebTabs.has(tabId)) return;
    if (uiPorts.hasNamed('sidepanel')) return;          // sidebar open → the chat's already here
    let tab;
    try { tab = await browser.tabs.get(tabId); } catch { return; }
    if (!tab || tab.status !== 'complete' || tab.active !== true) return; // only when actually being viewed
    // Still the page peerd opened? (don't graffiti the user's own later navigation.)
    let origin;
    try { origin = new URL(/** @type {string} */ (tab.url)).origin; } catch { return; }
    if (origin !== peerdWebTabs.get(tabId)) { peerdWebTabs.delete(tabId); return; }
    // Re-check the live committed location and pin the hint to that exact
    // document. A navigation after this probe makes the mutation fail instead
    // of landing on the replacement page.
    const target = await allowedDocumentTarget(tabId, {
      tabs: browser.tabs,
      scripting: browser.scripting,
    }, { denylist: denylistStore.patterns() }, origin);
    if (!target) return;
    let shortcut = '';
    try {
      const cmds = await browser.commands?.getAll?.();
      shortcut = (cmds ?? []).find((/** @type {any} */ c) => c.name === 'pull-in-peerd')?.shortcut || '';
    } catch { /* no commands API in this build */ }
    const iconUrl = await getPullInIconUrl();
    try {
      await browser.scripting.executeScript({ target, func: pullInHintInjected, args: [shortcut, iconUrl] });
    } catch (e) {
      // Pages the browser refuses to inject into (chrome:, the stores, a hard CSP)
      // — harmless; the hint just doesn't show.
      console.debug('[sw] pull-in hint inject skipped', (/** @type {{ message?: string }} */ (e))?.message ?? e);
    }
  };
  const scheduleWebTabHint = (/** @type {number} */ tabId, /** @type {string} */ url) => {
    if (typeof tabId !== 'number' || typeof url !== 'string') return;
    let u;
    try { u = new URL(url); } catch { return; } // not a real web URL → no hint
    if (!u.protocol.startsWith('http')) return;
    if (!classifyBrowserAutomationTarget(u).allowed) return;
    if (matchesDenylist(u.hostname, denylistStore.patterns())) return; // never graffiti a sensitive site
    peerdWebTabs.set(tabId, u.origin);
    showWebTabHint(tabId); // if the user is already viewing it with the sidebar closed
  };
  // Show when the user WALKS ONTO a peerd web tab, or it finishes loading while
  // they're on it. (Sidebar-close is handled at the port disconnect, in the SW.)
  browser.tabs?.onActivated?.addListener((/** @type {{ tabId: number }} */ { tabId }) => { showWebTabHint(tabId); });
  browser.tabs?.onUpdated?.addListener((/** @type {number} */ tabId, /** @type {any} */ changeInfo) => { if (changeInfo.status === 'complete') showWebTabHint(tabId); });
  browser.tabs?.onRemoved?.addListener((/** @type {number} */ tabId) => { peerdWebTabs.delete(tabId); });

  // ── 3. the front door — toolbar icon + Alt+Shift+P ──────────────────────────
  // The toolbar icon is peerd's FRONT DOOR, and which surface it opens is the
  // user's `frontDoorView` setting (Settings → Behavior): 'panel' (default)
  // pulls the chat into the window-global side panel (Chrome) / sidebar
  // (Firefox) so it sits next to the page and follows you onto ANY tab;
  // 'home' restores the original full-page-first model (DESIGN-12) — home
  // with no home up yet, the panel once home IS up. The Alt+Shift+P command
  // is the dedicated twin: it ALWAYS pulls the panel in, from anywhere.
  //
  // Hard constraint: sidePanel.open()/sidebarAction.open() must run SYNCHRONOUSLY
  // inside the click/keystroke gesture — no await before them or the activation is
  // dropped. So every decision input must be available without awaiting: the window
  // id (from the listener's tab arg) and "is home open?" (two sync signals below).
  // We cannot tabs.query() in the gesture; decidePullIn is a pure sync fn.

  // Sync "is home open?" — a boot-seeded set of home tab ids OR a live home port.
  // why both: the set survives an SW respawn (the home port may not have reconnected
  // in the instant the icon fires); the port covers a home tab the set hasn't learned
  // yet. A miss is benign — openHome() is focus-or-create.
  /** @type {Set<number>} */
  const homeTabIds = new Set();
  const trackHomeTab = (/** @type {number} */ tabId, /** @type {string} */ url) => {
    if (typeof url !== 'string') return;
    if (url.startsWith(HOME_URL)) homeTabIds.add(tabId);
    else homeTabIds.delete(tabId);
  };
  browser.tabs?.query?.({}).then((/** @type {any[]} */ tabs) => {
    for (const t of tabs) if (t.id != null) trackHomeTab(t.id, t.url ?? '');
  }).catch((/** @type {any} */ e) => console.debug('[sw] home-tab bootstrap failed', e));
  browser.tabs?.onUpdated?.addListener((/** @type {number} */ tabId, /** @type {any} */ changeInfo, /** @type {any} */ tab) => {
    if (changeInfo.url != null || tab?.url != null) trackHomeTab(tabId, /** @type {string} */ (changeInfo.url ?? tab.url));
  });
  browser.tabs?.onRemoved?.addListener((/** @type {number} */ tabId) => { homeTabIds.delete(tabId); });
  const isHomeOpen = () => homeTabIds.size > 0 || uiPorts.hasNamed('home');

  // A synchronous current-window id for sidePanel.open({ windowId }). onClicked and
  // (modern) onCommand both supply the tab, so this only backstops engines whose
  // command callback omits it. Seeded at boot, kept warm on focus changes.
  /** @type {number | null} */ let lastFocusedWindowId = null;
  // Is the BROWSER the focused application right now? Watch mode's follow reads
  // it: the worst thing a stray follow can do is haul Chrome over the app the
  // user alt-tabbed to, so if they aren't even in the browser we never raise a
  // window. onFocusChanged reports WINDOW_ID_NONE precisely when Chrome loses
  // focus; the boot seed reads the real `focused` flag rather than assuming.
  let chromeFocused = false;
  browser.windows?.getLastFocused?.().then((/** @type {any} */ w) => {
    lastFocusedWindowId = w?.id ?? lastFocusedWindowId;
    chromeFocused = w?.focused === true;
  }).catch(() => {});
  browser.windows?.onFocusChanged?.addListener((/** @type {number} */ winId) => {
    const none = winId == null || winId === browser.windows.WINDOW_ID_NONE;
    chromeFocused = !none;
    if (!none) lastFocusedWindowId = winId;
  });

  // Mirror the front-door choice into Chrome's NATIVE action-click behavior.
  // With openPanelOnActionClick:true the browser opens the side panel itself —
  // before the SW even wakes — so the default 'panel' front door can never
  // race cold-start settings hydration (the store serves channel defaults
  // until its async load lands, and the click that WAKES the worker beats it).
  // Consequence: action.onClicked then only fires for 'home' users, which is
  // the inference decidePullIn's nativePanelMirror leg rides. Chrome persists
  // the behavior browser-side; re-applying at boot + on a frontDoorView write
  // (both SW-wired) keeps it true to the setting. Native semantics also make
  // the icon a panel TOGGLE for 'panel' users — the platform convention for
  // side-panel extensions. Firefox has no equivalent, so its icon path keeps
  // the sync settings read (a 'home' opt-in there can still see one
  // panel-open on a cold event-page wake — accepted residual).
  const syncFrontDoorBehavior = async () => {
    try {
      await (/** @type {any} */ (browser)).sidePanel?.setPanelBehavior?.({
        openPanelOnActionClick: getFrontDoorView() === 'panel',
      });
    } catch (e) {
      console.warn('[sw] setPanelBehavior failed', e);
    }
  };

  // The pull-in itself — open() runs synchronously (no await before it) to keep the
  // gesture; a failed/declined open falls back to home so the icon never dead-ends.
  const pullInPeerd = (/** @type {number} */ windowId, { fromShortcut = false } = {}) => {
    const target = decidePullIn({
      homeOpen: isHomeOpen(),
      panelOpen: uiPorts.hasNamed('sidepanel'),
      hasSidePanel: !!(/** @type {any} */ (browser)).sidePanel?.open,
      hasSidebar: !!browser.sidebarAction?.open,
      fromShortcut,
      frontDoorView: getFrontDoorView(),
      nativePanelMirror: !!(/** @type {any} */ (browser)).sidePanel?.setPanelBehavior,
    });
    // Toggle-closed (shortcut only) — close needs no gesture, so fire and forget.
    if (target === 'close') { closeSidePanel(); return; }
    try {
      if (target === 'panel' && windowId != null) {
        const p = (/** @type {any} */ (browser)).sidePanel.open({ windowId });
        if (p?.catch) p.catch((/** @type {any} */ e) => { console.warn('[sw] sidePanel.open failed', e); openHome(); });
        return;
      }
      if (target === 'sidebar') {
        const p = browser.sidebarAction.open();
        if (p?.catch) p.catch((/** @type {any} */ e) => { console.warn('[sw] sidebarAction.open failed', e); openHome(); });
        return;
      }
    } catch (e) { console.warn('[sw] pull-in open threw', e); }
    openHome();
  };

  browser.action?.onClicked?.addListener((/** @type {any} */ tab) => {
    pullInPeerd(/** @type {number} */ (tab?.windowId ?? lastFocusedWindowId), { fromShortcut: false });
  });
  // Alt+Shift+P (user-rebindable) — TOGGLES the panel: pulls it in, or closes it if
  // already open. The command handler is a VALID user-gesture context on BOTH Chrome
  // and Firefox, so it needs no content-script relay — and thus no hole in the
  // fail-closed SW boundary the injected-web-page button would have required.
  browser.commands?.onCommand?.addListener((/** @type {string} */ command, /** @type {any} */ tab) => {
    if (command !== 'pull-in-peerd') return;
    pullInPeerd(/** @type {number} */ (tab?.windowId ?? lastFocusedWindowId), { fromShortcut: true });
  });

  return { noteAgentTab, broadcastAgentTab, scheduleWebTabHint, showWebTabHint, setTabAnchor, isHomeOpen, focusAgentTab, syncFrontDoorBehavior };
};
