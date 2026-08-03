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
// The model (DESIGN-12, owner 2026-06-20; amended 2026-07-29): the toolbar
// icon is peerd's FRONT DOOR, and WHICH surface it opens is the user's
// `frontDoorView` setting. 'panel' (the default) pulls the chat straight into
// the window-global side panel (Chrome) / sidebar (Firefox), next to the page
// the user is on — landing them in a full-tab takeover (often straight into
// the vault gate) read as heavyweight. 'home' restores the original model:
// the full-page home first, the panel once home is already up (peerd as a
// first-party surface, not a bolted-on sidebar). Either way the keyboard
// command is the dedicated twin: it TOGGLES the panel — pulls it in, or
// closes it if it's already open (the icon never closes; it's the front
// door, not a switch).

/**
 * @param {Object} p
 * @param {boolean} p.homeOpen       is a home surface currently open?
 * @param {boolean} [p.panelOpen]    is the side panel / sidebar currently open?
 *   (only the keyboard command acts on this — to toggle closed.)
 * @param {boolean} p.hasSidePanel   is browser.sidePanel.open available? (Chrome)
 * @param {boolean} p.hasSidebar     is browser.sidebarAction.open available? (Firefox)
 * @param {boolean} [p.fromShortcut] true when invoked from the keyboard command
 *   (toggle the panel) rather than the toolbar icon (open-only).
 * @param {'panel'|'home'} [p.frontDoorView] the user's default front-door
 *   surface (the `frontDoorView` setting): 'panel' (default) opens the side
 *   panel / sidebar directly; 'home' keeps the full-page-home-first model.
 * @param {boolean} [p.nativePanelMirror] true when the browser natively opens
 *   the panel on icon click (Chrome, via the setPanelBehavior mirror in
 *   tab-affordances.js). An icon click reaching us AT ALL then implies the
 *   mirror is off — the user chose 'home' — and that inference, not the
 *   setting, is what survives an SW cold start: the settings store serves
 *   channel defaults until its async hydration lands, and the waking click
 *   can beat it.
 * @returns {'panel'|'sidebar'|'close'|'home'}
 *   'panel'   → open the Chrome side panel for the current window
 *   'sidebar' → open the Firefox sidebar
 *   'close'   → close the open side panel / sidebar
 *   'home'    → open (focus-or-create) the full-page home
 */
export const decidePullIn = ({ homeOpen, panelOpen = false, hasSidePanel, hasSidebar, fromShortcut = false, frontDoorView = 'panel', nativePanelMirror = false }) => {
  // The shortcut toggles: an open panel closes. (The icon ignores panelOpen —
  // re-opening an already-open panel is a harmless focus, and "front door"
  // shouldn't double as a dismiss.)
  if (fromShortcut && panelOpen && (hasSidePanel || hasSidebar)) return 'close';
  // Icon + native mirror ⇒ the browser already handles 'panel' clicks itself,
  // so this dispatch means 'home' regardless of the (possibly un-hydrated)
  // setting value. The shortcut never rides the inference — it is always the
  // dedicated "pull in peerd".
  const view = (!fromShortcut && nativePanelMirror) ? 'home' : frontDoorView;
  // The icon opens the panel by default; under 'home' it only complements
  // once home is already the user's anchor.
  const wantPanel = fromShortcut || homeOpen || view !== 'home';
  if (wantPanel && hasSidePanel) return 'panel';
  if (wantPanel && hasSidebar) return 'sidebar';
  return 'home';
};
