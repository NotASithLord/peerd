// @ts-check
// peerd — the home page. A standalone full-tab SPA (NOT the options page):
// a left rail switches between the agent Chat and the Library / Discover /
// Network sections. The Chat is an EQUAL live view of the same SW session the
// side panel shows (DESIGN-12): home connects a 'home' port and folds the SAME
// pushes through the SHARED reduceChat, so switching between home and the side
// panel never loses history — they're two projections of one worker session.
// "Pop to the side" hands the chat to the window-global side panel so it
// follows you across tabs while the agent drives the browser.
//
// Opened from the side-panel header (▦) or the toolbar icon. Settings is a link
// from the rail (configuration stays distinct from the home surface).

import m from '/vendor/mithril/mithril.js';
import browser from '/vendor/browser-polyfill.js';
import { CHANNEL, DWEB_ENABLED } from '/shared/channel-config.js';
import { loadDweb } from '/shared/dweb-loader.js';
import { openOptions } from '/shared/open-options.js';
import { LibrarySection } from './library-section.js';
import { NetworkSection } from './network-section.js';
import { DiscoverSection } from './discover-section.js';
import { ContactsSection } from './contacts-section.js';
import { EvalSection } from './eval-section.js';
import { INITIAL_STATE, reduceChat, putSubagentSession } from '../sidepanel/chat-reducer.js';
import { ChatView } from '../sidepanel/components/chat-view.js';
import { ConfirmModal, NoticeBar } from '../sidepanel/components/app.js';
import { VaultGate } from '../sidepanel/components/vault-gate.js';
import { peerNotifications } from '/shared/peer-notifications.js';

/** @typedef {import('./library-section.js').Send} Send */

// why a typed accessor: the Chrome-only sidePanel namespace isn't on the
// webextension-polyfill `Browser` type (it proxies to chrome.* at runtime, but
// the type omits it). Same pattern as shared/pull-in-peerd.js.
const sidePanelApi = () =>
  /** @type {{ sidePanel?: typeof chrome.sidePanel }} */ (
    /** @type {unknown} */ (browser)
  ).sidePanel;

// Live, SW-fed state (was a one-shot snapshot). Starts at INITIAL_STATE; the
// first 'state' push over the port corrects the vault/session truth.
/** @type {any} */
let currentState = INITIAL_STATE;
let booted = false;          // first state push arrived — until then, show "Loading…"
// activeView persists across refreshes (localStorage) so you land on the tab you
// were on. Dweb views only restore where DWEB_ENABLED; anything unknown → 'chat'.
const VIEW_KEY = 'peerd.home.activeView';
const DWEB_VIEWS = new Set(['discover', 'contacts', 'network']);
const ALL_VIEWS = new Set(['chat', 'chats', 'library', 'eval', 'discover', 'contacts', 'network']);
/** @param {string | null | undefined} v */
const isValidView = (v) => !!v && ALL_VIEWS.has(v) && (!DWEB_VIEWS.has(v) || DWEB_ENABLED);
// A `#view` fragment is an explicit deep-link (openHome('library') → "Open
// Library"). It wins over the stored view; we consume it (clear the hash) so a
// later rail click + refresh isn't dragged back to the deep-linked view.
const viewFromHash = () => {
  try {
    const v = (location.hash || '').replace(/^#/, '');
    return isValidView(v) ? v : null;
  } catch { return null; }
};
// replaceState (not assigning location.hash) — strips the fragment WITHOUT
// firing another hashchange, so consuming a deep-link doesn't loop.
const clearHash = () => {
  try { if (location.hash) history.replaceState(null, '', location.pathname + location.search); }
  catch { /* history API unavailable */ }
};
const readView = () => {
  const fromHash = viewFromHash();
  if (fromHash) return fromHash;
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (isValidView(v)) return v;
  } catch { /* storage disabled / private mode */ }
  return 'chat';
};
let activeView = readView();  // chat | chats | library | eval | discover | contacts | network
clearHash();                  // deep-link consumed at boot — see viewFromHash
/** @param {string} v */
const setView = (v) => { activeView = v; try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };
// Single-homed chat (DESIGN-12, owner 2026-06-18): when a side panel is open it
// OWNS Chat + Chats, and home shows only the tool sections. The SW broadcasts
// this on every surface connect/disconnect.
let sidePanelOpen = false;
/** @type {string | null} */
let stashedChatView = null;  // the chat/chats view we auto-left when the panel opened — restored on close
// "Pop to side" is STICKY: an explicit pop stays open until you un-pop (Bring it
// here) or close the sidebar yourself — it does NOT auto-close on return to home.
// (A panel opened by an "Open ↗" tab card is NOT sticky — it auto-closes when you
// come back, so you can glance at the agent's tab then return.)
let panelStickyByPop = false;
// The recent-chats list column is collapsible (it gets noisy) — persisted.
let chatListCollapsed = (() => { try { return localStorage.getItem('peerd.home.chatsCollapsed') === '1'; } catch { return false; } })();
const toggleChatList = () => {
  chatListCollapsed = !chatListCollapsed;
  try { localStorage.setItem('peerd.home.chatsCollapsed', chatListCollapsed ? '1' : '0'); } catch { /* private mode */ }
  m.redraw();
};

