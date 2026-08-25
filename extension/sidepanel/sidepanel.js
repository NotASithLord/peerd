// @ts-check
// Side-panel entry point.
//
// Wires up:
//   - The long-lived port to the SW (for state push + streaming events)
//   - The Mithril router and top-level mount
//   - The one-shot sendMessage helper for user actions
//
// All business logic lives in the SW. This file is a projection of SW
// state. User actions emit messages; SW reduces; SW emits new state; we
// re-render. Streaming deltas patch in place via a small reducer so we
// don't refetch the whole session shape per token.

import m from '/vendor/mithril/mithril.js';
import browser from '/shared/browser-api.js';
import { makeUiStatePort } from '/shared/cold-port-recovery.js';
import {
  makeReconciledUiSender, makeUiRuntimeClient, redrawForRuntimeMessage,
} from '/shared/ui-runtime-client.js';
import { App } from './components/app.js';
import { makeConfirmationAnswer } from './confirmation-answer.js';
import { classifyBrowserAutomationTarget, createVoiceManager } from '/peerd-runtime/ui.js';
import { findDenylistMatch } from '/peerd-egress/ui.js';
import {
  INITIAL_STATE, putSpawnedSession, reduceChat, resetChatAfterRuntimeLoss,
} from './chat-reducer.js';
import { eventBelongsToSidepanelWindow, focusBrowserTab } from './tab-context.js';

/** @typedef {import('./chat-reducer.js').ChatState} ChatState */
/** @typedef {import('./chat-reducer.js').ReducerMsg} ReducerMsg */

/** @type {ChatState} */
let currentState = INITIAL_STATE;

// The shared state Port owns transport/recycle; this surface only folds events.
/** @param {unknown} raw @returns {boolean} */
const handlePortMessage = (raw) => {
  const msg = /** @type {ReducerMsg & { ok?: boolean }} */ (raw);
  if (!msg || typeof msg.type !== 'string') return false;
  // Voice events are side-panel-only — the voice manager lives HERE; route
  // them to its subscribers (they don't touch chat state). On a successful
  // permission grant, clear any sticky mic error so the UI resets.
  if (msg.type.startsWith('voice/')) {
    if (msg.type === 'voice/permission-result' && msg.ok) voiceManager?.clearError?.();
    for (const h of voicePortSubscribers) {
      try { h(msg); } catch (e) { console.error('[sidepanel] voice subscriber threw', e); }
    }
    return true;
  }
  // Everything else folds through the shared pure reducer (DESIGN-12) so home
  // and the side panel stay byte-identical projections of the SW session.
  // §4e: a confirm settle carries WHICH surface answered; the reducer needs to
  // know which surface it is folding FOR, so the answering surface doesn't
  // transcript-line its own click.
  const folded = msg.type === 'confirm/resolved' ? { ...msg, confirmSurface: 'sidepanel' } : msg;
  const next = reduceChat(currentState, folded);
  if (next === currentState) return msg.type === 'state'; // guarded bail / live complement
  currentState = next;
  // Side-panel-only: the voice manager doesn't survive the panel, so re-enable
  // it on a full snapshot when the persisted setting says it was on.
  if (msg.type === 'state') maybeRestoreVoice(currentState);
  redrawForRuntimeMessage(m.redraw, msg);
  return true;
};

const resetAfterDisconnect = () => {
  console.warn('[sidepanel] SW port disconnected — reconnecting');
  currentState = resetChatAfterRuntimeLoss(currentState);
  m.redraw();
  actorFetchInFlight.clear();
};

const uiRuntime = makeUiRuntimeClient({ browser });
const statePort = makeUiStatePort({
  browser,
  name: 'sidepanel',
  isHydrated: () => currentState.hydrated,
  onMessage: handlePortMessage,
  onDisconnect: resetAfterDisconnect,
  onStatusChange: () => m.redraw(),
});
const reconcileState = () => statePort.reconcile(() => uiRuntime.send({ type: 'state/get' }));
const send = makeReconciledUiSender({
  send: (/** @type {any} */ msg) => uiRuntime.send(msg),
  fold: () => {}, reconcile: reconcileState, afterReply: () => false,
});

