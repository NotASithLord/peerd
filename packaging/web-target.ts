// web-target.ts — the SINGLE SOURCE OF TRUTH for the `web` packaging target
// (spec: docs/specs/PEERD-WEB-SURFACE.md §6/§10). The web demo IMPORTS real
// extension source rather than carrying hand-vendored copies, so it inherits
// upstream automatically. This file declares exactly WHICH source is staged,
// plus the few web-specific swaps/stubs that make an extension tree load on a
// plain page. Change curation here and nowhere else; check-web-boundary.ts then
// proves the staged tree stays import-closed.
//
// why a page needs any divergence at all: three things in the extension tree
// assume the browser-extension platform and would 404/throw at module load on a
// page. Each is handled below, minimally: the browser-polyfill (swapped for a
// no-throw shim), and two cosmetic tab-group-title constants that curated tool
// defs import from /background/ (stubbed).

import { join } from 'node:path';
import { REPO_ROOT } from './lib.ts';

// Whole module dirs imported verbatim from extension/ — the DI'd core + its deps.
// peerd-distributed is included so the shell's observe-only peer runs from source;
// the AGENT's dweb tools stay off for now (loader swapped to the stub,
// DWEB_ENABLED false), so the module is present but the agent does not reach it.
export const WEB_INCLUDE_DIRS = [
  'peerd-runtime',
  'peerd-provider',
  'peerd-engine',
  'peerd-egress',
  'peerd-distributed',
  'shared',
  'vendor',
] as const;

// The web-specific glue lives here (the shell UI + host adapters). It is copied
// OVER the staged modules into web-dist/ so the deploy is one tree: real source
// modules + thin shell. This dir is authored by hand (it is the only fork point).
export const WEB_SHELL_DIR = join(REPO_ROOT, 'web', 'public');

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

// Dropped from WITHIN the included dirs. channel-config.js is generated (per
// gen-channel-config); .d.ts sidecars are dev-only type tooling; .DS_Store noise.
export const WEB_PRUNE_WITHIN = [
  'shared/channel-config.js',
] as const;

// Web-specific file swaps: extension-relative path -> template in packaging/templates/.
// The path stays identical so every `import ... from '/vendor/browser-polyfill.js'`
// resolves unchanged; only the file's contents differ.
export const WEB_SWAPS: Record<string, string> = {
  'vendor/browser-polyfill.js': 'browser-polyfill.web.js',
};

// The ONLY /background/ references any curated file makes on a page: two cosmetic
// tab-group-title constants. Stubbed (not copied from background/) on purpose —
// if a curated file starts importing anything MORE from /background/,
// check-web-boundary flags the dangling import loudly instead of silently
// dragging chassis code into the web tree.
export const WEB_BACKGROUND_STUBS: Record<string, string> = {
  'background/notebook-client.js':
    '// @ts-nocheck\n'
    + '// web stub (packaging/web-target.ts). peerd-runtime/tools/defs/js-create.js\n'
    + '// imports only this title constant from /background/ on a page.\n'
    + "export const JS_TAB_GROUP_TITLE = 'peerd';\n",
  'background/vm-client.js':
    '// @ts-nocheck\n'
    + '// web stub (packaging/web-target.ts). peerd-runtime/tools/defs/vm-create.js\n'
    + '// imports only this title constant from /background/ on a page.\n'
    + "export const VM_TAB_GROUP_TITLE = 'peerd';\n",
};

export const TEMPLATES_DIR = join(REPO_ROOT, 'packaging', 'templates');
export const WEB_DIST = join(REPO_ROOT, 'web-dist');