// ---- live port to the SW (home is an equal live surface, DESIGN-12) -------
/** @type {import('webextension-polyfill').Runtime.Port | null} */
let port = null;
const connectPort = () => {
  port = browser.runtime.connect({ name: 'home' });
  port.onMessage.addListener(handlePortMessage);
  port.onDisconnect.addListener(handlePortDisconnect);
};
/** @param {any} msg */
const handlePortMessage = (msg) => {
  if (!msg || typeof msg.type !== 'string') return;
  // Voice is side-panel-only (no mic surface here) — ignore voice/* pushes.
  if (msg.type.startsWith('voice/')) return;
  // Surface presence (not chat state, so it bypasses the reducer): when a side
  // panel opens, hand Chat + Chats to it and drop to a tool view; when it closes,
  // take chat back to where we were.
  if (msg.type === 'surfaces') { applySidePanelOpen(!!msg.sidePanelOpen); return; }
  const next = reduceChat(currentState, msg);
  if (next === currentState) return;
  currentState = next;
  if (msg.type === 'state') { booted = true; seedDwebApps(); }
  m.redraw();
};
const handlePortDisconnect = () => {
  // SW restart — reset to the locked default (don't show stale "unlocked")
  // and reconnect, mirroring the side panel.
  currentState = INITIAL_STATE;
  booted = false;
  port = null;
  m.redraw();
  setTimeout(connectPort, 200);
};

/**
 * @param {{ type: string } & Record<string, any>} msg
 * @returns {Promise<any>}
 */
const send = (msg) => browser.runtime.sendMessage(msg);

// ---- chat-component uiActions (the subset home needs; no voice) -----------
/** @type {Set<string>} */
const subagentFetchInFlight = new Set();
/** @param {string} sessionId */
const loadSubagent = (sessionId) => {
  if (!sessionId) return;
  if (currentState.subagents.sessions[sessionId]?.messages?.length) return;
  if (subagentFetchInFlight.has(sessionId)) return;
  subagentFetchInFlight.add(sessionId);
  send({ type: 'session/get', sessionId }).then((/** @type {any} */ resp) => {
    subagentFetchInFlight.delete(sessionId);
    if (resp?.ok && resp.session) {
      currentState = putSubagentSession(currentState, resp.session);
      m.redraw();
    }
  }).catch(() => { subagentFetchInFlight.delete(sessionId); });
};
/**
 * @param {string} id
 * @param {string} answer
 */
