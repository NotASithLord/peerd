// peerd-runtime/dom — the "pull peerd in" reminder injected into a REGULAR WEB
// PAGE peerd opens (open_tab). The engine tabs (Notebook/VM/App) carry the real
// pull-in button + their own hint; a third-party page can't, so this is the
// substitute: a small peerd-branded chip that types itself in (like the wordmark)
// telling you to use the keyboard shortcut / toolbar icon.
//
// DESIGN: peerd is "one rainbow accent on monochrome" (CLAUDE.md) — the ONLY
// color carrier is the five-color wordmark (p·cyan e·red e·amber r·green
// d·magenta), here as LETTERFORMS (this is a terminal-ish monospace surface). So
// the chip is grayscale glass, the word "peerd" is the wordmark, and the caret is
// white — matching the wordmark's own manifest intro. The toolbar-icon line shows
// the real favicon set in a subtle button chip.
//
// SECURITY: INFORMATIONAL ONLY — it never messages the service worker (just
// points at the shortcut/icon), so it needs NO content-script-reachable SW route
// and NO new permission (docs/PULL-IN-PEERD-WEB-SCOPE.md).
//
// Serialized by chrome.scripting.executeScript and re-evaluated in the page's
// classic-script world, so it is fully self-contained: 'use strict', ES5, no
// imports — see CLAUDE.md. Styled via element.style (CSSOM survives a strict
// style-src CSP) and built from nodes (no innerHTML → no Trusted-Types sink). The
// favicon rides in as a DATA URL (renders anywhere, no web_accessible_resources),
// with a text fallback if a page's img-src CSP blocks data:.
//
// Lifecycle: type in → linger 15s → type out. Hovering brightens it (more
// contrast) and PAUSES the 15s timer so you can read it; moving the cursor off
// (after a hover) dismisses it immediately — 15s elapsed or not.

/**
 * @param {string} shortcut  the bound "pull in peerd" chord (e.g. "⇧⌘P"), or ''.
 * @param {string} iconUrl   a data: URL for the peerd toolbar icon, or ''.
 */
