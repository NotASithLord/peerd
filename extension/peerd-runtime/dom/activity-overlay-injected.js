// peerd-runtime/dom — the in-page "peerd is doing something here" indicator.
//
// A small pill in the bottom-right corner of the tab the web actor is driving:
// the brand orb, one short phrase (actor/activity-label.js decides the words),
// and a Stop button. It answers the two questions a person has when their own
// browser starts moving on its own — "is this thing working, or stuck?" and
// "how do I make it stop?" — in the place they are already looking, which is the
// page, not the side panel.
//
// INVISIBLE TO PEERD ITSELF. This is the constraint that shapes the whole file.
// The agent reads the page it is driving, so an indicator built naively becomes
// something the agent SEES, describes back to the user, and can click. Three
// independent measures keep it out, because any one of them could be undone by
// a later edit and the failure is silent:
//
//   1. `aria-hidden="true"` on the host. walk-injected.js's isHidden() treats an
//      aria-hidden element as hidden and `continue`s, which skips the element
//      AND its subtree; the CDP a11y-tree path drops it for the same reason.
//   2. A CLOSED shadow root. walk-injected.js descends `el.shadowRoot`, which is
//      null for a closed root, so the walk cannot reach the contents even if
//      measure 1 is removed.
//   3. Closed shadow content is not part of the host's `textContent`, so
//      read_page's text mode cannot pick the phrase up either.
//
// Measure 2 is also why the root is stashed on a global rather than re-read from
// the element: a closed root is unreachable from the outside by design, so the
// updater has to hold its own reference. Same isolated-world-global trick
// walk-injected.js uses for walk ids, and it dies with the document for the same
// reason — which is exactly the lifetime we want, since a navigation should
// leave no stale pill behind.
//
// STYLING IS SELF-CONTAINED AND HARD-CODED. It cannot use the side panel's CSS
// custom properties (different document) and must not inherit the host page's
// (a page that sets `* { font-family: Comic Sans }` should not restyle this).
// The shadow root gives isolation in both directions; `all: initial` on the
// wrapper closes the inheritance the shadow boundary does not.
//
// Deliberately ES5 and self-contained: chrome.scripting serializes this source
// and re-evaluates it in the target page, so it can close over nothing. See the
// header of dom-helpers.js. The `// why:` comments here matter more than usual
// because none of it can be refactored into shared helpers.

/**
 * The host element's id. Exported so tests can assert the pill's presence and
 * absence by the same name the injected bodies hard-code (they cannot import it
 * — see the header on why they close over nothing).
 */
export const ACTIVITY_OVERLAY_ID = 'peerd-activity-overlay';

/**
 * Create or update the in-page activity pill.
 *
 * Idempotent: called once per tool call, it builds the pill the first time and
 * only swaps the phrase afterwards, so the spinner does not restart mid-task and
 * the pill never flickers between two actions.
 *
 * @param {string} label  the phrase to show (from describeToolActivity)
 * @param {string} originLabel  the origin being driven, shown under the phrase
 * @returns {boolean} true when the pill is present afterwards
 */