const confirmAnswer = (id, answer) => {
  send({ type: 'confirm/answer', id, answer });
  currentState = { ...currentState, pendingConfirm: null };
  m.redraw();
};
/** @param {string} id */
const dismissNotice = (id) => {
  currentState = { ...currentState, notices: currentState.notices.filter((/** @type {any} */ n) => n.id !== id) };
  m.redraw();
};
// The grant-debugger nudge's one-click enable (mirrors the side panel): turn on
// advanced automation, then clear (or soften) the notice.
/** @param {string} [noticeId] */
const requestDebugger = async (noticeId) => {
  let ok = false;
  try { ok = !!(await send({ type: 'settings/update', patch: { advancedAutomationEnabled: true } }))?.ok; }
  catch (e) { console.warn('[home] advanced-automation enable failed', e); }
  currentState = ok
    ? { ...currentState, notices: currentState.notices.filter((/** @type {any} */ n) => n.action?.kind !== 'grant-debugger') }
    : (noticeId != null
        ? { ...currentState, notices: currentState.notices.map((/** @type {any} */ n) => (n.id === noticeId
            ? { ...n, text: 'Advanced automation stays off. You can turn it on later in Settings → Advanced.', action: null } : n)) }
        : currentState);
  m.redraw();
  return ok;
};
// "Open ↗" on a "peerd opened a tab" card: focus the agent's background tab AND
// open the side panel — BOTH inside this click gesture, the only moment Chrome
// lets us open the panel (DESIGN-12). A card-opened panel follows you to that
// tab and auto-closes when you come back to home (onVisibility) — UNLESS you'd
// explicitly popped it (sticky). The card itself persists (tracks the live tab).
/**
 * @param {number} tabId
 * @param {number} [windowId]
 */
const openAgentTab = (tabId, windowId) => {
  // Panel FIRST — sidePanel.open() must run synchronously in the click gesture,
  // before any other call, or Chrome drops the activation. Open it in THIS window
  // (where the click is); the agent's tab opened in the same window.
  const wid = homeTab?.windowId ?? windowId;
  try {
    const p = sidePanelApi()?.open?.(wid != null ? { windowId: wid } : { tabId });
    if (p?.catch) p.catch((/** @type {unknown} */ e) => console.warn('[home] open panel failed', e));
  } catch (e) { console.warn('[home] open panel threw', e); }
  try { browser.tabs.update(tabId, { active: true }); } catch (e) { console.warn('[home] focus tab failed', e); }
  // why no dismiss: the agent-tab card PERSISTS after click — it tracks the live
  // agent tab so you can jump back any time; it clears itself when the tab closes.
};
const uiActions = { loadSubagent, confirmAnswer, dismissNotice, requestDebugger, openAgentTab };

// Cache this tab's own window id at boot so "Pop to side" can pass a REAL
// windowId synchronously inside the click gesture — sidePanel.open() rejects
// the WINDOW_ID_CURRENT sentinel, and tabs.getCurrent() is async (too late for
// the gesture).
/** @type {import('webextension-polyfill').Tabs.Tab | null} */
let homeTab = null;
try { browser.tabs?.getCurrent?.()?.then?.((t) => { homeTab = t ?? null; }); }
catch { /* no tabs API in this context */ }

// "Pop the chat to the side" — open the window-global side panel so the chat
// follows across tabs (DESIGN-12). sidePanel.open() needs a user gesture, so
// this MUST run synchronously inside the click handler (no await before it).
const popToSide = () => {
  try {
    if (homeTab?.windowId == null) return; // id not resolved yet — no-op beats a reject
    panelStickyByPop = true;               // explicit pop is STICKY — never auto-closes
    const p = sidePanelApi()?.open?.({ windowId: homeTab.windowId });
    if (p?.catch) p.catch((/** @type {unknown} */ e) => console.warn('[home] sidePanel.open failed', e));
  } catch (e) { console.warn('[home] sidePanel.open threw', e); }
};
// Bring the chat back from the panel into home (the inverse of pop-to-side / the
// "go to tab" card). The panel's own close button does the same.
const bringChatHome = () => send({ type: 'sidepanel/close' });

// Auto-close the side panel when the user RETURNS to the home tab (a hidden →
// visible transition) — UNLESS they explicitly popped it (sticky). So a card-
// opened panel ("watch the agent on its tab") closes when you come back and chat
// renders here again; a "Pop to side" panel STAYS until you bring it back or
// close the sidebar yourself. (Auto-OPENING the panel when the agent creates a
// tab is impossible — Chrome only opens the panel during a user gesture.)
let homeWasHidden = (typeof document !== 'undefined' && document.hidden);
const onVisibility = () => {
  const hidden = document.hidden;
  if (homeWasHidden && !hidden && sidePanelOpen && !panelStickyByPop) send({ type: 'sidepanel/close' });
  homeWasHidden = hidden;
};

