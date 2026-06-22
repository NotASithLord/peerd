// @ts-check
// shared/pull-in-peerd.js — a floating "pull in peerd" affordance for the
// engine tab pages (WebVM · Notebook · App). It mirrors home's "Pop to side"
// button: one click opens the window-global side panel so the chat follows you
// onto the tab you're already standing on.
//
// why this exists: peerd spawns its OWN tabs in the background (a Linux VM, a
// Notebook, an App). If you walk onto one of those tabs directly — no side
// panel open — there was no way to summon the chat without first going back to
// home, popping it out, then navigating back. This button removes that
// round-trip: every peerd-owned tab now carries the trigger to pull the panel
// in on the spot.
//
// SCOPE — extension-owned tab pages ONLY. Regular web pages peerd opens are
// deliberately NOT covered here: an in-page button there can't reach
// chrome.sidePanel (it lives in a page/content-script world) and would have to
// message the SW to open the panel — which crosses peerd's fail-closed "no
// content-script-reachable SW routes" boundary (shared/messaging.js). That
// wider scope is a separate, deliberate decision (see the security/UX writeup).
//
// Cross-browser: Chrome opens the window side panel — sidePanel.open() needs a
// REAL windowId (the WINDOW_ID_CURRENT sentinel is rejected, and the async
// tabs.getCurrent() is too late for the gesture), so we resolve and cache it at
// mount. Firefox has no sidePanel (the build maps the panel to a
// sidebar_action), so we open the sidebar via sidebarAction.open(). BOTH APIs
// require a user gesture, so the open() call runs synchronously inside the
// click handler — no await before it, or the activation is dropped (same
// constraint as home's popToSide).

import browser from '/vendor/browser-polyfill.js';

// why a typed accessor: the Chrome-only sidePanel namespace isn't on the
// webextension-polyfill `Browser` type (the polyfill proxies it to chrome.*
// at runtime, but the type omits it). @types/chrome supplies the real shape,
// so we read it through this cast rather than scatter casts at every call.
const sidePanelApi = () =>
  /** @type {{ sidePanel?: typeof chrome.sidePanel }} */ (
    /** @type {unknown} */ (browser)
  ).sidePanel;

// Resolved once at mount: sidePanel.open() rejects the WINDOW_ID_CURRENT
// sentinel and tabs.getCurrent() is async, so caching the real id now is the
// only way to have it ready synchronously when the click fires.
/** @type {number | null} */
let cachedWindowId = null;
const resolveWindowId = () => {
  try {
    const p = browser.tabs?.getCurrent?.();
    if (p?.then) p.then((t) => { cachedWindowId = t?.windowId ?? null; }).catch(() => {});
  } catch { /* no tabs API in this context */ }
};

// Is there any panel surface to open at all? Chrome ships sidePanel; Firefox
// ships sidebarAction. On neither (or an old build) the button is pointless.
const panelApiAvailable = () => !!(sidePanelApi()?.open || browser.sidebarAction?.open);

// Open — synchronous inside the click gesture (see header note): Chrome's
// window side panel, else Firefox's sidebar.
const openPanel = () => {
  try {
    const sidePanel = sidePanelApi();
    if (sidePanel?.open) {
      // id not resolved yet → no-op beats a reject (mirrors home.popToSide).
      if (cachedWindowId == null) return;
      const p = sidePanel.open({ windowId: cachedWindowId });
      if (p?.catch) p.catch((e) => console.warn('[pull-in-peerd] sidePanel.open failed', e));
      return;
    }
    if (browser.sidebarAction?.open) {
      const p = browser.sidebarAction.open();
      if (p?.catch) p.catch((e) => console.warn('[pull-in-peerd] sidebarAction.open failed', e));
    }
  } catch (e) { console.warn('[pull-in-peerd] open threw', e); }
};

// Close — Chrome has no sidePanel.close(), so we ask the SW to disable + re-arm
// the panel (the same path home's "bring it here" uses; only the SW owns
// sidePanel.setOptions). Firefox closes the sidebar directly.
const closePanel = () => {
  try {
    if (sidePanelApi()?.open) {
      browser.runtime.sendMessage({ type: 'sidepanel/close' })
        .catch((e) => console.warn('[pull-in-peerd] sidepanel/close failed', e));
      return;
    }
    if (browser.sidebarAction?.close) {
      const p = browser.sidebarAction.close();
      if (p?.catch) p.catch((e) => console.warn('[pull-in-peerd] sidebarAction.close failed', e));
    }
  } catch (e) { console.warn('[pull-in-peerd] close threw', e); }
};

