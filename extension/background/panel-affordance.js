// @ts-check
// background/panel-affordance.js — what should the toolbar icon / the
// "pull in peerd" shortcut do right now?
//
// why pure (functional core): the decision has to run SYNCHRONOUSLY inside a
// click/keystroke gesture — sidePanel.open()/sidebarAction.open() drop their
// activation if anything is awaited first — so all state is passed in and the
// answer comes back as a plain tag the imperative shell in service-worker.js
// acts on. Pure ⇒ unit-testable without a browser (panel-affordance.test.ts).
//
// The model (DESIGN-12, owner 2026-06-20): the toolbar icon is peerd's FRONT
// DOOR. With no home up yet it opens the full-page home — peerd should feel
// first-party, not a bolted-on sidebar. Once home IS up, the icon COMPLEMENTS
// by pulling the chat into the window-global side panel (Chrome) / sidebar
// (Firefox) so it follows you onto any tab. The keyboard command is the
// dedicated twin: it TOGGLES the panel — pulls it in, or closes it if it's
// already open (the icon never closes; it's the front door, not a switch).

/**
 * @param {Object} p
 * @param {boolean} p.homeOpen       is a home surface currently open?
 * @param {boolean} [p.panelOpen]    is the side panel / sidebar currently open?
 *   (only the keyboard command acts on this — to toggle closed.)
 * @param {boolean} p.hasSidePanel   is browser.sidePanel.open available? (Chrome)
 * @param {boolean} p.hasSidebar     is browser.sidebarAction.open available? (Firefox)
 * @param {boolean} [p.fromShortcut] true when invoked from the keyboard command
 *   (toggle the panel) rather than the toolbar icon (home-first, open-only).
 * @returns {'panel'|'sidebar'|'close'|'home'}
 *   'panel'   → open the Chrome side panel for the current window
 *   'sidebar' → open the Firefox sidebar
 *   'close'   → close the open side panel / sidebar
 *   'home'    → open (focus-or-create) the full-page home
 */
export const decidePullIn = ({ homeOpen, panelOpen = false, hasSidePanel, hasSidebar, fromShortcut = false }) => {
  // The shortcut toggles: an open panel closes. (The icon ignores panelOpen —
  // re-opening an already-open panel is a harmless focus, and "front door"
  // shouldn't double as a dismiss.)
  if (fromShortcut && panelOpen && (hasSidePanel || hasSidebar)) return 'close';
  // The shortcut is the dedicated "pull in peerd"; the icon only complements
  // once home is already the user's anchor.
  const wantPanel = fromShortcut || homeOpen;
  if (wantPanel && hasSidePanel) return 'panel';
  if (wantPanel && hasSidebar) return 'sidebar';
  return 'home';
};