// Lazy-load an actor session for a nested transcript. Used when the
// user expands an actor_create card whose child wasn't streamed live
// (e.g. after a side-panel reload). Deduped by an in-flight set so a
// re-expand mid-fetch doesn't fire a second request.
/** @type {Set<string>} */
const actorFetchInFlight = new Set();
/** @param {string} sessionId @param {boolean} [retry] */
const loadActor = (sessionId, retry = false) => {
  if (!sessionId) return;
  const current = currentState.spawned.sessions[sessionId];
  if (current?.messages?.length || (!retry && current?.loadError)) return;
  if (actorFetchInFlight.has(sessionId)) return;
  actorFetchInFlight.add(sessionId);
  send({ type: 'session/get', sessionId }).then((resp) => {
    actorFetchInFlight.delete(sessionId);
    if (resp?.ok && resp.session) {
      currentState = putSpawnedSession(currentState, { ...resp.session, loadError: undefined });
    } else {
      currentState = putSpawnedSession(currentState, {
        sessionId, messages: [], loadError: resp?.error ?? 'Temporarily unavailable. Try again.',
      });
    }
    m.redraw();
  }).catch(() => {
    actorFetchInFlight.delete(sessionId);
    currentState = putSpawnedSession(currentState, {
      sessionId, messages: [], loadError: 'Temporarily unavailable. Try again.',
    });
    m.redraw();
  });
};

// Reentry guard for voice auto-restore so a chatty state push doesn't
// fire enable() ten times. Cleared back to null on disable so a future
// re-enable triggers it again.
let voiceRestoreAttempted = false;
/** @param {ChatState} state */
const maybeRestoreVoice = (state) => {
  // why: only restore once per side-panel mount. If the user disables
  // voice and re-enables, that path goes through settings → voiceManager
  // directly and doesn't need this guard.
  if (voiceRestoreAttempted) return;
  // why: don't auto-enable voice during the lock screen; the user
  // expects the mic to appear after they unlock, not before.
  if (!state?.vault?.initialized || state?.vault?.locked) return;
  if (!state?.settings?.voiceEnabled) return;
  if (!voiceManager) return;
  if (voiceManager.getState().status !== 'idle') return;
  voiceRestoreAttempted = true;
  // why: enable() coerces any stored variant to the single shipped model,
  // so we just hand it whatever's persisted (an old install may carry a
  // bogus 'small') — no fallback literal that could itself be wrong.
  voiceManager.enable({
    variant: state.settings.voiceVariant,
    engine: /** @type {'auto'|'web-speech'|'moonshine'|undefined} */ (state.settings.voiceEngine),
  }).catch((/** @type {unknown} */ e) => {
    // The settings.voiceEnabled flag stays true; the manager's state
    // carries the error so the UI can surface it. No need to flip the
    // persisted setting — the user explicitly opted in, and a transient
    // failure shouldn't lose that intent.
    console.warn('[sidepanel] voice restore failed', /** @type {{ message?: string }} */ (e)?.message ?? e);
  });
};

// ---------- voice manager (lives in the side panel) ------------------------
//
// The manager is a per-side-panel-lifetime singleton. It uses runtime
// sendMessage for outbound (the offscreen doc handles the dispatch)
// and a tiny pub/sub layer over our port subscribers for inbound
// voice/chunk + voice/auto-stop pushes (the SW forwards those to the
// port we already hold).

/** @type {Set<(msg: any) => void>} */
const voicePortSubscribers = new Set();
/** @param {(msg: any) => void} handler */
const onVoiceMessage = (handler) => {
  voicePortSubscribers.add(handler);
  return () => voicePortSubscribers.delete(handler);
};
const voiceManager = createVoiceManager({
  send,
  onMessage: onVoiceMessage,
  moonshineHostAvailable: () => currentState?.capabilities?.moonshineVoiceHost?.status === 'available',
});

// Global ESC: stop voice anywhere in the side panel. Lower priority
// than form-local handlers (those run before document-level events
// can intercept). The directive calls this out explicitly — the user
// should never have to hunt for the mic button to stop listening.
/** @param {KeyboardEvent} e */
const onGlobalKeydown = (e) => {
  if (e.key !== 'Escape') return;
  if (!voiceManager.isListening()) return;
  voiceManager.stop().catch(() => {});
};

const root = document.getElementById('app');
if (!root) throw new Error('sidepanel: #app missing from HTML');

const confirmAnswer = makeConfirmationAnswer({
  send,
  reconcile: reconcileState,
  getState: () => currentState,
  setState: (/** @type {ChatState} */ state) => { currentState = state; },
  redraw: () => m.redraw(),
});

// Dismiss a transient system notice (e.g. an /init progress banner).
/** @param {number} id */
const dismissNotice = (id) => {
  currentState = { ...currentState, notices: currentState.notices.filter((n) => n.id !== id) };
  m.redraw();
};