// Apply the SW's side-panel-open signal — chat is SINGLE-HOMED: when the panel is
// open it owns Chat + Chats, so home drops to a tool view (stashing where we were
// so closing the panel brings us back). No-op if nothing changed.
/** @param {boolean} open */
function applySidePanelOpen(open) {
  if (open === sidePanelOpen) return;
  sidePanelOpen = open;
  if (open) {
    if (activeView === 'chat') { stashedChatView = activeView; activeView = 'library'; }
  } else {
    panelStickyByPop = false;   // panel closed → stickiness resets
    if (stashedChatView) { activeView = stashedChatView; stashedChatView = null; }
  }
  m.redraw();
}

// Make sure the pre-loaded dwapps (commons) are in the Library. why HERE, not
// the SW: the SW can't load the dweb module or name its path (the dweb
// boundary), but this page can. Gated on DWEB_ENABLED + an unlocked vault.
let seededDweb = false;
const seedDwebApps = async () => {
  if (seededDweb || !DWEB_ENABLED) return;
  if (!currentState?.vault?.initialized || currentState.vault.locked) return;
  seededDweb = true;
  try {
    const client = await loadDweb();
    if (!client.available || !client.loadSeedApp) return;
    const seed = await client.loadSeedApp({
      fetchText: async (p) => {
        // reading our OWN packaged asset over the extension origin — not
        // network egress, so safeFetch is the wrong tool.
        // eslint-disable-next-line no-restricted-globals
        const res = await fetch(p);
        if (!res.ok) throw new Error(`seed ${p}: HTTP ${res.status}`);
        return res.text();
      },
    });
    await browser.runtime.sendMessage({ type: 'dweb/ensure-seed-app', seed });
  } catch (e) { console.debug('[home] dweb seed skipped', e); }
};

// Five-block wordmark — local copy (same construction as the panel/options
// mark). Replays its type→colorize intro each time the tab becomes visible.
const Wordmark = () => {
  /** @type {HTMLElement | null} */
  let el = null;
  const replay = () => {
    if (document.hidden || !el) return;
    el.classList.remove('wordmark--intro');
    void el.offsetWidth;
    el.classList.add('wordmark--intro');
  };
  return {
    oncreate: (/** @type {{ dom: HTMLElement }} */ v) => { el = v.dom; document.addEventListener('visibilitychange', replay); },
    onremove: () => document.removeEventListener('visibilitychange', replay),
    view: () => m('.wordmark.wordmark--intro', { 'aria-label': 'peerd', role: 'img' }, [
      m('.block.b-p', 'p'), m('.block.b-e', 'e'), m('.block.b-e2', 'e'),
      m('.block.b-r', 'r'), m('.block.b-d', 'd'),
      m('.wordmark-cursor', { 'aria-hidden': 'true' }),
    ]),
  };
};

// The pre-boot "Loading…" placeholder. Setup + unlock are NOT a redirect to the
// panel anymore — home is the SPA's primary surface, so it hosts the VaultGate
// itself (below); this is only the brief wait for the first state push.
/**
 * @param {string | null} heading
 * @param {string} copy
 */
const gate = (heading, copy) => m('.options-gate', m('.options-gate-card', [
  m(Wordmark),
  heading ? m('h2', heading) : null,
  m('p', copy),
]));

// The rail's nav items. Chat + Chats are present only when home OWNS the chat
// (no side panel open — single-homed). Discover/Network/Contacts are dweb-only
// (absent on the store build and when the user switches dweb off).
/** @param {boolean} showDweb */
const navItems = (showDweb) => [
  // "Chats" is the top-level rail item; the chat page itself carries the
  // recent-chats list + "New chat" column (ChatListPanel, ChatGPT-style).
  ...(sidePanelOpen ? [] : [{ id: 'chat', label: 'Chats' }]),
  { id: 'library', label: 'Library' },
  ...(showDweb ? [
    { id: 'discover', label: 'Discover' },
    { id: 'contacts', label: 'Contacts' },
  ] : []),
  // Lab sits next-to-last, just before Network (when the dweb group is present).
  { id: 'eval', label: 'Lab' },
  ...(showDweb ? [{ id: 'network', label: 'Network' }] : []),
];

