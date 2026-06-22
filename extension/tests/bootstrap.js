// @ts-check
// Test runner bootstrap (classic script — runs synchronously before any
// ES module). Synthesizes the minimal `globalThis.chrome.runtime.id` the
// webextension-polyfill checks at evaluation time, so the runner works
// when served outside a chrome-extension:// origin (e.g. via
// scripts/dev-server.sh on http://127.0.0.1).
//
// We do NOT stub the real chrome.* APIs — tests touching storage already
// use mocks (tests/mocks/). Code paths that try to call a real chrome.*
// method outside an extension origin will throw a clear
// "x is not a function" rather than silently misbehaving.
//
// When the runner page is opened from chrome-extension://<ext-id>/tests/runner.html
// (the canonical V1 path), chrome.runtime.id is already set and this is
// a no-op.
'use strict';
// Classic-script context — ES modules are strict by default and need
// no directive, but this file is loaded as a non-module <script> in
// runner.html so we opt in explicitly.

(function bootstrap() {
  if (globalThis.chrome?.runtime?.id) return;
  // why: the runner synthesizes only the two fields the polyfill probes
  // at evaluation time — a deliberately partial stand-in for the fully
  // typed `chrome` namespace, cast to it so the rest of the harness sees
  // the production shape.
  globalThis.chrome = /** @type {typeof chrome} */ (globalThis.chrome || {});
  globalThis.chrome.runtime = /** @type {typeof chrome.runtime} */ (
    globalThis.chrome.runtime || {}
  );
  // `runtime.id` is declared read-only by @types/chrome; the runner owns
  // this global, so assign through a writable view of the same object.
  /** @type {{ id: string }} */ (globalThis.chrome.runtime).id = 'peerd-test-runner';
  // Same evaluation-time class as runtime.id, not a behavioral stub:
  // background/vm-tab-tracker.js computes its tab-URL prefix via
  // browser.runtime.getURL at module top, so merely IMPORTING it under
  // the http harness needs this sync string mapping. Behavior still
  // goes through injected deps / tests/mocks.
  globalThis.chrome.runtime.getURL = function getURL(path) {
    return `chrome-extension://peerd-test-runner/${String(path).replace(/^\//, '')}`;
  };
})();