// Turn advanced automation on from the nudge. This flips the
// advancedAutomationEnabled SETTING — the `debugger` permission itself is
// required at install (Chrome refuses to list it as optional), so no
// permission ceremony or user-gesture plumbing is involved. On success we
// clear the nudge; on failure we leave a short note.
/** @param {number} [noticeId] */
const requestDebugger = async (noticeId) => {
  let ok = false;
  try {
    const r = await send({ type: 'settings/update', patch: { advancedAutomationEnabled: true } });
    ok = !!r?.ok;
  } catch (e) {
    console.warn('[sidepanel] advanced-automation enable failed', e);
  }
  if (ok) {
    currentState = {
      ...currentState,
      notices: currentState.notices.filter((n) => n.action?.kind !== 'grant-debugger'),
    };
  } else if (noticeId != null) {
    currentState = {
      ...currentState,
      notices: currentState.notices.map((n) => (n.id === noticeId
        ? { ...n, text: 'Advanced automation stays off. You can turn it on later in Settings → Advanced.', action: null }
        : n)),
    };
  }
  m.redraw();
  return ok;
};

// "Open ↗" on the agent-tab card activates the tab and focuses its window.
// The card persists until that live agent tab closes.
/** @param {number} tabId @param {number|undefined} windowId */
const openAgentTab = async (tabId, windowId) => {
  const focused = await focusBrowserTab(browser, tabId, windowId);
  if (!focused) console.warn('[sidepanel] focus tab failed');
};

// A card action types the user's likely next message INTO the composer (§4c) -
// it never sends. The nonce makes each click a fresh one-shot for the InputBar
// to consume; the user edits or discards like any draft.
let prefillNonce = 0;
/** @param {string} text */
const prefillComposer = (text) => {
  if (typeof text !== 'string' || !text.trim()) return;
  prefillNonce += 1;
  currentState = { ...currentState, composerPrefill: { text, nonce: prefillNonce } };
  m.redraw();
};
const uiActions = { loadActor, confirmAnswer, dismissNotice, requestDebugger, openAgentTab, prefillComposer };

