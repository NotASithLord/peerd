// @ts-check

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
  if (fromShortcut && panelOpen && (hasSidePanel || hasSidebar)) return 'close';
  const view = (!fromShortcut && nativePanelMirror) ? 'home' : frontDoorView;
  const wantPanel = fromShortcut || homeOpen || view !== 'home';
  if (wantPanel && hasSidePanel) return 'panel';
  if (wantPanel && hasSidebar) return 'sidebar';
  return 'home';
};
