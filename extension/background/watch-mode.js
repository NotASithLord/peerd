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
 * True only when: watch mode is on, we actually know the agent's tab, and it is
 * not ALREADY the active tab (foregrounding the active tab is a no-op that would
 * still needlessly steal window focus). The caller does the tabs.update; this is
 * the guard, kept pure so "when do we yank focus" is a testable value, not an
 * effect buried in a listener.
 *
 * @param {{ watchOn: boolean, agentTabId: number | null | undefined, activeTabId: number | null | undefined }} p
 * @returns {boolean}
 */
export const shouldFollowAgentTab = ({ watchOn, agentTabId, activeTabId }) =>
  watchOn === true
  && typeof agentTabId === 'number'
  && agentTabId !== activeTabId;