// ---- brand hand-off: is the options tab the active one? -------------------
//
// Explicit, independently-tracked state (NOT derived from the router): when
// the user opens Settings, the options page becomes the active tab in this
// window. Surfacing that lets the brand wordmark hand off across the two
// surfaces — it plays its reverse "self-delete" in the panel while options is
// foregrounded, and renders back in when you leave. Best-effort: any tabs-API
// gap simply leaves the logo present (fail-safe — never permanently gone).
// Hand off to ANY peerd full-tab surface — the options page AND the
// home/Library page — so the panel mark self-deletes whenever one is
// foregrounded and renders back when you leave.
const FULLPAGE_URLS = (() => {
  try {
    return [
      browser.runtime.getURL('options/options.html'),
      browser.runtime.getURL('home/home.html'),
    ];
  } catch { return []; }
})();
let optionsActive = false;
// The fresh-chat starter distinguishes a public page from a policy-protected
// page without carrying its address into UI state. Unknown is intentionally not
// summarizable: a failed denylist read must not advertise work the host may
// refuse when the user clicks it.
/** @typedef {'none'|'unknown'|'web'|'protected_private'|'protected_sensitive'} ActiveTabStatus */
/** @type {ActiveTabStatus} */
let activeTabStatus = 'none';
let activeTabRefreshGeneration = 0;
/** @type {number|null} */
let sidepanelWindowId = null;
const resolveSidepanelWindowId = async () => {
  if (Number.isInteger(sidepanelWindowId)) return sidepanelWindowId;
  try {
    const current = await browser.windows?.getCurrent?.();
    if (typeof current?.id === 'number' && Number.isInteger(current.id)) {
      sidepanelWindowId = current.id;
      return sidepanelWindowId;
    }
  } catch { /* fall through to the tab-scoped lookup */ }
  try {
    const current = (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    if (typeof current?.windowId === 'number' && Number.isInteger(current.windowId)) {
      sidepanelWindowId = current.windowId;
    }
  } catch { /* the caller keeps the fail-safe unknown state */ }
  return sidepanelWindowId;
};
/**
 * @param {number|null} [preferredTabId]
 * @param {number|null} [eventWindowId]
 */
const refreshOptionsActive = async (preferredTabId = null, eventWindowId = null) => {
  if (!FULLPAGE_URLS.length || !browser.tabs?.query) return;
  const windowId = await resolveSidepanelWindowId();
  if (!eventBelongsToSidepanelWindow(windowId, eventWindowId)) return;
  const generation = ++activeTabRefreshGeneration;
  try {
    const tab = typeof preferredTabId === 'number' && browser.tabs?.get
      ? await browser.tabs.get(preferredTabId)
      : (await browser.tabs.query(typeof windowId === 'number'
        ? { active: true, windowId }
        : { active: true, currentWindow: true }))[0];
    if (Number.isInteger(windowId) && Number.isInteger(tab?.windowId)
        && tab.windowId !== windowId) return;
    const url = tab?.url;
    const next = !!(url && FULLPAGE_URLS.some((u) => url.startsWith(u)));
    /** @type {ActiveTabStatus} */
    let nextStatus = 'none';
    if (url && /^https?:\/\//i.test(url)) {
      const verdict = classifyBrowserAutomationTarget(url);
      if (!verdict.allowed) {
        nextStatus = verdict.reason === 'private_network' || verdict.reason === 'cloud_metadata'
          ? 'protected_private'
          : 'none';
      } else {
        nextStatus = 'unknown';
        try {
          const snapshot = await send({ type: 'denylist/list' });
          if (snapshot?.ok && Array.isArray(snapshot.patterns)) {
            const hostname = new URL(url).hostname;
            nextStatus = findDenylistMatch(hostname, snapshot.patterns)
              ? 'protected_sensitive'
              : 'web';
          }
        } catch { /* keep the fail-safe unknown state */ }
      }
    }
    // A tab switch can finish while the denylist request is in flight. Only the
    // latest refresh may update what the starter offers.
    if (generation !== activeTabRefreshGeneration) return;
    if (next !== optionsActive || nextStatus !== activeTabStatus) {
      optionsActive = next;
      activeTabStatus = nextStatus;
      // The harness hosts this surface in a tab, where switching foreground
      // tabs can throttle animation-frame redraws. A synchronous redraw also
      // keeps the real side panel's page-aware starter current immediately.
      m.redraw.sync();
    }
  } catch {
    if (generation === activeTabRefreshGeneration && activeTabStatus !== 'unknown') {
      activeTabStatus = 'unknown';
      m.redraw.sync();
    }
  }
};
/** @param {{ tabId: number, windowId: number }} info */
const onTabActivated = (info) => refreshOptionsActive(info.tabId, info.windowId);
/** @param {number} _tabId @param {{ windowId?: number }} info */
const onTabRemoved = (_tabId, info) => refreshOptionsActive(null, info?.windowId);
/** @param {number} tabId @param {{ url?: string, status?: string }} info @param {any} tab */
const onTabUpdated = (tabId, info, tab) => {
  if (tab?.active && info && (info.url || info.status === 'complete')) {
    refreshOptionsActive(tabId, tab.windowId);
  }
};
/** @param {number} windowId */
const onWindowFocusChanged = (windowId) => refreshOptionsActive(null, windowId);

/** @param {string} view */
const routeArgs = (view) => ({
  state: currentState, send, voiceManager, uiActions, view, optionsActive,
  activeTabStatus, stateFailed: statePort.failed, retryState: statePort.retry,
});

// First-run onboarding is NOT gated here — it lives on the HOME page as a
// blocker (home.js needsOnboarding gate). The side panel is reached by popping
// it from an already-onboarded home, so routing it through onboarding too only
// caused a surprise trigger when the panel opened after home use.

// why only two routes: settings + context (memory/activity/denylist/
// skills/hooks) moved to the full-tab options page — the panel is the
// pure conversation surface. The old /settings, /skills, and /logs
// routes died with their views; pre-release means no alias shims
// (docs/DECISIONS.md #17).
//
// why ONE shared component for both routes: it's a SPA and the header
// doesn't change between /chat and /chats. Mapping each route to its own
// inline {view} object made Mithril tear down + recreate App on every
// switch (remounting the TopBar, replaying the wordmark intro). Pointing
// both routes at the SAME `Root` component makes Mithril DIFF in place —
// the header (and its one-time wordmark animation) persists; only the
// `.body` view swaps. The active view is read from the route inside Root.
const Root = {
  view: () => {
    const path = m.route.get();
    return m(App, routeArgs(path.startsWith('/chats') ? 'chats' : 'chat'));
  },
};
let started = false;
export const startSidepanel = () => {
  if (started) return;
  if (document.documentElement.dataset.peerdBootStage === 'failed') return;
  started = true;
  statePort.start();
  document.addEventListener('keydown', onGlobalKeydown);
  if (browser.tabs?.onActivated) {
    browser.tabs.onActivated.addListener(onTabActivated);
    browser.tabs.onRemoved?.addListener(onTabRemoved);
    browser.tabs.onUpdated?.addListener(onTabUpdated);
    browser.windows?.onFocusChanged?.addListener(onWindowFocusChanged);
    refreshOptionsActive();
  }
  m.route(root, '/chat', { '/chat': Root, '/chats': Root });
};