// The five-letter wordmark in module colors — the ONE sanctioned color carrier
// on these monochrome surfaces (CLAUDE.md brand rule). Colors come from
// /shared/brand.css, which every engine tab already links; the fallbacks in
// that sheet ARE the palette, so pages that don't set the custom props (app-tab)
// still render correctly. Built as nodes (no innerHTML) so there's nothing to
// sanitize.
const WORDMARK_LETTERS = [['p', 'b-p'], ['e', 'b-e'], ['e', 'b-e2'], ['r', 'b-r'], ['d', 'b-d']];
const brandWordmark = () => {
  const wrap = document.createElement('span');
  wrap.className = 'peerd-brand';
  wrap.setAttribute('aria-hidden', 'true');
  for (const [ch, cls] of WORDMARK_LETTERS) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = ch;
    wrap.appendChild(span);
  }
  return wrap;
};

const STYLE_ID = 'peerd-pull-styles';
// Monochrome chip pinned top-right, just below each page's own action buttons
// (Run/Edit/Export on the notebook, the floating export/toggle on vm/app — all
// of which top out around 32px), with the brand wordmark as the only color. It
// reads as a clear, present affordance — NOT a faint ghost; the owner wants it
// obvious. Styles are injected here so the one module is self-contained across
// three pages with three different stylesheets. The very high z-index keeps the
// chip above app iframes and the editor overlay.
const CSS = `
.peerd-pull {
  position: fixed;
  top: 40px;
  right: 10px;
  z-index: 2147483000;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 5px 11px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1.3;
  color: var(--fg, #e6edf3);
  background: rgba(28, 33, 40, 0.94);
  border: 1px solid rgba(230, 237, 243, 0.42);
  border-radius: 7px;
  cursor: pointer;
  opacity: 0.96;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  transition: opacity 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
}
.peerd-pull:hover,
.peerd-pull:focus-visible {
  opacity: 1;
  border-color: rgba(230, 237, 243, 0.7);
  transform: translateY(-1px);
  outline: none;
}
.peerd-pull .peerd-brand { font-size: 12.5px; }
.peerd-pull-glyph { color: var(--fg-muted, #8b949e); opacity: 0.85; }
/* Brief, auto-dismissing reminder under the button. The text TYPES IN, holds,
   then TYPES OUT behind a blinking block cursor that tracks the caret — the same
   terminal feel as the wordmark's manifest intro (sidepanel/styles.css wmType /
   wmCursorStep). The hint font is monospace, so width is exactly N ch and the
   stepped reveal lands one glyph per step. --peerd-hint-w (set per-hint in JS to
   the char count) sizes both the stable box and the type animation's end width.
   pointer-events:none so it can never intercept a page click. */
.peerd-pull-hint {
  position: fixed;
  top: 74px;
  right: 10px;
  z-index: 2147482999;
  box-sizing: border-box;
  width: calc(var(--peerd-hint-w, 0px) + 26px);
  margin: 0;
  padding: 5px 9px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 1.5;
  white-space: nowrap;
  color: var(--fg-muted, #8b949e);
  background: rgba(28, 33, 40, 0.94);
  border: 1px solid rgba(230, 237, 243, 0.22);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  pointer-events: none;
  opacity: 0;
  animation: peerdHintBox 0.18s ease forwards;
}
/* The clipped text — width animates 0 → full (type in) and back (type out). */
.peerd-pull-hint-type {
  display: inline-block;
  overflow: hidden;
  white-space: nowrap;
  vertical-align: bottom;
  width: 0;
}
/* The tracking caret — a hard-blinking block, like the wordmark/boot cursor. It
   rides inline right after the typed text, so it follows the caret as glyphs
   reveal and retract. */
.peerd-pull-hint-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 1px;
  vertical-align: -0.1em;
  background: var(--fg, #e6edf3);
  animation: peerdHintBlink 1s steps(1, end) infinite;
}
@keyframes peerdHintBox    { to { opacity: 0.97; } }
@keyframes peerdHintType   { from { width: 0; } to { width: var(--peerd-hint-w, 0px); } }
@keyframes peerdHintUntype { from { width: var(--peerd-hint-w, 0px); } to { width: 0; } }
@keyframes peerdHintBlink  { 0%, 50% { opacity: 1; } 50.01%, 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .peerd-pull { transition: none; }
  .peerd-pull:hover, .peerd-pull:focus-visible { transform: none; }
  .peerd-pull-hint { animation: none; opacity: 0.97; }
  .peerd-pull-hint-type { width: var(--peerd-hint-w, auto) !important; animation: none !important; }
  .peerd-pull-hint-cursor { animation: none; opacity: 0; }
}
`;

