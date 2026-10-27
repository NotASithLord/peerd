// @ts-check
// App full screen: the button asks its target for full screen, the P handle and
// the Esc status show only in full screen, and the status hides on its own. In
// Chrome the handle opens the side panel beside the App, and hides while the
// panel is open. In Firefox it leaves full screen first, then opens the sidebar
// in the same click. Focus goes to the App on entry and back to the button on
// exit, but not on the exit that the Firefox handle starts.
//
// why in-browser (not Bun): it builds real buttons and sends real clicks. why
// fakes for the full-screen calls: requestFullscreen() needs a user click, which
// this lane cannot give. The e2e state app-full-screen drives the real one.

import { describe, it, expect } from '../../../framework.js';
import { FULL_SCREEN_FAILED, LEAVE_AND_OPEN, STATUS_MS, mountFullScreen } from '../../../../engine-tabs/app-tab/full-screen.js';

// why focus reads the real document: focus() only moves focus between attached elements.
class FakeDocument extends EventTarget {
  fullscreenEnabled = true;
  /** @type {Element | null} */
  fullscreenElement = null;
  focused = true;
  /** @type {string[]} */
  log = [];
  get activeElement() { return document.activeElement; }
  get body() { return document.body; }
  hasFocus() { return this.focused; }
  exitFullscreen() {
    this.log.push('exit');
    return Promise.resolve();
  }
}

/** @param {{ panelKind?: 'side-panel' | 'sidebar' | null, enabled?: boolean, refuse?: boolean, panelOpen?: boolean }} [options] */
const mount = ({ panelKind = 'side-panel', enabled = true, refuse = false, panelOpen = false } = {}) => {
  const doc = new FakeDocument();
  doc.fullscreenEnabled = enabled;
  const target = document.createElement('div');
  const frame = document.createElement('iframe');
  target.requestFullscreen = () => {
    doc.log.push('request');
    if (refuse) return Promise.reject(new TypeError('Permissions check failed'));
    doc.fullscreenElement = target;
    doc.dispatchEvent(new Event('fullscreenchange'));
    return Promise.resolve();
  };
  const button = document.createElement('button');
  const handle = document.createElement('button');
  const status = document.createElement('div');
  handle.hidden = true;
  status.hidden = true;
  /** @type {string[]} */
  const failures = [];
  /** @type {{ run: () => void, ms: number }[]} */
  const timers = [];
  /** @type {(open: boolean) => void} */
  let panelChanged = () => {};
  mountFullScreen({
    doc, target, frame, button, handle, status, panelKind,
    openPanel: () => { doc.log.push('open'); },
    onPanelOpenChange: (listener) => { panelChanged = listener; listener(panelOpen); },
    onFailure: (message) => { failures.push(message); },
    schedule: (run, ms) => timers.push({ run, ms }),
  });
  const leave = () => {
    doc.fullscreenElement = null;
    doc.dispatchEvent(new Event('fullscreenchange'));
  };
  /** @param {boolean} open */
  const panel = (open) => panelChanged(open);
  /** @param {(parts: { doc: FakeDocument, frame: HTMLIFrameElement, button: HTMLButtonElement, handle: HTMLButtonElement, leave: () => void, panel: (open: boolean) => void }) => void} body */
  const attached = (body) => {
    document.body.append(frame, button, handle);
    try { body({ doc, frame, button, handle, leave, panel }); } finally { frame.remove(); button.remove(); handle.remove(); }
  };
  return { doc, button, handle, status, failures, timers, leave, panel, attached };
};