export function pullInHintInjected(shortcut, iconUrl) {
  'use strict';
  try {
    if (window.top !== window) return;                      // top frame only
    var doc = document;
    if (doc.getElementById('peerd-pull-hint')) return;      // idempotent

    var FG = '#e8edf2', SUB = '#8b95a1';
    // The five wordmark colors (letterform variant), p e e r d.
    var BRAND = [['p', '#22C6F5'], ['e', '#F2555A'], ['e', '#F7A823'], ['r', '#2BD46E'], ['d', '#D957EF']];
    var MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
    var reduce = false;
    try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { /* no matchMedia */ }

    var setStyle = function (el, styles) {
      for (var k in styles) { if (Object.prototype.hasOwnProperty.call(styles, k)) { el.style[k] = styles[k]; } }
    };

    var run = function () {
      var root = doc.body || doc.documentElement;
      if (!root || doc.getElementById('peerd-pull-hint')) return;

      var box = doc.createElement('div');
      box.id = 'peerd-pull-hint';
      box.setAttribute('role', 'status');
      setStyle(box, {
        position: 'fixed', top: '14px', right: '14px', zIndex: '2147483000',
        margin: '0', padding: '10px 13px',
        font: '12px/1.5 ' + MONO, color: FG, textAlign: 'right', whiteSpace: 'nowrap',
        background: 'rgba(20,23,28,0.96)',
        border: '1px solid rgba(255,255,255,0.13)',
        borderRadius: '11px',
        boxShadow: '0 12px 36px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)',
        pointerEvents: 'auto', cursor: 'default', opacity: '0',
        transform: reduce ? 'none' : 'translateY(-4px)',
        transition: reduce ? 'none' : 'opacity .28s ease, transform .28s ease, box-shadow .2s ease, border-color .2s ease, background .2s ease',
        backdropFilter: 'blur(10px) saturate(1.2)', webkitBackdropFilter: 'blur(10px) saturate(1.2)'
      });

      // ---- Line 1: the typewriter line, with "peerd" as the colored wordmark ----
      var text1 = shortcut ? ('Press ' + shortcut + ' to pull peerd in') : 'Pull peerd into this page';
      var len = text1.length;
      var line1 = doc.createElement('div');
      var typeEl = doc.createElement('span');
      setStyle(typeEl, { display: 'inline-block', overflow: 'hidden', whiteSpace: 'nowrap', verticalAlign: 'bottom', width: '0', fontWeight: '600' });
      // Split on "peerd" and render it as the five-color wordmark (letterforms).
      var segs = text1.split('peerd');
      for (var s = 0; s < segs.length; s++) {
        if (segs[s]) { typeEl.appendChild(doc.createTextNode(segs[s])); }
        if (s < segs.length - 1) {
          for (var b = 0; b < BRAND.length; b++) {
            var ch = doc.createElement('span');
            ch.textContent = BRAND[b][0];
            ch.style.color = BRAND[b][1];
            ch.style.fontWeight = '700';
            typeEl.appendChild(ch);
          }
        }
      }
      var cursor = doc.createElement('span');
      setStyle(cursor, { display: 'inline-block', width: '2px', height: '1.05em', marginLeft: '2px', verticalAlign: '-0.15em', background: FG, borderRadius: '1px' });
      line1.appendChild(typeEl);
      line1.appendChild(cursor);
      box.appendChild(line1);

      // ---- Line 2: the favicon (in a subtle button chip) + the click option ----
      var line2 = doc.createElement('div');
      setStyle(line2, { marginTop: '5px', fontSize: '10.5px', color: SUB, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '5px' });
      var lead = doc.createElement('span'); lead.textContent = shortcut ? 'or click' : 'click';
      line2.appendChild(lead);
      var chip = doc.createElement('span');
      setStyle(chip, { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '21px', height: '21px', borderRadius: '6px', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.11)' });
      if (iconUrl) {
        var img = doc.createElement('img');
        img.src = iconUrl; img.alt = 'peerd';
        setStyle(img, { width: '15px', height: '15px', display: 'block', borderRadius: '3px' });
        // If the page's img-src CSP blocks data: URIs, degrade to words.
        img.onerror = function () { chip.textContent = 'peerd'; chip.style.width = 'auto'; chip.style.padding = '1px 5px'; chip.style.color = FG; };
        chip.appendChild(img);
      } else {
        chip.textContent = 'peerd'; chip.style.width = 'auto'; chip.style.padding = '1px 5px'; chip.style.color = FG;
      }
      line2.appendChild(chip);
      var tail = doc.createElement('span'); tail.textContent = shortcut ? 'in your toolbar' : 'in your toolbar ↗';
      line2.appendChild(tail);
      box.appendChild(line2);

      root.appendChild(box);
      window.requestAnimationFrame(function () { box.style.opacity = '1'; box.style.transform = 'translateY(0)'; });

      // Reserve the full text width so the box doesn't resize as line 1 types.
      var full = typeEl.scrollWidth || (len * 7);
      line1.style.width = full + 'px';

      // ---- lifecycle state machine ----
      var phase = 'in', hovered = false, holdTimer = null, typeTimer = null, blink = null, gone = false;

      var remove = function () {
        if (gone) return; gone = true;
        if (blink) { window.clearInterval(blink); }
        if (holdTimer) { window.clearTimeout(holdTimer); }
        if (typeTimer) { window.clearTimeout(typeTimer); }
        box.style.opacity = '0';
        box.style.transform = reduce ? 'none' : 'translateY(-4px)';
        window.setTimeout(function () { if (box.parentNode) { box.parentNode.removeChild(box); } }, 280);
      };
      var startOut = function () {
        if (phase === 'out' || gone) return;
        phase = 'out';
        if (holdTimer) { window.clearTimeout(holdTimer); holdTimer = null; }
        if (typeTimer) { window.clearTimeout(typeTimer); typeTimer = null; }
        if (reduce) { remove(); return; }
        var w = parseInt(typeEl.style.width, 10); if (isNaN(w)) { w = full; }
        var step = Math.max(2, Math.round(full / len));
        var shrink = function () {
          w -= step;
          if (w <= 0) { typeEl.style.width = '0px'; remove(); return; }
          typeEl.style.width = w + 'px';
          typeTimer = window.setTimeout(shrink, 16);
        };
        shrink();
      };
      var glowOn = function () {
        box.style.background = 'rgba(26,30,37,0.99)';
        box.style.borderColor = 'rgba(255,255,255,0.28)';
        box.style.color = '#ffffff';
        box.style.boxShadow = '0 16px 44px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.08)';
        box.style.transform = reduce ? 'none' : 'translateY(-1px)';
      };

      box.addEventListener('mouseenter', function () {
        hovered = true;
        if (holdTimer) { window.clearTimeout(holdTimer); holdTimer = null; }   // pause auto-dismiss while reading
        glowOn();
      });
      box.addEventListener('mouseleave', function () {
        if (!hovered) return;
        hovered = false;
        startOut();   // left after a hover → dismiss now, 15s or not
      });

      if (reduce) {
        typeEl.style.width = full + 'px';
        holdTimer = window.setTimeout(startOut, 15000);
        return;
      }

      blink = window.setInterval(function () { cursor.style.opacity = (cursor.style.opacity === '0') ? '1' : '0'; }, 530);

      var IN_MS = 30, i = 0;
      var typeIn = function () {
        i += 1;
        typeEl.style.width = Math.round(full * (i / len)) + 'px';
        if (i >= len) {
          phase = 'hold';
          // Stay 15 FULL seconds — unless the user is hovering (reading), then
          // wait for them to leave instead.
          if (!hovered) { holdTimer = window.setTimeout(startOut, 15000); }
          return;
        }
        typeTimer = window.setTimeout(typeIn, IN_MS);
      };
      typeTimer = window.setTimeout(typeIn, IN_MS);
    };

    // peerd opens these tabs in the BACKGROUND, so a hint shown on load would be
    // spent before the user ever arrives. Defer until the tab is actually visible.
    if (doc.visibilityState === 'hidden') {
      var onVis = function () {
        if (doc.visibilityState !== 'hidden') { doc.removeEventListener('visibilitychange', onVis); run(); }
      };
      doc.addEventListener('visibilitychange', onVis);
    } else {
      run();
    }
  } catch (e) { /* never break the host page */ }
}