const injectStyles = () => {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);
};

// ---- the toggle: state + the live nodes it drives ------------------------
// The button is a TOGGLE — "pull in peerd" when the panel is closed, "close"
// when it's open. State is module-scoped so the SW's surface broadcasts can
// re-render the label even when the panel is opened/closed from elsewhere.
let panelOpen = false;
/** @type {HTMLButtonElement | null} */ let btnEl = null;
/** @type {HTMLSpanElement | null} */ let labelEl = null;
/** @type {HTMLSpanElement | null} */ let glyphEl = null;

const renderToggle = () => {
  if (!btnEl || !labelEl || !glyphEl) return;
  // The wordmark is decorative (aria-hidden), so spell out the action for AT.
  if (panelOpen) {
    labelEl.textContent = 'close';
    glyphEl.textContent = '✕';
    btnEl.setAttribute('aria-label', 'Close the peerd side panel');
    btnEl.title = 'Close the peerd side panel';
  } else {
    labelEl.textContent = 'pull in';
    glyphEl.textContent = '⇥';
    btnEl.setAttribute('aria-label', 'Pull peerd into this tab — open the side panel');
    btnEl.title = 'Open peerd in the side panel — the chat follows you here';
  }
};

/** @param {boolean} open */
const setPanelOpen = (open) => {
  const next = !!open;
  if (next === panelOpen) return;
  panelOpen = next;
  if (next) removeHint();   // panel opened — the "pull in" reminder is moot
  renderToggle();
};

// ---- the shortcut hint: a brief, auto-dismissing reminder ----------------
// A caption under the button, shown for ~7s on mount, teaching the global
// Alt+Shift+P shortcut where it's RELEVANT: you're standing on a peerd tab, away
// from the chat. Only shows when the panel is CLOSED (no point hinting "pull in"
// when it's already here). The bound chord comes from commands.getAll() so a
// rebind shows the real keys; unbound (a conflict cleared it) → we point at the
// toolbar icon instead. Built from nodes (no innerHTML) and pointer-events:none,
// so it can never intercept a page click or need sanitizing.
const HINT_ID = 'peerd-pull-hint';
const HINT_HOLD_MS = 2600;        // how long the fully-typed line lingers
const HINT_IN_PER_CHAR = 36;      // type-in pace (ms/char)
const HINT_OUT_PER_CHAR = 18;     // type-out is a touch faster

const removeHint = () => { const h = document.getElementById(HINT_ID); if (h) h.remove(); };

// Build the hint as [clipped text][tracking cursor]. Text is plain (monospace),
// so the stepped width reveal lands one glyph per step. Nodes only (no innerHTML).
/** @param {string} shortcut */
const buildHint = (shortcut) => {
  const text = shortcut
    ? `Press ${shortcut} to pull peerd in`
    : 'Click the peerd toolbar icon to pull it in';
  const hint = document.createElement('div');
  hint.id = HINT_ID;
  hint.className = 'peerd-pull-hint';
  hint.setAttribute('role', 'status');
  const typeEl = document.createElement('span');
  typeEl.className = 'peerd-pull-hint-type';
  typeEl.textContent = text;
  const cursor = document.createElement('span');
  cursor.className = 'peerd-pull-hint-cursor';
  cursor.setAttribute('aria-hidden', 'true');
  hint.append(typeEl, cursor);
  return { hint, typeEl, len: text.length };
};