// The chat switcher — Chats live INSIDE the chat page (owner 2026-06-18): the
// current chat's title + a dropdown of all chats and "+ New chat". Switching is
// session/switch; new is session/reset. The composer draft is preserved per-chat
// (input-bar), so a half-typed message survives a switch or a click-away.
/** @param {number} [ms] */
const fmtAgo = (ms) => {
  if (typeof ms !== 'number' || !ms) return '';
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d`;
  try { return new Date(ms).toLocaleDateString(); } catch { return ''; }
};

// The recent-chats list column (ChatGPT-style): "+ New chat" + every chat,
// newest-active first. Lives to the LEFT of the chat, off the rail. Selecting a
// chat switches the SW session; "New chat" resets to a fresh one. Refreshed on
// a light interval so a freshly-titled chat (the agent titles it) updates.
const ChatListPanel = () => {
  /** @type {any[] | null} */
  let sessions = null;
  /** @type {ReturnType<typeof setInterval> | number} */
  let timer = 0;
  /** @type {string | null} */
  let deletingId = null;   // the row currently playing its delete animation
  const load = () => send({ type: 'session/list' })
    .then((/** @type {any} */ r) => { if (r?.ok) { sessions = r.sessions ?? []; m.redraw(); } }).catch(() => {});
  // Animate the row out, THEN archive it (a deleted chat leaves the list). If it
  // was the current chat, drop into a fresh one so the view isn't left on a
  // now-deleted session.
  /**
   * @param {string} sessionId
   * @param {boolean} isCurrent
   */
  const deleteChat = (sessionId, isCurrent) => {
    if (deletingId) return;
    deletingId = sessionId;
    m.redraw();
    setTimeout(async () => {
      try {
        await send({ type: 'session/archive', sessionId });
        if (isCurrent) await send({ type: 'session/reset' });
      } catch (e) { console.warn('[home] delete chat failed', e); }
      deletingId = null;
      load();
    }, 340);   // ≈ the reverse-type backspace (190ms) + row collapse (130ms)
  };
  return {
    oninit: load,
    oncreate() { timer = setInterval(() => { if (!document.hidden) load(); }, 5000); },
    onremove() { if (timer) clearInterval(timer); },
    /** @param {{ attrs: { state: any } }} vnode */
    view: ({ attrs: { state } }) => {
      const cur = state.session?.sessionId;
      const visible = (sessions ?? []).filter((/** @type {any} */ s) => !s.archived)
        .sort((/** @type {any} */ a, /** @type {any} */ b) => (b.lastMessageAt ?? b.createdAt ?? 0) - (a.lastMessageAt ?? a.createdAt ?? 0));
      return m('.chat-list', [
        m('.chat-list-head', [
          m('span.chat-list-head-title', 'Chats'),
          m('button.chat-list-toggle', { title: 'Hide chats', 'aria-label': 'Hide chats', onclick: toggleChatList }, '«'),
        ]),
        m('button.chat-list-new', { onclick: async () => { await send({ type: 'session/reset' }); load(); } }, '＋ New chat'),
        m('.chat-list-items', visible.length
          ? visible.map((/** @type {any} */ s) => m('.chat-list-item', {
              key: s.sessionId,
              class: [s.sessionId === cur ? 'is-active' : '', deletingId === s.sessionId ? 'is-deleting' : ''].filter(Boolean).join(' '),
              role: 'button', tabindex: '0',
              onclick: () => { if (deletingId || s.sessionId === cur) return; send({ type: 'session/switch', sessionId: s.sessionId }).then(load); },
            }, [
              m('.chat-list-item-title', (s.title && s.title.trim()) || 'New chat'),
              m('.chat-list-item-meta', fmtAgo(s.lastMessageAt ?? s.createdAt)),
              // Hover affordance: a 3-dot that turns into a red trash; click deletes.
              m('button.chat-item-del', {
                title: 'Delete chat', 'aria-label': 'Delete chat',
                onclick: (/** @type {Event} */ e) => { e.stopPropagation(); deleteChat(s.sessionId, s.sessionId === cur); },
              }),
            ]))
          : m('.chat-list-empty.muted', 'No chats yet.')),
      ]);
    },
  };
};

// peerd notifications bell (rail): unseen count + a dropdown of new peers / apps,
// each linking to Network / Discover. Subscribes to the shared feed so a live
// event redraws the badge wherever you are.
const NotificationsBell = () => {
  let open = false;
  /** @type {(() => void) | null} */
  let offSub = null;
  /** @type {((e: MouseEvent) => void) | null} */
  let onDoc = null;
  return {
    oncreate() {
      offSub = peerNotifications.subscribe(() => m.redraw());
      onDoc = (e) => { if (open && !(/** @type {Element} */ (e.target)).closest('.notif')) { open = false; m.redraw(); } };
      document.addEventListener('mousedown', onDoc);
    },
    onremove() { offSub?.(); if (onDoc) document.removeEventListener('mousedown', onDoc); },
    view() {
      const items = peerNotifications.list();
      const unseen = peerNotifications.unseen();
      return m('.notif', [
        m('button.home-nav-item.notif-bell', {
          'aria-expanded': String(open),
          onclick: () => { open = !open; if (open) peerNotifications.markAllSeen(); },
        }, [
          m('span', '🔔 Notifications'),
          unseen ? m('span.notif-badge', String(unseen > 9 ? '9+' : unseen)) : null,
        ]),
        open ? m('.notif-menu', items.length
          ? items.map((n) => m('button.notif-item', {
              key: n.id,
              onclick: () => { open = false; setView(n.link); m.redraw(); },
            }, [m('.notif-item-title', n.title), m('.notif-item-body', n.body)]))
          : m('.notif-empty.muted', 'Nothing yet. New peers and apps show up here.')) : null,
      ]);
    },
  };
};

// The newest notification, surfaced as a banner in the chat — "in the chat" per
// the owner ask. View navigates to Network / Discover; × clears it.
/** @param {import('/shared/peer-notifications.js').PeerNotification} n */
const notifBanner = (n) => m('.notif-banner', [
  m('span.notif-banner-text', [m('strong', n.title), n.body ? ` — ${n.body}` : '']),
  m('button.home-popout', {
    onclick: () => { setView(n.link); peerNotifications.dismiss(n.id); },
  }, n.link === 'discover' ? 'View in Discover' : 'View network'),
  m('button.notif-banner-x', { 'aria-label': 'Dismiss', onclick: () => peerNotifications.dismiss(n.id) }, '×'),
]);

/** @param {boolean} showDweb */
const content = (showDweb) => {
  // Defensive: if a panel opened while the chat view was somehow still active, say
  // where the chat went rather than render a second live chat (single-homed).
  if (activeView === 'chat' && sidePanelOpen) {
    return m('.home-chat', m('.peerd-net-empty', { style: 'margin:48px 16px;' },
      'Chat is open in the side panel. Close the panel to bring it back here.'));
  }
  if (activeView === 'chat') {
    // ChatGPT-style: a recent-chats column on the left, the live chat on the
    // right. Collapsible — when hidden it's a thin strip with new-chat + expand.
    return m('.home-chat-layout', [
      chatListCollapsed
        ? m('.chat-list.is-collapsed', [
            m('button.chat-list-toggle', { title: 'Show chats', 'aria-label': 'Show chats', onclick: toggleChatList }, '»'),
            m('button.chat-list-toggle', { title: 'New chat', 'aria-label': 'New chat', onclick: async () => { await send({ type: 'session/reset' }); } }, '＋'),
          ])
        : m(ChatListPanel, { state: currentState }),
      m('.home-chat', [
        m('.home-chat-bar', [
          m('span.home-chat-title', (currentState.session?.title && currentState.session.title.trim()) || 'New chat'),
          m('.spacer', { style: 'flex:1;' }),
          sidePanelApi() ? m('button.home-popout.home-popout--pop', {
            title: 'Open this chat in the side panel — it follows you to the tab the agent opens',
            onclick: popToSide,
          }, 'Pop to side ⇥') : null,
        ]),
        // Newest peerd notification, surfaced in the chat.
        peerNotifications.list()[0] ? notifBanner(peerNotifications.list()[0]) : null,
        m(ChatView, { state: currentState, send, voiceManager: undefined, uiActions, surface: 'home' }),
      ]),
    ]);
  }
  if (activeView === 'library') return m(LibrarySection, { send, dweb: showDweb });
  if (activeView === 'eval') return m(EvalSection, { send });
  if (activeView === 'discover' && showDweb) return m(DiscoverSection, { send });
  if (activeView === 'contacts' && showDweb) return m(ContactsSection, { send });
  if (activeView === 'network' && showDweb) return m(NetworkSection, { send });
  return null;
};

const HomeApp = {
  view() {
    if (!booted) return gate(null, 'Loading…');
    // Set up / unlock the vault RIGHT HERE — home is the SPA's primary surface, so
    // it hosts the same VaultGate the side panel does (passkey + passphrase, first-
    // run + unlock). Both are equal live surfaces (DESIGN-12): unlocking here pushes
    // state to every open surface, and the page flips into the app the moment it
    // succeeds. Wrapped in .options-gate so it sits in the upper third (home.css).
    if (!currentState.vault?.initialized || currentState.vault.locked) {
      return m('.options-gate', m(VaultGate, { state: currentState, send }));
    }

    const showDweb = DWEB_ENABLED && currentState.settings?.dwebEnabled;
    const items = navItems(showDweb);
    // Keep activeView valid if it vanished from the rail (dweb switched off, or the
    // side panel took Chat/Chats). Fall back to the FIRST available item — which is
    // Library when the panel owns chat, Chat otherwise — never a dead view.
    if (!items.some((it) => it.id === activeView)) activeView = items[0]?.id ?? 'library';

    const rail = m('nav.home-rail', [
      // Brand cluster: wordmark + preview badge below it, flush-left + aligned
      // (matches the side-panel header — both left-hug, no centering).
      m('.home-rail-mark', [
        m(Wordmark),
        CHANNEL === 'preview'
          ? m('span.channel-badge.channel-badge--in', { title: 'peerd preview — dweb preview package' }, 'preview')
          : null,
      ]),
      m('.home-nav', items.map((it) =>
        m('button.home-nav-item', {
          key: it.id,
          class: it.id === activeView ? 'is-active' : '',
          onclick: () => { setView(it.id); },
        }, it.label))),
      m('.spacer', { style: 'flex:1;' }),
      // peerd notifications — new peers / apps on the dweb (preview only).
      showDweb ? m(NotificationsBell) : null,
      // Manual lock — for stepping away. The SW pushes the locked state, which
      // flips home back to the vault gate.
      m('button.home-nav-item', { onclick: () => send({ type: 'vault/lock' }) }, '🔒 Lock'),
      m('button.home-nav-item', { onclick: () => openOptions() }, '⚙ Settings'),
    ]);

    return [
      m('.home-shell', [
        rail,
        m('main.home-content', { class: `home-content--${activeView}` }, [
          // System notices (/init progress, the grant-debugger nudge) — the SW
          // broadcasts these to every surface (DESIGN-12), so home must render
          // them too, not just the side panel's App.
          currentState.notices?.length
            ? m(NoticeBar, { notices: currentState.notices, uiActions })
            : null,
          // Chat is single-homed: when the side panel owns it, home shows tools
          // only — so give an obvious way to bring chat back (the inverse of
          // "Pop to side", since that button rode away with the chat). Closing
          // the sidebar yourself does the same.
          sidePanelOpen
            ? m('.home-panel-bar', [
                m('span', 'Chat is in the side panel.'),
                m('button.home-popout', { onclick: bringChatHome }, 'Bring it here ⇤'),
              ])
            : null,
          content(showDweb),
        ]),
      ]),
      // The agent's permission prompt — broadcast to every open surface
      // (DESIGN-12); render it here so it's answerable from home too.
      currentState.pendingConfirm
        ? m(ConfirmModal, { prompt: currentState.pendingConfirm, uiActions })
        : null,
    ];
  },
};

connectPort();
document.addEventListener('visibilitychange', onVisibility);
// A deep-link to an ALREADY-open home tab (openHome('library') focusing this
// tab) changes only the fragment — no reload — so honor it via hashchange too,
// then clear the fragment so it stays a one-shot jump.
window.addEventListener('hashchange', () => {
  const v = viewFromHash();
  clearHash();
  if (v && v !== activeView) { setView(v); m.redraw(); }
});
const root = document.getElementById('app');
if (!root) throw new Error('home: #app missing from HTML');
m.mount(root, HomeApp);