export function activityOverlayInjected(label, originLabel) {
  'use strict';
  try {
    var ID = 'peerd-activity-overlay';
    var host = document.getElementById(ID);
    var root = globalThis.__peerdActivityRoot;

    // why re-create when the global is gone but the host is not: the isolated
    // world is rebuilt on navigation while a cached host element could survive a
    // same-document rewrite. Trust the pair, not either half.
    if (host && !root) { host.remove(); host = null; }

    if (!host) {
      host = document.createElement('div');
      host.id = ID;
      // Measure 1 — see the header. Also keeps it out of the CDP a11y tree.
      host.setAttribute('aria-hidden', 'true');
      host.style.setProperty('all', 'initial', 'important');
      host.style.setProperty('position', 'fixed', 'important');
      host.style.setProperty('inset', 'auto 16px 16px auto', 'important');
      // why the maximum: the pill has to sit above the page's own overlays, and
      // a page that outbids this is a page whose modal we would be hiding behind.
      host.style.setProperty('z-index', '2147483647', 'important');
      // The host is a positioning shell only; the pill inside takes the clicks.
      host.style.setProperty('pointer-events', 'none', 'important');

      // Measure 2 — CLOSED, so nothing outside this function can read it.
      root = host.attachShadow({ mode: 'closed' });
      globalThis.__peerdActivityRoot = root;

      var style = document.createElement('style');
      style.textContent = [
        ':host, * { box-sizing: border-box; }',
        '.pill {',
        '  all: initial;',
        '  pointer-events: auto;',
        '  display: flex; align-items: center; gap: 10px;',
        '  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;',
        '  font-size: 12px; line-height: 1.35;',
        '  color: #F5F5F5; background: #16181C;',
        '  border: 1px solid rgba(255,255,255,.14); border-radius: 10px;',
        '  padding: 9px 11px; max-width: 320px;',
        '  box-shadow: 0 8px 28px rgba(0,0,0,.34), 0 2px 6px rgba(0,0,0,.22);',
        '}',
        // The brand orb, matching the side panel's .peerd-spinner exactly —
        // same conic gradient, same mask, same 0.85s cadence (the brand-wide
        // spinner cadence). This is the ONE place colour is allowed here; the
        // rest of the pill is monochrome, per the brand rule.
        '.orb {',
        '  flex: none; width: 14px; height: 14px; border-radius: 50%;',
        '  background: conic-gradient(from 0deg, #00B7EB, #D946EF, #F59E0B, #22C55E, #EF4444, #00B7EB);',
        '  -webkit-mask: radial-gradient(closest-side, transparent 58%, #000 60%);',
        '          mask: radial-gradient(closest-side, transparent 58%, #000 60%);',
        '  animation: peerd-act-spin 0.85s linear infinite;',
        '}',
        '@keyframes peerd-act-spin { to { transform: rotate(360deg); } }',
        '@media (prefers-reduced-motion: reduce) { .orb { animation: none; } }',
        '.text { display: flex; flex-direction: column; min-width: 0; }',
        '.label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
        '.origin { color: #9AA0A6; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
        '.stop {',
        '  all: initial; cursor: pointer; flex: none;',
        '  font-family: inherit; font-size: 11px; color: #F5F5F5;',
        '  background: rgba(255,255,255,.08);',
        '  border: 1px solid rgba(255,255,255,.18); border-radius: 6px;',
        '  padding: 4px 8px; margin-left: 2px;',
        '}',
        '.stop:hover { background: rgba(255,255,255,.16); }',
      ].join('\n');

      var pill = document.createElement('div');
      pill.className = 'pill';

      var orb = document.createElement('div');
      orb.className = 'orb';

      var text = document.createElement('div');
      text.className = 'text';
      var labelEl = document.createElement('div');
      labelEl.className = 'label';
      var originEl = document.createElement('div');
      originEl.className = 'origin';
      text.appendChild(labelEl);
      text.appendChild(originEl);

      var stop = document.createElement('button');
      stop.className = 'stop';
      stop.type = 'button';
      stop.textContent = 'Stop';
      stop.addEventListener('click', function () {
        // why fire-and-forget with a guard: the pill lives in a page that may
        // outlive the extension context (an unloaded SW, a disabled extension).
        // A throw here would surface as a page console error on a button the
        // user pressed in good faith, so failure is silent and the pill stays —
        // the side panel's Stop is always the backstop.
        try {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: 'agent/stop' });
          }
        } catch (e) { /* extension context gone; side-panel Stop still works */ }
        labelEl.textContent = 'Stopping…';
      });

      pill.appendChild(orb);
      pill.appendChild(text);
      pill.appendChild(stop);
      root.appendChild(style);
      root.appendChild(pill);
      (document.body || document.documentElement).appendChild(host);
    }

    var l = root.querySelector('.label');
    var o = root.querySelector('.origin');
    if (l) l.textContent = String(label == null ? '' : label);
    if (o) o.textContent = String(originLabel == null ? '' : originLabel);
    return true;
  } catch (e) {
    // An indicator must never break the page it is annotating.
    return false;
  }
}

/**
 * Remove the pill. Safe to call when it was never shown.
 * @returns {boolean} true when nothing is left behind
 */
export function clearActivityOverlayInjected() {
  'use strict';
  try {
    var host = document.getElementById('peerd-activity-overlay');
    if (host) host.remove();
    globalThis.__peerdActivityRoot = undefined;
    return true;
  } catch (e) {
    return false;
  }
}
