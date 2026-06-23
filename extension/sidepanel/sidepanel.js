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
import browser from '/vendor/browser-polyfill.js';
import { App } from './components/app.js';
import { createVoiceManager } from '/peerd-runtime/index.js';
import { INITIAL_STATE, reduceChat, putSubagentSession } from './chat-reducer.js';

/** @typedef {import('./chat-reducer.js').ChatState} ChatState */
/** @typedef {import('./chat-reducer.js').ReducerMsg} ReducerMsg */

/** @type {ChatState} */
let currentState = INITIAL_STATE;

// Long-lived port to the SW. We keep `port` rebindable so we can
// reconnect after a SW restart (extension reload, 30s-idle timeout
// before the offscreen keepalive spawns, browser crash recovery, ...).
// On disconnect, we reset our local state to the locked-vault default
// — otherwise the UI would show a stale "unlocked" state after a SW
// restart, and the user's next action would fail confusingly.
let port = null;
const connectPort = () => {
  port = browser.runtime.connect({ name: 'sidepanel' });
  port.onMessage.addListener(handlePortMessage);
  port.onDisconnect.addListener(handlePortDisconnect);
};


/** @param {unknown} raw */
const handlePortMessage = (raw) => {
  const msg = /** @type {ReducerMsg & { ok?: boolean }} */ (raw);
  if (!msg || typeof msg.type !== 'string') return;
  // Voice events are side-panel-only — the voice manager lives HERE; route
  // them to its subscribers (they don't touch chat state). On a successful
  // permission grant, clear any sticky mic error so the UI resets.
  if (msg.type.startsWith('voice/')) {
    if (msg.type === 'voice/permission-result' && msg.ok) voiceManager?.clearError?.();
    for (const h of voicePortSubscribers) {
      try { h(msg); } catch (e) { console.error('[sidepanel] voice subscriber threw', e); }
    }
    return;
  }
  // Everything else folds through the shared pure reducer (DESIGN-12) so home
  // and the side panel stay byte-identical projections of the SW session.
  const next = reduceChat(currentState, msg);
  if (next === currentState) return; // guarded bail / live complement — nothing changed
  currentState = next;
  // Side-panel-only: the voice manager doesn't survive the panel, so re-enable
  // it on a full snapshot when the persisted setting says it was on.
  if (msg.type === 'state') maybeRestoreVoice(currentState);
  m.redraw();
};

const handlePortDisconnect = () => {
  console.warn('[sidepanel] SW port disconnected — reconnecting');
  // Pessimistically assume any in-memory unlocked state is stale: the
  // SW just died, taking its vault DK with it. Show the lock screen
  // until we get a fresh state push.
  currentState = {
    ...currentState,
    // why: prfEnrolled is kept across the disconnect — it's a persistent
    // vault property, not a session one, so the Touch ID button shouldn't
    // flicker away while we reconnect.
    vault: { ...currentState.vault, locked: true, unlockedAt: 0 },
    providers: { ...currentState.providers, hasKey: false },
    lastError: null,
    // why reset these: they are SW-OWNED ephemeral projections. The SW just
    // died with its confirm coordinator, turn slots, ralph/goal drivers and
    // notice queue — so a stale confirm modal (now UNANSWERABLE: the coordinator
    // that owned the prompt is gone), rate-limit banner, Stop spinner, notice,
    // or goal-run pill would linger with nothing behind it. Reset to the
    // INITIAL_STATE defaults; a revived SW replays anything genuinely still live
    // via getPending() + the fresh state push.
    pendingConfirm: null,
    rateLimit: null,
    streaming: false,
    notices: INITIAL_STATE.notices,
    goalRuns: INITIAL_STATE.goalRuns,
  };
  m.redraw();
  port = null;
  // Small backoff to avoid tight-looping if the SW is unhealthy.
  // Reconnecting also revives the SW, which then pushes a fresh state.
  setTimeout(connectPort, 200);
};

connectPort();

/**
 * One-shot sendMessage for typed request/response.
 * @param {object} msg
 * @returns {Promise<any>}
 */
const send = (msg) => browser.runtime.sendMessage(msg);

