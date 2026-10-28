// @ts-check
// app-tab/full-screen.js: the App tab's "Full screen" button, the P handle that
// keeps peerd one click away in full screen, and the short Esc status.
//
// why the trusted page goes full screen, not the App: the App frame has no
// allow="fullscreen", so App code cannot start full screen. Only this page's own
// button, after a real click, starts it. After that the App fills the screen and
// can draw anything, including fake browser UI or a copy of the P handle. The
// protections are that click, the browser's own exit message that names peerd,
// and Esc, which App code cannot block.
//
// why the page root, not the frame's box: the notices, the App actor drawer and
// the boot failure sit beside the frame. With only the frame's box on screen,
// they would open out of sight. A consent prompt leaves full screen first
// (app-tab.js).
//
// why move focus: full screen hides the button that has it, so focus falls to
// the page and key presses reach nothing. On entry the App gets the keys. On
// exit the button gets focus back, unless the App, a prompt or another window
// (such as the side panel) has it. The Firefox sidebar does not take focus when
// the handle opens it, so that exit leaves focus on the page. On the button, the
// first Space or Enter would start full screen again. When the open side panel
// hides the handle that has focus, the App gets the keys.
//
// why the handle acts by browser (measured in Chrome for Testing 151 and
// Firefox 154): Chrome keeps its side panel beside a full-screen element, so
// the handle opens the panel and full screen stays on. While the panel is open,
// peerd is on screen, so the handle hides. Firefox hides its sidebar during
// element full screen, and sidebarAction.open() then shows nothing. There the
// handle leaves full screen first, then opens the sidebar in the same click
// handler. An await between the two loses the click, and Firefox then refuses
// the open.

/** @typedef {'side-panel' | 'sidebar' | null} PanelKind */
/** @typedef {'open-beside' | 'leave-then-open'} HandleAction */

/**
 * The page surface this module needs. `document` has this shape.
 * @typedef {object} FullScreenDocument
 * @property {boolean} fullscreenEnabled
 * @property {Element | null} fullscreenElement
 * @property {Element | null} activeElement
 * @property {HTMLElement | null} body
 * @property {() => boolean} hasFocus
 * @property {() => Promise<void>} exitFullscreen
 * @property {(type: 'fullscreenchange', listener: () => void) => void} addEventListener
 */

export const FULL_SCREEN_FAILED = 'Full screen did not start. Click Full screen to try again.';

// why a second name: in Firefox the handle also leaves full screen, so its
// name says so.
export const LEAVE_AND_OPEN = 'Leave full screen and open peerd';

// why 4 s: enough time to read one short sentence. The fade in index.html
// ends at the same moment.
export const STATUS_MS = 4000;

/**
 * What the P handle does in this browser. With no panel to open there is no
 * handle, and Esc is the way out.
 * @param {PanelKind} panelKind
 * @returns {HandleAction | null}
 */
export const handleAction = (panelKind) => (panelKind === 'side-panel' ? 'open-beside'
  : panelKind === 'sidebar' ? 'leave-then-open' : null);

/**
 * Wire the button, the handle and the status. The IO is injected, so the
 * in-browser lane can drive it without a real full screen.
 * @param {{
 *   doc: FullScreenDocument,
 *   target: Element,
 *   frame: HTMLElement,
 *   button: HTMLElement,
 *   handle: HTMLElement,
 *   status: HTMLElement,
 *   panelKind: PanelKind,
 *   openPanel: () => void,
 *   onPanelOpenChange: (listener: (open: boolean) => void) => void,
 *   onFailure: (message: string) => void,
 *   schedule?: (run: () => void, ms: number) => unknown,
 * }} io
 */
export const mountFullScreen = ({
  doc, target, frame, button, handle, status, panelKind, openPanel, onPanelOpenChange, onFailure, schedule = setTimeout,
}) => {
  const action = handleAction(panelKind);
  button.hidden = !doc.fullscreenEnabled;
  if (action === 'leave-then-open') {
    handle.title = LEAVE_AND_OPEN;
    handle.setAttribute('aria-label', LEAVE_AND_OPEN);
  }
  button.addEventListener('click', () => {
    target.requestFullscreen().catch(() => onFailure(FULL_SCREEN_FAILED));
  });
  const focusLost = () => [doc.body, button, handle].some((element) => element === doc.activeElement);
  let panelOpen = false;
  const hideHandle = () => doc.fullscreenElement !== target || action === null || (action === 'open-beside' && panelOpen);
  // why count entries: a timer from an earlier entry must not cut a later status short.
  let entries = 0;
  // why remember the Firefox handle's exit: that exit must not give focus back to the button.
  let leftForPanel = false;
  doc.addEventListener('fullscreenchange', () => {
    const on = doc.fullscreenElement === target;
    entries += 1;
    handle.hidden = hideHandle();
    status.hidden = !on;
    if (!on) {
      if (!leftForPanel && focusLost() && doc.hasFocus()) button.focus();
      leftForPanel = false;
      return;
    }
    if (focusLost()) frame.focus();
    const entry = entries;
    schedule(() => { if (entry === entries) status.hidden = true; }, STATUS_MS);
  });
  if (action === 'open-beside') {
    onPanelOpenChange((open) => {
      panelOpen = open;
      const focused = !handle.hidden && handle === doc.activeElement;
      handle.hidden = hideHandle();
      if (focused && handle.hidden) frame.focus();
    });
  }
  handle.addEventListener('click', () => {
    if (action === 'leave-then-open') {
      leftForPanel = true;
      doc.exitFullscreen().catch(() => {});
    }
    openPanel();
  });
};
