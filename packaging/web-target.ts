// web-target.ts — the SINGLE SOURCE OF TRUTH for the `web` packaging target
// (spec: docs/specs/PEERD-WEB-SURFACE.md §6/§10). The web demo IMPORTS real
// extension source rather than carrying hand-vendored copies, so it inherits
// upstream automatically. This file declares exactly WHICH source is staged,
// plus the few web-specific swaps that make an extension tree load on a plain
// page. Change curation here and nowhere else; check-web-boundary.ts then
// proves the staged tree stays import-closed.
//
// why a page needs any divergence at all: three things in the extension tree
// assume the browser-extension platform and would 404/throw at module load on
// a page. Each is a committed-template SWAP (never a text transform): the
// browser-polyfill (no-throw shim) and two tab-group-title constants that
// curated tool defs import from /background/.

import { join } from 'node:path';
import { REPO_ROOT } from './lib.ts';

// Whole module dirs imported verbatim from extension/ — the DI'd core + its deps.
// peerd-distributed is included so the shell's observe-only peer runs from source;
// the AGENT's dweb tools stay off (loader swapped to the stub, DWEB_ENABLED
// false), so the module is present but the agent does not reach it.
export const WEB_INCLUDE_DIRS = [
  'peerd-runtime',
  'peerd-provider',
  'peerd-engine',
  'peerd-egress',
  'peerd-distributed',
  'shared',
  'vendor',
] as const;

// Individual files pulled from otherwise-excluded dirs: the PURE Notebook
// substrate. (The extension's notebook-tab/ page controller is chassis, not
// web-safe, so only these leaf files come across.)
export const WEB_INCLUDE_FILES = [
  'notebook-tab/worker-source.js',
  'notebook-tab/realm-seal.js',
  'notebook-tab/notebook-neutralizers.js',
  'notebook-tab/notebook-std.js',
  'notebook-tab/output-render.js',
] as const;

// Dropped from WITHIN the included dirs.
//   - channel-config.js is generated per flavor (gen-channel-config).
//   - the vendor subdirs below are referenced from staged code ONLY as runtime
//     URL strings (wasmPaths configs etc.), never statically imported — so
//     pruning them keeps the import-closure gate green while cutting ~32 MB
//     off every deploy (62 → ~30 MB). If a future staged file ever imports one
//     statically, check-web-boundary fails loudly and the dir gets re-added
//     here deliberately. vendor/transformers stays: it is the demo's Gemma
//     runtime (dynamically imported by web/gemma-worker.js).
export const WEB_PRUNE_WITHIN = [
  'shared/channel-config.js',
  'vendor/onnxruntime-web',
  'vendor/cheerpx',
  'vendor/vad-web',
  'vendor/pdfjs',
  'vendor/xterm',
  'vendor/tesseract',
  'vendor/simple-icons',
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
// by the polyfill shim (verified by hand 2026-07-05). check-web-boundary FAILS
// on any touch not in this list — the tscheck-style ratchet: a new touch means
// a new shim-coverage review, then a deliberate entry here.
// Format: '<staged-relative-path>|<trimmed source line>'.
export const KNOWN_BROWSER_TOUCHES = new Set<string>([
  "shared/pull-in-peerd.js|browser.runtime.sendMessage({ type: 'sidepanel/close' })",
  "shared/pull-in-peerd.js|browser.runtime.sendMessage({ type: 'surfaces/get' })",
  'shared/pull-in-peerd.js|browser.runtime.onMessage.addListener((/** @type {unknown} */ raw) => {',
  'shared/peer-notifications.js|browser.runtime?.onMessage?.addListener((/** @type {unknown} */ raw) => {',
  'shared/open-options.js|browser.runtime.openOptionsPage();',
  'shared/open-options.js|browser.tabs.create({',
]);

// The web-specific glue (the shell UI + host adapters). Copied OVER the staged
// modules into web-dist/ so the deploy is one tree: real source + thin shell.
// package-web REFUSES the overlay if any shell path collides with a staged
// file — shadowing real source would silently re-create the vendored-fork
// drift this target exists to kill.
export const WEB_SHELL_DIR = join(REPO_ROOT, 'web', 'public');
export const WEB_DIST = join(REPO_ROOT, 'web-dist');

// Cloudflare Pages rejects files over 25 MiB — a shippability invariant of
// this target, enforced by check-web-boundary (fail >25 MiB, warn near it).
export const PAGES_FILE_LIMIT = 25 * 1024 * 1024;
export const PAGES_FILE_WARN = 23 * 1024 * 1024;
