// peerd-runtime/dom — DESIGN-19 Tap B: the MAIN-world fetch/XHR tap.
//
// The no-CDP counterpart of debugger-pool.js's Network capture (Tap A). It records
// the page's OWN API calls by wrapping window.fetch + XMLHttpRequest in the page's
// MAIN world (injected by chrome.scripting.executeScript({ world: 'MAIN' })). This
// is what makes site-client capture ship on store-Chrome AND Firefox with NO new
// permission — it rides `scripting` + `<all_urls>`, exactly like the DOM-walk
// fallback. CDP (Tap A) is the higher-fidelity upgrade where `debugger` ships.
//
// why injected + ES5 + self-contained: chrome.scripting serializes the `func` with
// NO module scope, and it re-evaluates in the page's classic-script world, so the
// body carries its own 'use strict' and cannot import a helper (same rules as
// walk-injected.js / framework-state.js — exempt from the modernization lint).
//
// CREDENTIALS ARE NEVER CAPTURED. The tap records method + URL + a posture MARKER
// (bearer/cookie presence — never the value) + status + content-type + a size-
// capped response-body SHAPE (cloned, never consuming the page's stream). Raw
// leaf values are reduced to types before the ring buffer sees them. The pure
// digester repeats the redaction as defense in depth.
//
// Two entry points, both injected:
//   installFetchTapInjected()  — wraps fetch/XHR, starts a page-side ring buffer
//   drainFetchTapInjected()    — returns + clears the buffer, restores originals

/**
 * Install the fetch/XHR tap in the page's MAIN world. Idempotent (a second call
 * while active is a no-op). Stashes a ring buffer + the originals on a well-known
 * global so drain can recover them across separate executeScript calls.
 * @param {string[]} [allowedOrigins]
 */
