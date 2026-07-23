// @ts-check
// background/watch-mode.js — the pure decision behind "watch the agent's tab".
//
// Watch mode is the OPT-IN inverse of the no-focus-steal rule (DESIGN-12). By
// default peerd drives its tab in the BACKGROUND so it never interrupts the
// user. When the user turns watch mode ON, they are explicitly asking to see
// the page: peerd brings the agent's current tab to the foreground and follows
// it as the agent moves between tabs. The browser itself is the viewer — no
// screenshotting, no capture, full fidelity, works on every channel (it is a
// plain tabs.update, no CDP and no new permission).
//
// This is the SW-side wiring's ONLY non-IO bit, lifted out so it is unit-tested:
// given the live state, should we foreground the agent's tab right now?

/**
 * Should watch mode foreground the agent's tab at this moment?
 *
 * Every clause here exists because a focus-steal audit found a way to pull the
 * user's window with nobody watching. All must hold:
 *
 *  - `watchOn` — the setting. Necessary, nowhere near sufficient: it PERSISTS, so
 *    everything below is what stops "I watched one task last Tuesday" from
 *    becoming a standing licence to grab focus.
 *
 *  - `panelOpen` — a SIDE-PANEL port specifically. why not "any peerd surface":
 *    the full-page home is peerd's front door (the toolbar icon opens it) and its
 *    port SELF-RECONNECTS after every service-worker respawn, so a home tab parked
 *    in a background window keeps "a surface is open" true forever — which is the
 *    resting state for lots of users, and would have let an unattended 3am Routine
 *    (schedule-create.js: runs "even while the side panel is closed", catching up
 *    on wake) yank the browser to the front. The toggle only exists in the panel,
 *    so the panel is what "watching" means.
 *
 *  - `chromeFocused` — the browser is the focused APPLICATION. The worst symptom
 *    of every path found was peerd hauling Chrome over the app the user had
 *    alt-tabbed to. If the user isn't in the browser at all, nothing peerd does is
 *    being watched, so it must never raise a window. (windows.onFocusChanged fires
 *    WINDOW_ID_NONE when Chrome loses focus.)
 *
 *  - `agentTabId` is known, and `alreadyInFront` is false. why the caller resolves
 *    "in front" from LIVE tab state instead of us comparing a remembered
 *    activeTabId: that scalar is unseeded after an MV3 respawn (so the no-op guard
 *    silently died and every touch re-raised the window) and it is GLOBAL while
 *    "active" is per-window (so in the natural two-window watch layout — agent tab
 *    + panel in one window, the user working in another — it never matched and
 *    every touch ripped the agent's window over the user's). Asking the browser
 *    "is this tab the active tab of the focused window?" is true by construction.
 *
 * Kept pure so "when do we yank focus" is a testable value, not an effect buried
 * in a listener. The caller does the tabs.update.
 *
 * @param {{ watchOn: boolean, panelOpen: boolean, chromeFocused: boolean, agentTabId: number | null | undefined, alreadyInFront: boolean }} p
 * @returns {boolean}
 */
export const shouldFollowAgentTab = ({ watchOn, panelOpen, chromeFocused, agentTabId, alreadyInFront }) =>
  watchOn === true
  && panelOpen === true
  && chromeFocused === true
  && typeof agentTabId === 'number'
  && alreadyInFront !== true;
