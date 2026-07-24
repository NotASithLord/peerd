// web-target.ts — the SINGLE SOURCE OF TRUTH for the `web` packaging target.
// The web tree IMPORTS real extension source rather than carrying
// hand-vendored copies, so it inherits upstream automatically. This file
// declares exactly WHICH source is staged, plus the few web-specific swaps
// that make an extension tree load on a plain page. Change curation here and
// nowhere else; check-web-boundary.ts then proves the staged tree stays
// import-closed.
//
// The target is deliberately LIBRARY-LIKE: the staged modules plus a minimal
// smoke shell (web/public/), no demo UI and no deploy pipeline. The archived
// demo shells live on their preserved branches, not here.
//
// why a page needs any divergence at all: three things in the extension tree
// assume the browser-extension platform and would 404/throw at module load on
// a page. Each is a committed-template SWAP (never a text transform): the
// browser-polyfill (no-throw shim) and two tab-group-title constants that
// curated tool defs import from /background/.

import { join } from 'node:path';
import { REPO_ROOT } from './lib.ts';

// Whole module dirs imported verbatim from extension/ — the DI'd core + its
// deps. peerd-distributed is deliberately ABSENT: nothing staged imports it
// (the dweb boundary), the loader is swapped to the store stub, and excluding
// it makes "no dweb in the web tree" a posture guarantee just like the store
// build's dweb-prune (tests/web/web-posture.test.ts pins this).
export const WEB_INCLUDE_DIRS = [
  'peerd-runtime',
  'peerd-provider',
  'peerd-engine',
  'peerd-egress',
  'shared',
  'vendor',
] as const;

// Individual files pulled from otherwise-excluded dirs: the PURE Notebook
// substrate. (The extension's engine-tabs/notebook-tab/ page controller is
// chassis, not web-safe, so only these leaf files come across.)
export const WEB_INCLUDE_FILES = [
  'engine-tabs/notebook-tab/worker-source.js',
  'engine-tabs/notebook-tab/realm-seal.js',
  'engine-tabs/notebook-tab/notebook-neutralizers.js',
  'engine-tabs/notebook-tab/notebook-std.js',
  'engine-tabs/notebook-tab/output-render.js',
] as const;

// Dropped from WITHIN the included dirs.
//   - channel-config.js is generated per flavor (gen-channel-config).
//   - the vendor subdirs below are referenced from staged code ONLY as runtime
//     URL strings (wasmPaths configs etc.), never statically imported — so
//     pruning them keeps the import-closure gate green while cutting tens of
//     MB off every staged tree. If a future staged file ever imports one
//     statically, check-web-boundary fails loudly and the dir gets re-added
//     here deliberately. (vendor/transformers left with the demo shell — it
//     was only ever the demo's Gemma runtime, never imported by staged code.)
export const WEB_PRUNE_WITHIN = [
  'shared/channel-config.js',
  'vendor/onnxruntime-web',
  'vendor/cheerpx',
  'vendor/vad-web',
  'vendor/pdfjs',
  'vendor/xterm',
  'vendor/tesseract',
  'vendor/simple-icons',
  'vendor/transformers',
] as const;

// Web-specific file swaps: extension-relative path -> committed template in
// packaging/templates/ (the house swap discipline: what ships is exactly what
// is reviewable in the repo; check-web-boundary verifies byte identity).
// The path stays identical so imports resolve unchanged; only contents differ.
export const WEB_SWAPS: Record<string, string> = {
  'vendor/browser-polyfill.js': 'browser-polyfill.web.js',
  'background/notebook-client.js': 'notebook-client.web.js',
  'background/vm-client.js': 'vm-client.web.js',
};

// The swapped STUBS (subset of WEB_SWAPS): paths whose template must stay
// value-identical to the real extension file (package-web verifies each
// `export const NAME = ...` in the template against the real source at build
// time) and whose importers may only use names the template actually exports
// (check-web-boundary verifies).
export const WEB_STUB_PATHS = [
  'background/notebook-client.js',
  'background/vm-client.js',
] as const;

// Known module-scope browser./chrome. touches in the staged tree, all covered
// by the polyfill shim (re-verified by hand 2026-07-24). check-web-boundary
// FAILS on any touch not in this list — the tscheck-style ratchet: a new touch
// means a new shim-coverage review, then a deliberate entry here.
// Format: '<staged-relative-path>|<trimmed source line>'.
export const KNOWN_BROWSER_TOUCHES = new Set<string>([
  "shared/pull-in-peerd.js|browser.runtime.sendMessage({ type: 'sidepanel/close' })",
  "shared/pull-in-peerd.js|browser.runtime.sendMessage({ type: 'surfaces/get' })",
  'shared/pull-in-peerd.js|browser.runtime.onMessage.addListener((/** @type {unknown} */ raw) => {',
  'shared/peer-notifications.js|browser.runtime?.onMessage?.addListener((/** @type {unknown} */ raw) => {',
  'shared/open-options.js|browser.runtime.openOptionsPage();',
  'shared/open-options.js|browser.tabs.create({',
]);

// The web shell: a MINIMAL smoke page + the build-stamped service worker.
// Copied OVER the staged modules into web-dist/ so the output is one tree.
// package-web REFUSES the overlay if any shell path collides with a staged
// file — shadowing real source would silently re-create the vendored-fork
// drift this target exists to kill.
export const WEB_SHELL_DIR = join(REPO_ROOT, 'web', 'public');
export const WEB_DIST = join(REPO_ROOT, 'web-dist');

// Static hosts commonly reject huge files (Cloudflare Pages caps uploads at
// 25 MiB) — a shippability invariant of this target, enforced by
// check-web-boundary (fail >25 MiB, warn near it).
export const PAGES_FILE_LIMIT = 25 * 1024 * 1024;
export const PAGES_FILE_WARN = 23 * 1024 * 1024;
