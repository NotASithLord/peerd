// peerd-runtime/dom — framework-state introspection, scripting channel.
//
// The no-CDP counterpart of background/debugger-pool.js's FRAMEWORK_STATE_FN.
// read_state reads the React fiber / Vue internals behind an element — data
// that lives in the page's MAIN world. CDP reaches that world via
// Runtime.callFunctionOn on a resolved node (the debugger-pool path). Without
// CDP (Firefox, store-Chrome, advanced automation off) we reach the same world
// with chrome.scripting.executeScript({ world: 'MAIN' }) — but scripting
// resolves the element by CSS SELECTOR, not by a backendDOMNodeId/ref, and the
// DOM-walk's walkId→element map lives in the ISOLATED world (invisible from
// MAIN). So this channel works off a selector the model supplies.
//
// why a faithful PORT, not a shared import: chrome.scripting serializes the
// `func` it injects with NO access to module scope, so the body must be fully
// self-contained — it cannot import a shared helper. CDP needs the same logic
// as a string operating on `this`. The two injection channels can't share a
// single source, so this is a deliberate near-verbatim copy of debugger-pool's
// FRAMEWORK_STATE_FN (validated live on react.dev), differing ONLY in how the
// element is obtained (document.querySelector here vs `this` there). KEEP THE
// TWO IN SYNC: a fix to the fiber/Vue walk in one must be mirrored in the other.

/**
 * Read the framework component state behind the element matching `selector`.
 * Runs in the page's MAIN world (injected by chrome.scripting). Self-contained,
 * ES5, no closures. Returns { framework, component, props, state } or
 * { framework: null, ... }, or { framework: null, error } when nothing matches.
 *
 * @param {string} selector  CSS selector for the target element
 */
export function readFrameworkStateInjected(selector) {
  'use strict';
  var el;
  try { el = document.querySelector(selector); }
  catch (e) { return { framework: null, error: 'bad_selector: ' + (e && e.message ? e.message : String(e)) }; }
  if (!el) return { framework: null, error: 'no_match: ' + selector };

  function safe(v, d) {
    d = d || 0;
    if (v == null) return v;
    var t = typeof v;
    if (t === 'function') return '<fn>';
    if (t !== 'object') return t === 'string' ? v.slice(0, 80) : v;
    if (d > 2) return '<…>';
    if (Array.isArray(v)) return '[' + v.length + (v.length ? ' items' : '') + ']';
    var o = {}, n = 0;
    for (var k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      if (/^(_owner|_store|ref|key|__|\$\$typeof)/.test(k)) continue;
      if (n++ >= 12) { o['…'] = 1; break; }
      try { o[k] = safe(v[k], d + 1); } catch (e) { o[k] = '<err>'; }
    }
    return o;
  }

  var rk = Object.keys(el).find(function (k) {
    return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0;
  });
  if (rk) {
    var fiber = el[rk], hostProps = null;
    for (var i = 0; i < 40 && fiber; i++) {
      var type = fiber.type;
      if (typeof type === 'function') {
        var isClass = type.prototype && type.prototype.isReactComponent;
        var state;
        if (isClass) {
          state = safe(fiber.memoizedState);
        } else {
          state = []; var h = fiber.memoizedState;
          for (var j = 0; j < 24 && h; j++) {
            var ms = h.memoizedState;
            // skip effect/ref/context hook nodes — keep useState-ish values
            if (ms !== undefined && typeof ms !== 'function' && !(ms && (ms.tag !== undefined || ms.create !== undefined))) {
              state.push(safe(ms));
            }
            h = h.next;
          }
        }
        return { framework: 'react', component: type.displayName || type.name || '(anonymous)', props: safe(fiber.memoizedProps), state: state };
      }
      if (typeof type === 'string' && !hostProps) hostProps = safe(fiber.memoizedProps);
      fiber = fiber.return;
    }
    return { framework: 'react', component: null, props: hostProps, note: 'no component fiber above this node' };
  }
  if (el.__vueParentComponent) {
    var c = el.__vueParentComponent;
    return { framework: 'vue3', component: (c.type && (c.type.name || c.type.__name)) || null, props: safe(c.props), state: safe(c.setupState || c.data) };
  }
  if (el.__vue__) {
    var v = el.__vue__;
    return { framework: 'vue2', component: (v.$options && v.$options.name) || null, props: safe(v.$props), state: safe(v.$data) };
  }
  return { framework: null, note: 'no React/Vue markers on this element' };
}