describe('App full screen', () => {
  it('shows the handle and the Esc status only while the target is full screen', () => {
    const { doc, button, handle, status, leave } = mount();
    expect(button.hidden).toBe(false);
    button.click();
    expect(doc.log).toEqual(['request']);
    expect(handle.hidden).toBe(false);
    expect(status.hidden).toBe(false);
    leave();
    expect(handle.hidden).toBe(true);
    expect(status.hidden).toBe(true);
  });

  it('hides the Esc status after a few seconds, and an old timer cannot cut a new one short', () => {
    const { button, status, timers, leave } = mount();
    button.click();
    expect(timers.map(({ ms }) => ms)).toEqual([STATUS_MS]);
    leave();
    button.click();
    timers[0].run();
    expect(status.hidden).toBe(false);
    timers[1].run();
    expect(status.hidden).toBe(true);
  });

  it('in Chrome the handle opens the side panel and full screen stays on', () => {
    const { doc, button, handle } = mount({ panelKind: 'side-panel' });
    button.click();
    handle.click();
    expect([...doc.log]).toEqual(['request', 'open']);
  });

  it('in Firefox the handle leaves full screen, then opens the sidebar in the same click', () => {
    const { doc, button, handle } = mount({ panelKind: 'sidebar' });
    button.click();
    handle.click();
    // why read at once: an await before the open loses the click in Firefox.
    expect([...doc.log]).toEqual(['request', 'exit', 'open']);
  });

  it('in Firefox the handle name says that it also leaves full screen', () => {
    const { handle } = mount({ panelKind: 'sidebar' });
    expect(LEAVE_AND_OPEN).toBe('Leave full screen and open peerd');
    expect(handle.title).toBe(LEAVE_AND_OPEN);
    expect(handle.getAttribute('aria-label')).toBe(LEAVE_AND_OPEN);
    // Chrome keeps the name in the page, because there full screen stays on.
    expect(mount({ panelKind: 'side-panel' }).handle.getAttribute('aria-label')).toBe(null);
  });

  it('in Chrome the handle hides while the side panel is open, because peerd is then on screen', () => {
    const { button, handle, leave, panel } = mount({ panelOpen: true });
    button.click();
    expect(handle.hidden).toBe(true);
    panel(false);
    expect(handle.hidden).toBe(false);
    panel(true);
    expect(handle.hidden).toBe(true);
    // Out of full screen, a closed panel does not bring the handle back.
    leave();
    panel(false);
    expect(handle.hidden).toBe(true);
  });

  it('in Firefox the handle stays while the sidebar is open, because full screen hides the sidebar', () => {
    const { button, handle } = mount({ panelKind: 'sidebar', panelOpen: true });
    button.click();
    expect(handle.hidden).toBe(false);
  });

  it('gives the keys to the App on entry, and focus back to the button on exit', () => {
    mount().attached(({ frame, button, handle, leave }) => {
      // A click on Full screen focuses it, and then full screen hides it.
      button.focus();
      button.click();
      expect(document.activeElement).toBe(frame);
      // Shift+Tab from the App reaches the handle, and Esc then hides it.
      handle.focus();
      leave();
      expect(document.activeElement).toBe(button);
    });
  });

  it('leaves focus alone on exit when the App or another window has it', () => {
    mount().attached(({ doc, frame, button, handle, leave }) => {
      button.focus();
      button.click();
      leave();
      expect(document.activeElement).toBe(frame);
      button.focus();
      button.click();
      handle.focus();
      // The side panel has focus: taking it would send the person's typing here.
      doc.focused = false;
      leave();
      expect(document.activeElement === button).toBe(false);
    });
  });

  it('in Firefox the handle leaves focus on the page, so typing cannot start full screen again', () => {
    mount({ panelKind: 'sidebar' }).attached(({ button, handle, leave }) => {
      button.focus();
      button.click();
      handle.focus();
      handle.click();
      // The sidebar does not take focus. On the button, the first Space or Enter would start full screen again.
      leave();
      expect(document.activeElement === button).toBe(false);
      // A later Esc gives focus back to the button.
      button.focus();
      button.click();
      handle.focus();
      leave();
      expect(document.activeElement).toBe(button);
    });
  });

  it('when the open side panel hides the handle that has focus, the App gets the keys', () => {
    mount().attached(({ frame, button, handle, panel }) => {
      button.focus();
      button.click();
      handle.focus();
      panel(true);
      expect(handle.hidden).toBe(true);
      expect(document.activeElement).toBe(frame);
    });
  });

  it('shows no handle when there is no panel to open', () => {
    const { button, handle, status } = mount({ panelKind: null });
    button.click();
    expect(handle.hidden).toBe(true);
    expect(status.hidden).toBe(false);
  });

  it('says what failed and what to do when the browser refuses full screen', async () => {
    const { button, handle, failures } = mount({ refuse: true });
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failures).toEqual([FULL_SCREEN_FAILED]);
    expect(FULL_SCREEN_FAILED).toBe('Full screen did not start. Click Full screen to try again.');
    expect(handle.hidden).toBe(true);
  });

  it('hides the button where the browser cannot go full screen', () => {
    const { button } = mount({ enabled: false });
    expect(button.hidden).toBe(true);
  });
});
