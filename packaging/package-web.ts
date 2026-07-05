// package-web.ts — build the `web` target: a curated, page-loadable tree
// stage-copied FRESH from live extension/ source on every run, so the demo
// inherits upstream changes with no hand-vendored snapshots. Output: web-dist/.
//
//   bun run package:web       then       bun run check:web
//
// Mirrors the stage model of packaging/package.ts, web-flavored:
//   1. stage the curated INCLUDE dirs + files from extension/ into web-dist/
//   2. swap the browser-polyfill for the no-throw page shim (WEB_SWAPS)
//   3. write the tiny /background/ constant stubs the curated tool defs need
//   4. generate shared/channel-config.js (store flavor: DWEB_ENABLED false, no
//      dweb keys) and swap the dweb-loader stub — dweb is deferred in the web target
//
// This stages the CORE (the imported real source). The web SHELL (web/ glue +
// index.html) is layered on top separately; check-web-boundary proves the core
// tree is import-closed before the shell is wired to it.

import { cpSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import { REPO_ROOT, EXTENSION_DIR } from './lib.ts';
import { genChannelConfigSource } from './gen-channel-config.ts';
import {
  WEB_INCLUDE_DIRS, WEB_INCLUDE_FILES, WEB_PRUNE_WITHIN, WEB_SWAPS,
  WEB_BACKGROUND_STUBS, TEMPLATES_DIR, WEB_DIST, WEB_SHELL_DIR,
} from './web-target.ts';

const STORE_LOADER_TEMPLATE = join(REPO_ROOT, 'packaging', 'templates', 'dweb-loader.store.js');

const isPruned = (rel: string): boolean =>
  basename(rel) === '.DS_Store'
  || rel.endsWith('.d.ts')
  || WEB_PRUNE_WITHIN.some((p) => rel === p || rel.startsWith(p + '/'))
  // swapped files are written from templates, not copied from source
  || Object.prototype.hasOwnProperty.call(WEB_SWAPS, rel);

const stageDir = (dir: string): void => {
  cpSync(join(EXTENSION_DIR, dir), join(WEB_DIST, dir), {
    recursive: true,
    filter: (src) => {
      const rel = relative(EXTENSION_DIR, src);
      return rel === '' || !isPruned(rel);
    },
  });
};

export const buildWebTarget = (): void => {
  rmSync(WEB_DIST, { recursive: true, force: true });
  mkdirSync(WEB_DIST, { recursive: true });

  for (const dir of WEB_INCLUDE_DIRS) stageDir(dir);

  for (const file of WEB_INCLUDE_FILES) {
    const dst = join(WEB_DIST, file);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(EXTENSION_DIR, file), dst);
  }

  for (const [rel, template] of Object.entries(WEB_SWAPS)) {
    const dst = join(WEB_DIST, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(TEMPLATES_DIR, template), dst);
  }

  for (const [rel, body] of Object.entries(WEB_BACKGROUND_STUBS)) {
    const dst = join(WEB_DIST, rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, body);
  }

  // Generated + swapped channel files. Store flavor = DWEB_ENABLED false and no
  // dweb keys: the AGENT does not reach dweb (loader stubbed). The shell's peer
  // tab uses peerd-distributed DIRECTLY, independent of this gate.
  writeFileSync(join(WEB_DIST, 'shared', 'channel-config.js'), genChannelConfigSource('store'));
  copyFileSync(STORE_LOADER_TEMPLATE, join(WEB_DIST, 'shared', 'dweb-loader.js'));

  // Overlay the hand-authored shell (UI + host adapters) ON TOP of the staged
  // modules, so web-dist/ is one deployable tree: real source + thin glue.
  cpSync(WEB_SHELL_DIR, WEB_DIST, { recursive: true });

  console.log(`web target staged -> ${relative(REPO_ROOT, WEB_DIST)}/ (real source + web/ shell)`);
};

if (import.meta.main) buildWebTarget();