const showHint = () => {
  if (panelOpen || document.getElementById(HINT_ID)) return;
  /** @param {string} shortcut */
  const mount = (shortcut) => {
    // Re-check: the panel may have opened (or a hint mounted) during the async
    // commands.getAll() round-trip.
    if (panelOpen || document.getElementById(HINT_ID)) return;
    const { hint, typeEl, len } = buildHint(shortcut);
    // Monospace → 1ch per char: the width sizes the stable box AND is the type
    // animation's end width, so each step reveals exactly one glyph.
    hint.style.setProperty('--peerd-hint-w', `${len}ch`);
    const tIn = len * HINT_IN_PER_CHAR;
    const tOut = len * HINT_OUT_PER_CHAR;
    // steps(len) is injected as a literal (CSS steps() won't take a var) — fine,
    // we built the element so we know the count.
    typeEl.style.animation =
      `peerdHintType ${tIn}ms steps(${len}, end) forwards, `
      + `peerdHintUntype ${tOut}ms steps(${len}, end) ${tIn + HINT_HOLD_MS}ms forwards`;
    (document.body || document.documentElement).appendChild(hint);
    setTimeout(() => hint.remove(), tIn + HINT_HOLD_MS + tOut + 250);
  };
  try {
    const p = browser.commands?.getAll?.();
    if (p?.then) p.then((cmds) => mount((cmds ?? []).find((x) => x.name === 'pull-in-peerd')?.shortcut || '')).catch(() => mount(''));
    else mount('');
  } catch { mount(''); }
};

// Ask the SW whether the panel is open right now — seeds the label at mount and
// re-syncs when the tab regains visibility (the panel may have been closed via
// its own X while we were looking elsewhere). Best-effort: if the SW is asleep
// we keep the last known (optimistic) state.
const syncPanelState = () => {
  try {
    browser.runtime.sendMessage({ type: 'surfaces/get' })
      .then((raw) => {
        const r = /** @type {{ sidePanelOpen?: unknown } | null} */ (raw);
        if (r && typeof r.sidePanelOpen === 'boolean') setPanelOpen(r.sidePanelOpen);
      })
      .catch(() => {});
  } catch { /* no runtime */ }
};

// Optimistic toggle: flip the label immediately for snappy feedback, then the
// SW's surfaces/changed push reconciles it once the panel actually opens/closes
// (and corrects us if an open() was dropped).
const onToggleClick = () => {
  if (panelOpen) { closePanel(); setPanelOpen(false); }
  else { openPanel(); setPanelOpen(true); }
};

// Live sync: the SW pushes surfaces/changed on every panel open/close (incl. a
// close triggered from the panel itself), so a docked panel's state stays
// mirrored here with no click. Attached once.
let surfaceListenerAttached = false;
const listenForSurfaceChanges = () => {
  if (surfaceListenerAttached) return;
  try {
    browser.runtime.onMessage.addListener((/** @type {unknown} */ raw) => {
      const msg = /** @type {{ type?: unknown, sidePanelOpen?: unknown } | null} */ (raw);
      if (msg?.type === 'surfaces/changed' && typeof msg.sidePanelOpen === 'boolean') {
        setPanelOpen(msg.sidePanelOpen);
      }
      return false;   // not ours to answer — let other listeners run
    });
    surfaceListenerAttached = true;
  } catch { /* no runtime.onMessage in this context */ }
};

/**
 * Mount the "pull in peerd" toggle onto an engine tab page. Idempotent (a
 * second call returns the existing button) and a no-op where no panel/sidebar
 * API exists. Safe to call early — windowId resolves asynchronously and is
 * ready well before the user can click.
 *
 * @returns {HTMLButtonElement | null} the button, or null if not mounted
 */
export const mountPullInPeerd = () => {
  if (typeof document === 'undefined') return null;
  if (!panelApiAvailable()) return null;
  const existing = document.querySelector('.peerd-pull');
  if (existing) return /** @type {HTMLButtonElement} */ (existing);

  resolveWindowId();
  injectStyles();

  const btn = document.createElement('button');
  btn.className = 'peerd-pull';
  btn.type = 'button';

  const label = document.createElement('span');
  label.className = 'peerd-pull-text';
  const glyph = document.createElement('span');
  glyph.className = 'peerd-pull-glyph';
  glyph.setAttribute('aria-hidden', 'true');

  btn.append(label, brandWordmark(), glyph);
  btn.addEventListener('click', onToggleClick);

  btnEl = btn; labelEl = label; glyphEl = glyph;
  renderToggle();                 // seed the closed-state label
  (document.body || document.documentElement).appendChild(btn);

  listenForSurfaceChanges();      // live updates pushed by the SW
  syncPanelState();               // seed real state (the panel may already be open)
  try {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncPanelState(); });
  } catch { /* no document events */ }

  // Brief, auto-dismissing reminder of the global shortcut — delayed a beat so
  // the button lands first and syncPanelState can settle the real open-state
  // before we decide whether the "pull in" hint is even relevant.
  try { setTimeout(showHint, 600); } catch { /* no timers */ }

  return btn;
};
