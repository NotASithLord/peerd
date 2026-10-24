// @ts-check
// app-tab/consent-bar.js: the trusted parent's consent bar for App requests
// (open a link, join a room, share or install an App).
//
// why a module (not inline in app-tab.js): app-tab.js is a page script, so the
// arming delay below would otherwise have no automated guard. Like
// vm-tab/firefox-webvm-note.js, the bar is a pure DOM builder the in-browser
// lane can drive.
//
// why an arming delay: the bar lands at a fixed spot over the full-viewport App
// frame, so a hostile App can draw a "double-click here" target under the
// approve button and post its request on the first click. The second click of
// that double-click would approve. Browser permission prompts ignore activation
// for a short time after they appear; the approve button does the same. Deny
// and Escape stay instant.
//
// why 1000 ms, not Chrome's 500: a double-click's second press follows the
// first by up to 500 ms, and Chrome was measured to spend a further ~450 ms
// re-targeting that press from the App frame to the bar that now covers it, so
// it lands 510-750 ms after the bar appears. Firefox arms its security dialogs
// after 1000 ms for the same reason.

export const CONSENT_ARM_DELAY_MS = 1000;

// A minimal monochrome consent bar follows the project color rule.
/**
 * @param {{ appName: string, detail: string, kind?: string, approveLabel?: string }} request
 * @param {{ armDelayMs?: number, inert?: HTMLElement }} [opts]
 * @returns {Promise<boolean>}
 */
export const showConsentBar = ({ appName, detail, kind, approveLabel }, { armDelayMs = CONSENT_ARM_DELAY_MS, inert } = {}) => new Promise((resolve) => {
  const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const bar = document.createElement('div');
  bar.setAttribute('role', 'alertdialog');
  bar.setAttribute('aria-modal', 'true');
  bar.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:50',
    'display:flex', 'gap:12px', 'align-items:center', 'justify-content:center',
    'padding:10px 16px', 'background:#111', 'color:#eee',
    'font:13px/1.4 -apple-system, system-ui, sans-serif',
    'border-bottom:1px solid #333',
  ].join(';');
  const text = document.createElement('span');
  text.id = `app-confirm-${Date.now()}`;
  bar.setAttribute('aria-labelledby', text.id);
  text.textContent = `“${appName}” wants to ${detail}.`;
  /** @param {string} label @param {boolean} val @param {boolean} solid */
  const mkBtn = (label, val, solid) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `min-height:44px;padding:8px 16px;border:1px solid #555;border-radius:4px;cursor:pointer;background:${solid ? '#eee' : 'transparent'};color:${solid ? '#111' : '#eee'};font:inherit`;
    // why lift inert first: focus() on an inert element is a no-op.
    b.addEventListener('click', (event) => {
      // why: repeated clicks can continue past the arming delay.
      if (val && (b.disabled || event.detail > 1)) return;
      bar.remove(); if (inert) inert.inert = false; priorFocus?.focus(); resolve(val);
    });
    return b;
  };
  const actionLabel = approveLabel ?? (kind === 'join' ? 'Join room' : kind === 'install' ? 'Install app' : 'Allow');
  const allow = mkBtn(actionLabel, true, true);
  const deny = mkBtn('Deny', false, false);
  // A disabled button drops real clicks, synthetic click() and Enter alike.
  allow.disabled = true;
  setTimeout(() => { allow.disabled = false; }, armDelayMs);
  bar.append(text, allow, deny);
  document.body.appendChild(bar);
  // why inert: the bar claims aria-modal, and the App must take no pointer
  // input (nor redraw a lure under the buttons) while its request waits.
  if (inert) inert.inert = true;
  deny.focus();
  bar.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); deny.click(); return; }
    if (event.key !== 'Tab') return;
    if (event.shiftKey && document.activeElement === allow) { event.preventDefault(); deny.focus(); }
    else if (!event.shiftKey && document.activeElement === deny) { event.preventDefault(); allow.focus(); }
  });
});