// Lazy-load a subagent session for a nested transcript. Used when the
// user expands a spawn_subagent card whose child wasn't streamed live
// (e.g. after a side-panel reload). Deduped by an in-flight set so a
// re-expand mid-fetch doesn't fire a second request.
/** @type {Set<string>} */
const subagentFetchInFlight = new Set();
/** @param {string} sessionId */
const loadSubagent = (sessionId) => {
  if (!sessionId) return;
  if (currentState.subagents.sessions[sessionId]?.messages?.length) return;
  if (subagentFetchInFlight.has(sessionId)) return;
  subagentFetchInFlight.add(sessionId);
  send({ type: 'session/get', sessionId }).then((resp) => {
    subagentFetchInFlight.delete(sessionId);
    if (resp?.ok && resp.session) {
      currentState = putSubagentSession(currentState, resp.session);
      m.redraw();
    }
  }).catch(() => { subagentFetchInFlight.delete(sessionId); });
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
});

// Global ESC: stop voice anywhere in the side panel. Lower priority
// than form-local handlers (those run before document-level events
// can intercept). The directive calls this out explicitly — the user
// should never have to hunt for the mic button to stop listening.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!voiceManager.isListening()) return;
  voiceManager.stop().catch(() => {});
});

const root = document.getElementById('app');
if (!root) throw new Error('sidepanel: #app missing from HTML');

// UI-only state actions. Distinct from `send` (which posts to the SW);
// these mutate side-panel-local state and trigger a redraw.
// (VM management actions were removed with the chip — VM tabs live in
// the Chrome tab strip; agent vm_* tools do everything else.)
// Answer a pending confirmation prompt: post the user's choice to the SW
// (which resolves the dispatcher's waiting Promise) and clear the prompt
// locally so the modal dismisses immediately.
/**
 * @param {string} id
 * @param {string} answer
 */
const confirmAnswer = (id, answer) => {
  send({ type: 'confirm/answer', id, answer });
  currentState = { ...currentState, pendingConfirm: null };
  m.redraw();
};

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

// "Open ↗" on the agent-tab card: focus the agent's background tab. The side
// panel is already open and window-global, so it just follows you there — focus
// is all that's needed. The card persists (it tracks the live agent tab and
// clears when that tab closes).
/** @param {number} tabId */
const openAgentTab = (tabId) => {
  try { browser.tabs.update(tabId, { active: true }); } catch (e) { console.warn('[sidepanel] focus tab failed', e); }
};
const uiActions = { loadSubagent, confirmAnswer, dismissNotice, requestDebugger, openAgentTab };

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
// Is the tab next to the panel a real, summarizable web page (an http(s) page,
// not peerd's own home/options tab, a chrome:// page, or the new-tab page)? The
// fresh-chat "Browse" starter uses this to offer "summarize the current page"
// over the generic Hacker News demo — same active-tab read, so it rides the
// same listeners below.
let activeTabIsWeb = false;
const refreshOptionsActive = async () => {
  if (!FULLPAGE_URLS.length || !browser.tabs?.query) return;
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url;
    const next = !!(url && FULLPAGE_URLS.some((u) => url.startsWith(u)));
    const nextWeb = !!(url && /^https?:\/\//i.test(url));
    if (next !== optionsActive || nextWeb !== activeTabIsWeb) {
      optionsActive = next; activeTabIsWeb = nextWeb; m.redraw();
    }
  } catch { /* leave state as-is — fail-safe keeps the logo present */ }
};
if (browser.tabs?.onActivated) {
  browser.tabs.onActivated.addListener(refreshOptionsActive);
  browser.tabs.onRemoved?.addListener(refreshOptionsActive);
  browser.tabs.onUpdated?.addListener((_id, info) => {
    if (info && (info.url || info.status === 'complete')) refreshOptionsActive();
  });
  browser.windows?.onFocusChanged?.addListener(refreshOptionsActive);
  refreshOptionsActive();
}

/** @param {string} view */
const routeArgs = (view) => ({ state: currentState, send, voiceManager, uiActions, view, optionsActive, activeTabIsWeb });

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
m.route(root, '/chat', { '/chat': Root, '/chats': Root });