export function installFetchTapInjected(allowedOrigins) {
  'use strict';
  try {
    var KEY = '__peerd_fetch_tap__';
    if (window[KEY] && window[KEY].active) return { ok: true, already: true };
    var CAP = 300;                 // ring-buffer cap — bound page memory
    var SAMPLE = 4000;             // response-body sample cap (chars)
    var buf = [];
    var push = function (entry) { if (buf.length < CAP) buf.push(entry); };
    var allowed = Array.isArray(allowedOrigins)
      ? allowedOrigins.filter(function (value) { return typeof value === 'string'; })
      : [];
    // Check scope before cloning or reading any response. This is both the
    // private-network fence and the general third-party data-minimization wall.
    var canSample = function (url) {
      try { return allowed.indexOf(new URL(url, location.href).origin) !== -1; }
      catch (e) { return false; }
    };
    var posture = function (headers) {
      // headers: a plain object OR a Headers instance OR undefined. Return ONLY
      // a presence marker, never a value.
      var out = {};
      try {
        var get = function (name) {
          if (!headers) return null;
          if (typeof headers.get === 'function') return headers.get(name);
          for (var k in headers) { if (k.toLowerCase() === name) return headers[k]; }
          return null;
        };
        var auth = get('authorization');
        if (auth) out.authorization = /bearer/i.test(String(auth)) ? 'Bearer' : 'present';
        // page JS can't read document.cookie via fetch headers, but same-origin
        // credentialed requests DO send the cookie jar — mark session presence.
        if (document.cookie) out.cookie = 'present';
      } catch (e) { /* posture best-effort */ }
      return out;
    };
    var secretKey = /(token|secret|password|passwd|api[-_]?key|auth|session|csrf|xsrf|bearer|access[-_]?token|refresh[-_]?token|sig|signature|\bs?sid\b)/i;
    var shape = function (value, depth) {
      if (value === null) return 'null';
      if (value === undefined) return 'undefined';
      var kind = typeof value;
      if (kind === 'string') return 'string';
      if (kind === 'number' || kind === 'boolean') return kind;
      if (kind !== 'object') return kind;
      if (depth > 3) return '…';
      if (Array.isArray(value)) return value.length ? [shape(value[0], depth + 1), '…×' + value.length] : [];
      var out = {}; var count = 0;
      for (var key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (count++ >= 24) { out['…'] = 1; break; }
        out[key] = secretKey.test(key) ? '<redacted>' : shape(value[key], depth + 1);
      }
      return out;
    };
    var sampleJson = function (text, ct) {
      if (!text) return undefined;
      if (!/json|javascript|text/i.test(ct || '')) return undefined;
      try { return shape(JSON.parse(text.slice(0, SAMPLE * 4)), 0); }
      catch (e) { return 'string'; }
    };

    var origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        var url = ''; var method = 'GET'; var headers;
        try {
          url = (typeof input === 'string') ? input : (input && input.url) || '';
          // ABSOLUTIZE against the page URL — the app calls fetch('/api/...') far
          // more often than an absolute URL, and the digester's inScope parses the
          // URL with no base (throws → drops the event). Resolving here is what makes
          // relative-path traffic (the common case) survive the scope filter.
          try { url = new URL(url, location.href).href; } catch (e0) { /* keep raw */ }
          method = (init && init.method) || (input && input.method) || 'GET';
          headers = (init && init.headers) || (input && input.headers);
        } catch (e) { /* record what we can */ }
        var p = origFetch.apply(this, arguments);
        try {
          p.then(function (res) {
            try {
              if (!canSample(url)) return;
              var ct = res.headers && res.headers.get ? res.headers.get('content-type') : '';
              var entry = { method: String(method).toUpperCase(), url: String(url), status: res.status, contentType: ct, reqHeaders: posture(headers) };
              // clone so we never consume the page's own body stream
              res.clone().text().then(function (t) { entry.resSample = sampleJson(t, ct); push(entry); }).catch(function () { push(entry); });
            } catch (e2) { /* skip */ }
          }).catch(function () { /* network error — not an endpoint we can shape */ });
        } catch (e) { /* skip */ }
        return p;
      };
      window.fetch.__peerdWrapped = true;
    }

    var XHR = window.XMLHttpRequest;
    var origOpen = XHR && XHR.prototype && XHR.prototype.open;
    var origSend = XHR && XHR.prototype && XHR.prototype.send;
    if (origOpen && origSend) {
      XHR.prototype.open = function (m, u) {
        try {
          var abs = String(u || '');
          try { abs = new URL(abs, location.href).href; } catch (e0) { /* keep raw */ }
          this.__peerd = { method: String(m || 'GET').toUpperCase(), url: abs };
        } catch (e) { /* skip */ }
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        var self = this;
        try {
          this.addEventListener('load', function () {
            try {
              if (!self.__peerd) return;
              if (!canSample(self.__peerd.url)) return;
              var ct = '';
              try { ct = self.getResponseHeader('content-type') || ''; } catch (e) { /* skip */ }
              var text = '';
              try { text = (self.responseType === '' || self.responseType === 'text') ? String(self.responseText || '') : ''; } catch (e) { /* skip */ }
              push({ method: self.__peerd.method, url: self.__peerd.url, status: self.status, contentType: ct, reqHeaders: posture(null), resSample: sampleJson(text, ct) });
            } catch (e2) { /* skip */ }
          });
        } catch (e) { /* skip */ }
        return origSend.apply(this, arguments);
      };
    }

    window[KEY] = { active: true, buf: buf, origFetch: origFetch, origOpen: origOpen, origSend: origSend };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * Drain the tap: return the recorded events, clear the buffer, and restore the
 * original fetch/XHR. Runs in the MAIN world (separate executeScript call).
 */
export function drainFetchTapInjected() {
  'use strict';
  try {
    var KEY = '__peerd_fetch_tap__';
    var state = window[KEY];
    if (!state || !state.active) return { ok: true, events: [] };
    var events = state.buf.slice(0);
    // Restore originals so the page runs clean once capture ends.
    try { if (state.origFetch) window.fetch = state.origFetch; } catch (e) { /* skip */ }
    try {
      if (state.origOpen) window.XMLHttpRequest.prototype.open = state.origOpen;
      if (state.origSend) window.XMLHttpRequest.prototype.send = state.origSend;
    } catch (e) { /* skip */ }
    state.active = false;
    try { delete window[KEY]; } catch (e) { window[KEY] = null; }
    return { ok: true, events: events };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), events: [] };
  }
}
